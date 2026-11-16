// graphql.ts — hand-rolled GraphQL v4 endpoint (POST /api/graphql).
//
// Small recursive-descent parser + executor over the store for exactly the
// document subset the suite sends: queries + mutations, $variables, inline
// args (strings/ints/enums/input objects/lists/null), aliases, fragments
// (`... on Repository`), operation names. No dependencies, erasable TS only.
//
// Shared HTTP helpers live here locally: rest.ts (written in parallel) was
// not present when this module was written, so sendJson/readBody are local
// equivalents with the same contract (application/json + X-GitHub-Request-Id).
// mergePullRequest is resolved from rest.ts via dynamic import when it
// exists, with a local fallback implementing the same DESIGN merge logic.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  checkAuth,
  VIEWER,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  commentGlobalId,
  decodeGlobalId,
  type Store,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import { flattenTree, diffTrees, parseCommit, countLineDiff, makeCommit, putObject, serializeTree } from './gitobj.ts';

// ---------------------------------------------------------------------------
// HTTP plumbing (local equivalents of rest.ts helpers)
// ---------------------------------------------------------------------------

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function sendJson(res: ServerResponse, store: Store, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
    ...extra,
  });
  res.end(text);
}

function readBodyText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Merge (shared with REST): prefer rest.ts, fall back to local implementation
// ---------------------------------------------------------------------------

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function treeOf(repo: Repo, commitOid: string | null): string | null {
  if (!commitOid) return null;
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

function blobText(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  return obj ? obj.data.toString('utf8') : '';
}

/** Same conflict rule as REST merge: a path changed head-vs-PR-baseSha whose
 *  blob differs between PR-base tree and current base tip tree AND whose head
 *  blob differs from the current base blob. */
export function isConflicted(repo: Repo, pull: Pull): boolean {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (!headTip || !baseTip) return false;
  const baseTree = treeOf(repo, pull.baseSha || null);
  const headTree = treeOf(repo, headTip);
  const curBaseTree = treeOf(repo, baseTip);
  if (!headTree || !curBaseTree) return false;
  const changed = diffTrees(repo, baseTree, headTree);
  const oldMap = baseTree ? flattenTree(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
  const curMap = flattenTree(repo, curBaseTree);
  const headMap = flattenTree(repo, headTree);
  for (const c of changed) {
    const oldBlob = oldMap.get(c.path)?.oid ?? null;
    const curBlob = curMap.get(c.path)?.oid ?? null;
    const headBlob = headMap.get(c.path)?.oid ?? null;
    if (curBlob !== oldBlob && headBlob !== curBlob) return true;
  }
  return false;
}

function mergeLocal(repo: Repo, n: number, store: Store): { status: number; body: Record<string, unknown> } {
  const pull = repo.pulls.get(n);
  if (!pull) return { status: 404, body: { message: 'Not Found' } };
  if (pull.merged && pull.mergeSha) {
    return { status: 200, body: { sha: pull.mergeSha, merged: true, message: 'Pull request successfully merged' } };
  }
  if (isConflicted(repo, pull)) return { status: 405, body: { message: 'Merge conflict' } };
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (!headTip) return { status: 405, body: { message: 'Head branch has no commits' } };
  const headTree = treeOf(repo, headTip) ?? putObject(repo, 'tree', serializeTree([]));
  const epoch = store.nextEpochSec();
  const stamp = `${epoch} +0000`;
  const author = `ada iversen <adaiversen@example.invalid> ${stamp}`;
  const commitBuf = makeCommit({
    tree: headTree,
    parents: baseTip ? [baseTip] : [],
    author,
    committer: author,
    message: `Merge pull request #${n} from adaiversen/${pull.head}`,
  });
  const sha = putObject(repo, 'commit', commitBuf);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeSha = sha;
  pull.mergedAt = store.nowIso();
  return { status: 200, body: { sha, merged: true, message: 'Pull request successfully merged' } };
}

let restMergeFn: ((repo: Repo, n: number, store: Store) => Promise<{ status: number; body: Record<string, unknown> }>) | null = null;
let restMergeTried = false;

async function getRestMerge(): Promise<((repo: Repo, n: number, store: Store) => Promise<{ status: number; body: Record<string, unknown> }>) | null> {
  if (restMergeTried) return restMergeFn;
  restMergeTried = true;
  try {
    const mod = (await import('./rest.ts')) as Record<string, unknown>;
    if (typeof mod.mergePullRequest === 'function') {
      restMergeFn = mod.mergePullRequest as (repo: Repo, n: number, store: Store) => Promise<{ status: number; body: Record<string, unknown> }>;
    }
  } catch {
    restMergeFn = null;
  }
  return restMergeFn;
}

async function mergePull(repo: Repo, n: number, store: Store): Promise<{ status: number; body: Record<string, unknown> }> {
  const fn = await getRestMerge();
  if (fn) {
    try {
      const r = await fn(repo, n, store);
      if (r && typeof r === 'object') {
        if (typeof (r as { status?: unknown }).status === 'number' && (r as { body?: unknown }).body !== undefined) {
          return { status: (r as { status: number }).status, body: (r as { body: Record<string, unknown> }).body };
        }
        if (typeof (r as { sha?: unknown }).sha === 'string') {
          return { status: 200, body: r as Record<string, unknown> };
        }
      }
    } catch {
      // fall through to the local implementation (idempotent-safe)
    }
  }
  return mergeLocal(repo, n, store);
}

// ---------------------------------------------------------------------------
// Cursor pagination: base64("cursor:<lastNumber>")
// ---------------------------------------------------------------------------

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function decodeCursor(c: string): number | null {
  try {
    const raw = Buffer.from(c, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(raw);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

function paginate<T>(items: T[], args: Record<string, unknown>, keyFn: (item: T, index: number) => number): { nodes: T[]; pageInfo: PageInfo } {
  let list = items;
  const after = args.after;
  if (typeof after === 'string') {
    const num = decodeCursor(after);
    if (num !== null) {
      const idx = list.findIndex((it, i) => keyFn(it, i) === num);
      if (idx >= 0) list = list.slice(idx + 1);
    }
  }
  const first = args.first;
  let hasNext = false;
  let sliced = list;
  if (typeof first === 'number' && first >= 0) {
    if (list.length > first) {
      hasNext = true;
      sliced = list.slice(0, first);
    }
  }
  const endCursor = sliced.length > 0 ? encodeCursor(keyFn(sliced[sliced.length - 1], items.indexOf(sliced[sliced.length - 1]))) : null;
  const startCursor = sliced.length > 0 ? encodeCursor(keyFn(sliced[0], items.indexOf(sliced[0]))) : null;
  return { nodes: sliced, pageInfo: { hasNextPage: hasNext, endCursor, startCursor } };
}

// ---------------------------------------------------------------------------
// Lexer / parser (recursive descent, GraphQL document subset)
// ---------------------------------------------------------------------------

type TokType = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
interface Tok {
  type: TokType;
  value: string;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < n) {
        const ch = src[j];
        if (ch === '"') break;
        if (ch === '\\') {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === '/') out += '/';
          else if (e === '\\') out += '\\';
          else if (e === '"') out += '"';
          else if (e === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += e;
          j += 2;
          continue;
        }
        out += ch;
        j += 1;
      }
      if (j >= n) throw new Error('Unterminated string');
      toks.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      }
      toks.push({ type: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      toks.push({ type: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      toks.push({ type: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      toks.push({ type: 'punct', value: c });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character: ${c}`);
  }
  toks.push({ type: 'eof', value: '' });
  return toks;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] };

interface OperationNode {
  kind: 'operation';
  op: 'query' | 'mutation' | 'subscription';
  name: string | null;
  vars: { name: string; defaultValue: ValueNode | null }[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

class Parser {
  toks: Tok[];
  pos = 0;

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  peek(): Tok {
    return this.toks[this.pos];
  }

  next(): Tok {
    return this.toks[this.pos++];
  }

  expectPunct(v: string): void {
    const t = this.next();
    if (t.type !== 'punct' || t.value !== v) throw new Error(`Expected '${v}' but got '${t.value}'`);
  }

  expectName(v?: string): string {
    const t = this.next();
    if (t.type !== 'name') throw new Error(`Expected name but got '${t.value}'`);
    if (v !== undefined && t.value !== v) throw new Error(`Expected '${v}' but got '${t.value}'`);
    return t.value;
  }
}

function parseType(p: Parser): void {
  if (p.peek().type === 'punct' && p.peek().value === '[') {
    p.next();
    parseType(p);
    p.expectPunct(']');
  } else {
    p.expectName();
  }
  if (p.peek().type === 'punct' && p.peek().value === '!') p.next();
}

function skipDirectives(p: Parser): void {
  while (p.peek().type === 'punct' && p.peek().value === '@') {
    p.next();
    p.expectName();
    if (p.peek().type === 'punct' && p.peek().value === '(') {
      p.next();
      while (!(p.peek().type === 'punct' && p.peek().value === ')')) {
        p.expectName();
        p.expectPunct(':');
        parseValue(p);
      }
      p.expectPunct(')');
    }
  }
}

function parseValue(p: Parser): ValueNode {
  const t = p.peek();
  if (t.type === 'punct' && t.value === '$') {
    p.next();
    return { kind: 'variable', name: p.expectName() };
  }
  if (t.type === 'punct' && t.value === '[') {
    p.next();
    const values: ValueNode[] = [];
    while (!(p.peek().type === 'punct' && p.peek().value === ']')) values.push(parseValue(p));
    p.expectPunct(']');
    return { kind: 'list', values };
  }
  if (t.type === 'punct' && t.value === '{') {
    p.next();
    const fields: { name: string; value: ValueNode }[] = [];
    while (!(p.peek().type === 'punct' && p.peek().value === '}')) {
      const fn = p.expectName();
      p.expectPunct(':');
      fields.push({ name: fn, value: parseValue(p) });
    }
    p.expectPunct('}');
    return { kind: 'object', fields };
  }
  if (t.type === 'string') {
    p.next();
    return { kind: 'string', value: t.value };
  }
  if (t.type === 'int') {
    p.next();
    return { kind: 'int', value: parseInt(t.value, 10) };
  }
  if (t.type === 'float') {
    p.next();
    return { kind: 'float', value: parseFloat(t.value) };
  }
  if (t.type === 'name') {
    p.next();
    if (t.value === 'true') return { kind: 'boolean', value: true };
    if (t.value === 'false') return { kind: 'boolean', value: false };
    if (t.value === 'null') return { kind: 'null' };
    return { kind: 'enum', value: t.value };
  }
  throw new Error(`Unexpected value token '${t.value}'`);
}

function parseSelectionSet(p: Parser): SelectionNode[] {
  p.expectPunct('{');
  const sels: SelectionNode[] = [];
  while (!(p.peek().type === 'punct' && p.peek().value === '}')) {
    sels.push(parseSelection(p));
  }
  p.expectPunct('}');
  return sels;
}

function parseSelection(p: Parser): SelectionNode {
  const t = p.peek();
  if (t.type === 'punct' && t.value === '...') {
    p.next();
    if (p.peek().type === 'name' && p.peek().value === 'on') {
      p.next();
      const tc = p.expectName();
      skipDirectives(p);
      return { kind: 'inlineFragment', typeCondition: tc, selections: parseSelectionSet(p) };
    }
    if (p.peek().type === 'name') {
      const name = p.next().value;
      skipDirectives(p);
      return { kind: 'fragmentSpread', name };
    }
    skipDirectives(p);
    return { kind: 'inlineFragment', typeCondition: null, selections: parseSelectionSet(p) };
  }
  let name = p.expectName();
  let alias: string | null = null;
  if (p.peek().type === 'punct' && p.peek().value === ':') {
    p.next();
    alias = name;
    name = p.expectName();
  }
  const args: { name: string; value: ValueNode }[] = [];
  if (p.peek().type === 'punct' && p.peek().value === '(') {
    p.next();
    while (!(p.peek().type === 'punct' && p.peek().value === ')')) {
      const an = p.expectName();
      p.expectPunct(':');
      args.push({ name: an, value: parseValue(p) });
    }
    p.expectPunct(')');
  }
  skipDirectives(p);
  let sels: SelectionNode[] | null = null;
  if (p.peek().type === 'punct' && p.peek().value === '{') sels = parseSelectionSet(p);
  return { kind: 'field', name, alias, args, selections: sels };
}

function parseOperation(p: Parser, op: 'query' | 'mutation' | 'subscription', name: string | null): OperationNode {
  const vars: { name: string; defaultValue: ValueNode | null }[] = [];
  if (p.peek().type === 'punct' && p.peek().value === '(') {
    p.next();
    while (!(p.peek().type === 'punct' && p.peek().value === ')')) {
      p.expectPunct('$');
      const vname = p.expectName();
      p.expectPunct(':');
      parseType(p);
      let def: ValueNode | null = null;
      if (p.peek().type === 'punct' && p.peek().value === '=') {
        p.next();
        def = parseValue(p);
      }
      vars.push({ name: vname, defaultValue: def });
    }
    p.expectPunct(')');
  }
  skipDirectives(p);
  return { kind: 'operation', op, name, vars, selections: parseSelectionSet(p) };
}

function parseDocument(src: string): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
  const p = new Parser(tokenize(src));
  const operations: OperationNode[] = [];
  const fragments = new Map<string, FragmentNode>();
  while (p.peek().type !== 'eof') {
    const t = p.peek();
    if (t.type === 'punct' && t.value === '{') {
      operations.push(parseOperation(p, 'query', null));
    } else if (t.type === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      const op = t.value as 'query' | 'mutation' | 'subscription';
      p.next();
      let name: string | null = null;
      if (p.peek().type === 'name') name = p.next().value;
      operations.push(parseOperation(p, op, name));
    } else if (t.type === 'name' && t.value === 'fragment') {
      p.next();
      const name = p.expectName();
      p.expectName('on');
      const tc = p.expectName();
      skipDirectives(p);
      fragments.set(name, { kind: 'fragment', name, typeCondition: tc, selections: parseSelectionSet(p) });
    } else {
      throw new Error(`Unexpected token '${t.value}'`);
    }
  }
  if (operations.length === 0) throw new Error('No operation in document');
  return { operations, fragments };
}

// ---------------------------------------------------------------------------
// Introspection table — fields listed exactly per DESIGN
// ---------------------------------------------------------------------------

interface TypeDef {
  kind: 'OBJECT' | 'ENUM';
  fields?: string[];
  enumValues?: string[];
}

const TYPE_DEFS: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestFile: { kind: 'OBJECT', fields: ['path', 'filename', 'status', 'additions', 'deletions', 'changes'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  Ref: { kind: 'OBJECT', fields: ['name'] },
  Comment: { kind: 'OBJECT', fields: ['id', 'body'] },
  CommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'comment', 'clientMutationId'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'fields', 'enumValues', 'description'] },
  __Field: { kind: 'OBJECT', fields: ['name'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

type GObj = Record<string, unknown>;

interface Ctx {
  store: Store;
  errors: { message: string }[];
  fragments: Map<string, FragmentNode>;
  vars: Record<string, unknown>;
}

function resolveValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return vars[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, vars);
      return out;
    }
  }
}

function resolveArgs(args: { name: string; value: ValueNode }[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = resolveValue(a.value, ctx.vars);
  return out;
}

function userObj(login: string, id: number, name: string, email: string): GObj {
  return { __typename: 'User', login, id, name, email };
}

function repoObj(repo: Repo): GObj {
  return { __typename: 'Repository', _repo: repo };
}

function issueObj(repo: Repo, issue: Issue): GObj {
  return { __typename: 'Issue', _repo: repo, _issue: issue };
}

function pullObj(repo: Repo, pull: Pull): GObj {
  return { __typename: 'PullRequest', _repo: repo, _pull: pull };
}

function commentObj(repo: Repo, comment: { id: number; body: string }): GObj {
  return { __typename: 'Comment', _repo: repo, _globalId: commentGlobalId(repo, comment.id), body: comment.body };
}

function pageInfoObj(pi: PageInfo): GObj {
  return { __typename: 'PageInfo', hasNextPage: pi.hasNextPage, hasPreviousPage: false, startCursor: pi.startCursor, endCursor: pi.endCursor };
}

function typeObj(name: string): GObj {
  const def = TYPE_DEFS[name];
  if (!def) return { __typename: '__Type', _typeName: name, _kind: null, _fields: null, _enumValues: null };
  const fields =
    def.kind === 'OBJECT' && def.fields ? def.fields.map((f) => ({ __typename: '__Field', name: f }) as GObj) : null;
  const enumValues =
    def.kind === 'ENUM' && def.enumValues ? def.enumValues.map((v) => ({ __typename: '__EnumValue', name: v }) as GObj) : null;
  return { __typename: '__Type', _typeName: name, _kind: def.kind, _fields: fields, _enumValues: enumValues };
}

function nodeObj(ctx: Ctx, id: string): GObj | null {
  const dec = decodeGlobalId(id);
  if (!dec) return null;
  const repo = ctx.store.findRepoById(dec.repoId);
  if (!repo) return null;
  if (dec.kind === 'R') return repoObj(repo);
  if (dec.kind === 'I') {
    const iss = repo.issues.get(dec.num);
    return iss ? issueObj(repo, iss) : null;
  }
  if (dec.kind === 'P') {
    const p = repo.pulls.get(dec.num);
    return p ? pullObj(repo, p) : null;
  }
  if (dec.kind === 'C') {
    for (const arr of repo.comments.values()) {
      const c = arr.find((x) => x.id === dec.num);
      if (c) return commentObj(repo, c);
    }
    return null;
  }
  return null;
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): GObj {
  let arr = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s).toLowerCase()));
    arr = arr.filter((i) => want.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const dir = orderBy?.direction ?? 'ASC';
  arr.sort((a, b) => {
    const c = a.createdSeq - b.createdSeq || a.number - b.number;
    return dir === 'DESC' ? -c : c;
  });
  const total = arr.length;
  const { nodes, pageInfo } = paginate(arr, args, (i) => i.number);
  return {
    __typename: 'IssueConnection',
    _nodes: nodes.map((i) => issueObj(repo, i)),
    _edges: nodes.map((i) => ({ __typename: 'IssueEdge', _node: issueObj(repo, i), _cursor: encodeCursor(i.number) }) as GObj),
    _pageInfo: pageInfoObj(pageInfo),
    _total: total,
  };
}

function pullsConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): GObj {
  let arr = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s).toUpperCase()));
    arr = arr.filter((p) => {
      if (want.has('MERGED') && p.merged) return true;
      if (want.has('OPEN') && p.state === 'open' && !p.merged) return true;
      if (want.has('CLOSED') && p.state === 'closed' && !p.merged) return true;
      return false;
    });
  }
  arr.sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number);
  const total = arr.length;
  const { nodes, pageInfo } = paginate(arr, args, (p) => p.number);
  return {
    __typename: 'PullRequestConnection',
    _nodes: nodes.map((p) => pullObj(repo, p)),
    _edges: nodes.map((p) => ({ __typename: 'PullRequestEdge', _node: pullObj(repo, p), _cursor: encodeCursor(p.number) }) as GObj),
    _pageInfo: pageInfoObj(pageInfo),
    _total: total,
  };
}

function filesConnection(ctx: Ctx, repo: Repo, pull: Pull, args: Record<string, unknown>): GObj {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  const headTree = headTip ? treeOf(repo, headTip) : null;
  const baseTree = baseTip ? treeOf(repo, baseTip) : null;
  const diffs = headTree ? diffTrees(repo, baseTree, headTree) : [];
  const all: GObj[] = diffs.map((d) => {
    const oldText = d.oldOid ? blobText(repo, d.oldOid) : '';
    const newText = d.newOid ? blobText(repo, d.newOid) : '';
    const { additions, deletions } = countLineDiff(oldText, newText);
    return {
      __typename: 'PullRequestFile',
      path: d.path,
      filename: d.path,
      status: d.status,
      additions,
      deletions,
      changes: additions + deletions,
    };
  });
  const total = all.length;
  const { nodes, pageInfo } = paginate(all, args, (_f, i) => i);
  return {
    __typename: 'PullRequestFileConnection',
    _nodes: nodes,
    _edges: nodes.map((f, i) => ({ __typename: 'IssueEdge', _node: f, _cursor: encodeCursor(i) }) as GObj),
    _pageInfo: pageInfoObj(pageInfo),
    _total: total,
  };
}

async function resolveField(ctx: Ctx, typeName: string, obj: GObj, field: FieldNode, args: Record<string, unknown>): Promise<unknown> {
  if (field.name === '__typename') return typeName;
  const def = TYPE_DEFS[typeName];
  if (def && def.kind === 'OBJECT' && def.fields && !def.fields.includes(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return undefined;
  }

  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return userObj(VIEWER.login, VIEWER.id, VIEWER.name, VIEWER.email);
      if (field.name === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        if (owner !== VIEWER.login) return null;
        const repo = ctx.store.getRepo(owner, name);
        return repo ? repoObj(repo) : null;
      }
      if (field.name === 'node') {
        const id = args.id;
        return typeof id === 'string' ? nodeObj(ctx, id) : null;
      }
      if (field.name === '__type') {
        const name = args.name;
        return typeObj(typeof name === 'string' ? name : '');
      }
      break;
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const clientMutationId = (input.clientMutationId as string | null) ?? null;
      if (field.name === 'createIssue') {
        const repoId = input.repositoryId;
        const dec = typeof repoId === 'string' ? decodeGlobalId(repoId) : null;
        const repo = dec && dec.kind === 'R' ? ctx.store.findRepoById(dec.repoId) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'Repository not found' });
          return null;
        }
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const labels = Array.isArray(input.labels) ? (input.labels as unknown[]).map((l) => String(l)) : [];
        const number = repo.nextIssue;
        repo.nextIssue += 1;
        const issue: Issue = { number, title, body, state: 'open', labels, createdSeq: ctx.store.nextSeq() };
        repo.issues.set(number, issue);
        return { __typename: 'CreateIssuePayload', _issue: issueObj(repo, issue), _clientMutationId: clientMutationId };
      }
      if (field.name === 'closeIssue') {
        const issueId = input.issueId;
        const dec = typeof issueId === 'string' ? decodeGlobalId(issueId) : null;
        const repo = dec && dec.kind === 'I' ? ctx.store.findRepoById(dec.repoId) : undefined;
        const issue = repo?.issues.get(dec ? dec.num : -1);
        if (!repo || !issue) {
          ctx.errors.push({ message: 'Issue not found' });
          return null;
        }
        issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', _issue: issueObj(repo, issue), _clientMutationId: clientMutationId };
      }
      if (field.name === 'createPullRequest') {
        const repoId = input.repositoryId;
        const dec = typeof repoId === 'string' ? decodeGlobalId(repoId) : null;
        const repo = dec && dec.kind === 'R' ? ctx.store.findRepoById(dec.repoId) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'Repository not found' });
          return null;
        }
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const headTip = branchTip(repo, head);
        if (!headTip) {
          ctx.errors.push({ message: `Head branch not found: ${head}` });
          return null;
        }
        const baseTip = branchTip(repo, base);
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const number = repo.nextPull;
        repo.nextPull += 1;
        const pull: Pull = {
          number,
          title,
          body,
          state: 'open',
          head,
          base,
          baseSha: baseTip ?? '',
          merged: false,
          mergeSha: null,
          mergedAt: null,
          createdSeq: ctx.store.nextSeq(),
        };
        repo.pulls.set(number, pull);
        return { __typename: 'CreatePullRequestPayload', _pull: pullObj(repo, pull), _clientMutationId: clientMutationId };
      }
      if (field.name === 'mergePullRequest') {
        const prId = input.pullRequestId;
        const dec = typeof prId === 'string' ? decodeGlobalId(prId) : null;
        const repo = dec && dec.kind === 'P' ? ctx.store.findRepoById(dec.repoId) : undefined;
        const pull = repo?.pulls.get(dec ? dec.num : -1);
        if (!repo || !pull) {
          ctx.errors.push({ message: 'Pull request not found' });
          return null;
        }
        const res = await mergePull(repo, pull.number, ctx.store);
        if (res.status !== 200) {
          ctx.errors.push({ message: typeof res.body.message === 'string' ? res.body.message : 'Merge failed' });
          return null;
        }
        return { __typename: 'MergePullRequestPayload', _pull: pullObj(repo, pull), _clientMutationId: clientMutationId };
      }
      if (field.name === 'addComment') {
        const subjectId = input.subjectId;
        const dec = typeof subjectId === 'string' ? decodeGlobalId(subjectId) : null;
        const repo = dec && dec.kind === 'I' ? ctx.store.findRepoById(dec.repoId) : undefined;
        const issue = repo?.issues.get(dec ? dec.num : -1);
        if (!repo || !issue) {
          ctx.errors.push({ message: 'Issue not found' });
          return null;
        }
        const body = typeof input.body === 'string' ? input.body : '';
        const id = repo.nextCommentId;
        repo.nextCommentId += 1;
        const comment = { id, body, createdSeq: ctx.store.nextSeq() };
        const arr = repo.comments.get(issue.number) ?? [];
        arr.push(comment);
        repo.comments.set(issue.number, arr);
        const node = commentObj(repo, comment);
        return {
          __typename: 'AddCommentPayload',
          _commentEdge: { __typename: 'CommentEdge', _node: node, _cursor: encodeCursor(id) } as GObj,
          _comment: node,
          _clientMutationId: clientMutationId,
        };
      }
      break;
    }
    case 'Repository': {
      const repo = obj._repo as Repo;
      if (field.name === 'id') return repoGlobalId(repo);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return userObj(repo.owner, repo.owner === VIEWER.login ? VIEWER.id : 0, repo.owner === VIEWER.login ? VIEWER.name : repo.owner, repo.owner === VIEWER.login ? VIEWER.email : '');
      if (field.name === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch } as GObj;
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'issue') {
        const n = args.number;
        if (typeof n !== 'number') return null;
        const iss = repo.issues.get(n);
        return iss ? issueObj(repo, iss) : null;
      }
      if (field.name === 'issues') return issuesConnection(ctx, repo, args);
      if (field.name === 'pullRequest') {
        const n = args.number;
        if (typeof n !== 'number') return null;
        const p = repo.pulls.get(n);
        return p ? pullObj(repo, p) : null;
      }
      if (field.name === 'pullRequests') return pullsConnection(ctx, repo, args);
      break;
    }
    case 'Issue': {
      const repo = obj._repo as Repo;
      const issue = obj._issue as Issue;
      if (field.name === 'id') return issueGlobalId(repo, issue.number);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'body') return issue.body;
      break;
    }
    case 'PullRequest': {
      const repo = obj._repo as Repo;
      const pull = obj._pull as Pull;
      if (field.name === 'id') return pullGlobalId(repo, pull.number);
      if (field.name === 'number') return pull.number;
      if (field.name === 'headRefName') return pull.head;
      if (field.name === 'baseRefName') return pull.base;
      if (field.name === 'mergeable') return isConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'files') return filesConnection(ctx, repo, pull, args);
      break;
    }
    case 'User': {
      if (field.name === 'login' || field.name === 'id' || field.name === 'name' || field.name === 'email') return obj[field.name] ?? null;
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return obj.name ?? null;
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection': {
      if (field.name === 'nodes') return obj._nodes ?? [];
      if (field.name === 'edges') return obj._edges ?? [];
      if (field.name === 'pageInfo') return obj._pageInfo ?? null;
      if (field.name === 'totalCount') return obj._total ?? 0;
      break;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'CommentEdge': {
      if (field.name === 'node') return obj._node ?? null;
      if (field.name === 'cursor') return obj._cursor ?? null;
      break;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return obj.hasNextPage ?? false;
      if (field.name === 'hasPreviousPage') return obj.hasPreviousPage ?? false;
      if (field.name === 'startCursor') return obj.startCursor ?? null;
      if (field.name === 'endCursor') return obj.endCursor ?? null;
      break;
    }
    case '__Type': {
      if (field.name === 'name') return obj._typeName ?? null;
      if (field.name === 'kind') return obj._kind ?? null;
      if (field.name === 'fields') return obj._fields ?? null;
      if (field.name === 'enumValues') return obj._enumValues ?? null;
      if (field.name === 'description') return null;
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return obj.name ?? null;
      break;
    }
    case 'Comment': {
      if (field.name === 'id') return obj._globalId ?? null;
      if (field.name === 'body') return obj.body ?? null;
      break;
    }
    case 'PullRequestFile': {
      if (field.name === 'path' || field.name === 'filename' || field.name === 'status' || field.name === 'additions' || field.name === 'deletions' || field.name === 'changes') return obj[field.name] ?? null;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return obj._issue ?? null;
      if (field.name === 'clientMutationId') return obj._clientMutationId ?? null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return obj._pull ?? null;
      if (field.name === 'clientMutationId') return obj._clientMutationId ?? null;
      break;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return obj._commentEdge ?? null;
      if (field.name === 'comment') return obj._comment ?? null;
      if (field.name === 'clientMutationId') return obj._clientMutationId ?? null;
      break;
    }
    default: {
      // Unknown object type: expose plain properties, record unknown fields.
      if (field.name in obj) return obj[field.name];
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      return undefined;
    }
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
  return undefined;
}

async function materialize(ctx: Ctx, value: unknown, sels: SelectionNode[] | null): Promise<unknown> {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (!sels) return value;
    const arr: unknown[] = [];
    for (const item of value) arr.push(await materialize(ctx, item, sels));
    return arr;
  }
  const obj = value as GObj;
  if (!sels) return obj;
  const t = typeof obj.__typename === 'string' ? (obj.__typename as string) : 'Unknown';
  return executeSelections(ctx, t, obj, sels);
}

async function executeSelections(ctx: Ctx, typeName: string, obj: GObj, sels: SelectionNode[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'fragmentSpread') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) continue;
      if (frag.typeCondition !== typeName) continue;
      Object.assign(out, await executeSelections(ctx, typeName, obj, frag.selections));
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== typeName) continue;
      Object.assign(out, await executeSelections(ctx, typeName, obj, sel.selections));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const args = resolveArgs(sel.args, ctx);
    const raw = await resolveField(ctx, typeName, obj, sel, args);
    if (raw === undefined) continue;
    out[key] = await materialize(ctx, raw, sel.selections);
  }
  return out;
}

async function executeDoc(doc: unknown, store: Store): Promise<Record<string, unknown>> {
  if (!doc || typeof doc !== 'object' || typeof (doc as { query?: unknown }).query !== 'string') {
    return { data: null, errors: [{ message: 'Invalid GraphQL request: expected {query} ' }] };
  }
  const d = doc as { query: string; variables?: Record<string, unknown>; operationName?: string };
  let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    parsed = parseDocument(d.query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  let op = parsed.operations[0];
  if (typeof d.operationName === 'string') {
    const named = parsed.operations.find((o) => o.name === d.operationName);
    if (named) op = named;
  }
  const vars: Record<string, unknown> = {};
  const given = (d.variables ?? {}) as Record<string, unknown>;
  for (const v of op.vars) {
    if (given[v.name] !== undefined) vars[v.name] = given[v.name];
    else if (v.defaultValue) vars[v.name] = resolveValue(v.defaultValue, {});
  }
  for (const [k, val] of Object.entries(given)) {
    if (!(k in vars)) vars[k] = val;
  }
  const ctx: Ctx = { store, errors: [], fragments: parsed.fragments, vars };
  const rootType = op.op === 'mutation' ? 'Mutation' : 'Query';
  const data = await executeSelections(ctx, rootType, { __typename: rootType }, op.selections);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/graphql' && path !== '/api/graphql/') return false;
  if (req.method !== 'POST') {
    sendJson(res, store, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!checkAuth(req)) {
    sendJson(res, store, 401, { message: 'Unauthorized' });
    return true;
  }
  let raw: string;
  try {
    raw = await readBodyText(req);
  } catch {
    sendJson(res, store, 400, { message: 'Bad Request' });
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, store, 400, { message: 'Invalid JSON' });
    return true;
  }
  const isBatch = Array.isArray(body);
  const docs = isBatch ? (body as unknown[]) : [body];
  const results: Record<string, unknown>[] = [];
  for (const doc of docs) results.push(await executeDoc(doc, store));
  sendJson(res, store, 200, isBatch ? results : results[0]);
  return true;
}
