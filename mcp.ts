// mcp.ts — MCP endpoint (POST /mcp), JSON-RPC 2.0, Streamable HTTP.
//
// Modern era: server/discover. Legacy era: initialize +
// notifications/initialized. tools/list (built ONCE at module load, the same
// object serialized every call) and tools/call over the same store as REST.
// merge_pull_request uses rest.ts's mergePullRequest when present, with a
// local fallback implementing the same DESIGN merge logic (rest.ts was not
// present when this module was written; HTTP helpers are local equivalents).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  checkAuth,
  VIEWER,
  type Store,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import { flattenTree, diffTrees, parseCommit, makeCommit, putObject, serializeTree } from './gitobj.ts';

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

function isConflicted(repo: Repo, pull: Pull): boolean {
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
// Object shapes (same store as REST)
// ---------------------------------------------------------------------------

function isoFor(store: Store, seq: number): string {
  return new Date((store.baseEpochSec + seq) * 1000).toISOString();
}

function repoJson(repo: Repo, store: Store): Record<string, unknown> {
  const ts = isoFor(store, repo.createdSeq);
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: ts,
    updated_at: ts,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
  };
}

function issueJson(repo: Repo, issue: Issue, store: Store): Record<string, unknown> {
  const ts = isoFor(store, issue.createdSeq);
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: ts,
    updated_at: ts,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull, store: Store): Record<string, unknown> {
  const ts = isoFor(store, pull.createdSeq);
  return {
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head, sha: branchTip(repo, pull.head) ?? null },
    base: { ref: pull.base, sha: branchTip(repo, pull.base) ?? null },
    merged: pull.merged,
    merge_commit_sha: pull.mergeSha,
    merged_at: pull.mergedAt,
    created_at: ts,
    updated_at: ts,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------
// Tools list — built ONCE at module load; the same object is serialized on
// every tools/list call so the JSON is byte-identical across calls.
// ---------------------------------------------------------------------------

const TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

// ---------------------------------------------------------------------------
// Flexible argument mapping
// ---------------------------------------------------------------------------

function normKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function argMap(args: Record<string, unknown>): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const [k, v] of Object.entries(args)) m.set(normKey(k), v);
  return m;
}

function pick(m: Map<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    const v = m.get(normKey(n));
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

interface ResolvedArgs {
  owner?: string;
  repo?: string;
  title?: string;
  body?: string;
  state?: string;
  head?: string;
  base?: string;
  pullNumber?: number;
  name?: string;
  description?: string;
  isPrivate?: boolean;
}

function resolveArgs(raw: unknown): ResolvedArgs {
  const args = (raw ?? {}) as Record<string, unknown>;
  const m = argMap(args);
  const out: ResolvedArgs = {};
  const fullName = pick(m, 'full_name', 'fullname');
  let fnOwner: string | undefined;
  let fnRepo: string | undefined;
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const parts = fullName.split('/');
    fnOwner = parts[0];
    fnRepo = parts.slice(1).join('/');
  }
  const owner = pick(m, 'owner', 'owner_login', 'org', 'user_login', 'login');
  out.owner = typeof owner === 'string' ? owner : fnOwner;
  const repo = pick(m, 'repo', 'repository', 'repo_name', 'project');
  out.repo = typeof repo === 'string' ? repo : fnRepo;
  const title = pick(m, 'title');
  if (typeof title === 'string') out.title = title;
  const body = pick(m, 'body');
  if (typeof body === 'string') out.body = body;
  const state = pick(m, 'state', 'status');
  if (typeof state === 'string') out.state = state;
  const head = pick(m, 'head', 'head_ref', 'head_branch', 'source', 'from', 'branch');
  if (typeof head === 'string') out.head = head;
  const base = pick(m, 'base', 'base_ref', 'target', 'into');
  if (typeof base === 'string') out.base = base;
  const pn = pick(m, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'index');
  if (typeof pn === 'number') out.pullNumber = pn;
  else if (typeof pn === 'string' && pn.trim() !== '' && Number.isFinite(Number(pn))) out.pullNumber = Number(pn);
  const name = pick(m, 'name');
  if (typeof name === 'string') out.name = name;
  const description = pick(m, 'description');
  if (typeof description === 'string') out.description = description;
  const priv = pick(m, 'private');
  if (typeof priv === 'boolean') out.isPrivate = priv;
  return out;
}

function missingArg(name: string): { isError: true; content: { type: string; text: string }[] } {
  return { isError: true, content: [{ type: 'text', text: `missing required argument: ${name}` }] };
}

function errorResult(message: string): { isError: true; content: { type: string; text: string }[] } {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function okResult(obj: unknown): { content: { type: string; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

function findRepo(store: Store, owner: string | undefined, repo: string | undefined): Repo | undefined {
  if (!owner || !repo) return undefined;
  if (owner !== VIEWER.login) return undefined;
  return store.getRepo(owner, repo);
}

// ---------------------------------------------------------------------------
// tools/call dispatch
// ---------------------------------------------------------------------------

async function callTool(name: string, rawArgs: unknown, store: Store): Promise<{ isError?: true; content: { type: string; text: string }[] }> {
  const a = resolveArgs(rawArgs);
  switch (name) {
    case 'create_repo': {
      if (!a.name) return missingArg('name');
      const repo = store.createRepo(a.name, { description: a.description ?? '', private: a.isPrivate ?? false });
      if (!repo) return errorResult('already exists');
      return okResult(repoJson(repo, store));
    }
    case 'get_repo': {
      if (!a.owner) return missingArg('owner');
      if (!a.repo) return missingArg('repo');
      const repo = findRepo(store, a.owner, a.repo);
      if (!repo) return errorResult('Not Found');
      return okResult(repoJson(repo, store));
    }
    case 'create_issue': {
      if (!a.owner) return missingArg('owner');
      if (!a.repo) return missingArg('repo');
      if (!a.title) return missingArg('title');
      const repo = findRepo(store, a.owner, a.repo);
      if (!repo) return errorResult('Not Found');
      const number = repo.nextIssue;
      repo.nextIssue += 1;
      const issue: Issue = { number, title: a.title, body: a.body ?? '', state: 'open', labels: [], createdSeq: store.nextSeq() };
      repo.issues.set(number, issue);
      return okResult(issueJson(repo, issue, store));
    }
    case 'list_issues': {
      if (!a.owner) return missingArg('owner');
      if (!a.repo) return missingArg('repo');
      const repo = findRepo(store, a.owner, a.repo);
      if (!repo) return errorResult('Not Found');
      const state = (a.state ?? 'open').toLowerCase();
      let arr = [...repo.issues.values()];
      if (state === 'open') arr = arr.filter((i) => i.state === 'open');
      else if (state === 'closed') arr = arr.filter((i) => i.state === 'closed');
      arr.sort((x, y) => x.createdSeq - y.createdSeq || x.number - y.number);
      return okResult(arr.map((i) => issueJson(repo, i, store)));
    }
    case 'create_pull_request': {
      if (!a.owner) return missingArg('owner');
      if (!a.repo) return missingArg('repo');
      if (!a.title) return missingArg('title');
      if (!a.head) return missingArg('head');
      if (!a.base) return missingArg('base');
      const repo = findRepo(store, a.owner, a.repo);
      if (!repo) return errorResult('Not Found');
      const headTip = branchTip(repo, a.head);
      if (!headTip) return errorResult(`Head branch not found: ${a.head}`);
      const baseTip = branchTip(repo, a.base);
      const number = repo.nextPull;
      repo.nextPull += 1;
      const pull: Pull = {
        number,
        title: a.title,
        body: a.body ?? '',
        state: 'open',
        head: a.head,
        base: a.base,
        baseSha: baseTip ?? '',
        merged: false,
        mergeSha: null,
        mergedAt: null,
        createdSeq: store.nextSeq(),
      };
      repo.pulls.set(number, pull);
      return okResult(pullJson(repo, pull, store));
    }
    case 'merge_pull_request': {
      if (!a.owner) return missingArg('owner');
      if (!a.repo) return missingArg('repo');
      if (a.pullNumber === undefined) return missingArg('pull_number');
      const repo = findRepo(store, a.owner, a.repo);
      if (!repo) return errorResult('Not Found');
      const pull = repo.pulls.get(a.pullNumber);
      if (!pull) return errorResult('Pull request not found');
      const res = await mergePull(repo, a.pullNumber, store);
      if (res.status !== 200) {
        return errorResult(typeof res.body.message === 'string' ? res.body.message : 'Merge failed');
      }
      return okResult(res.body);
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/mcp' && path !== '/mcp/') return false;
  if (req.method !== 'POST') {
    sendJson(res, store, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!checkAuth(req)) {
    sendJson(res, store, 401, { message: 'Unauthorized' });
    return true;
  }
  const protoHeader = req.headers['mcp-protocol-version'];
  const protoVersion = typeof protoHeader === 'string' && protoHeader !== '' ? protoHeader : '2026-07-28';
  const extra: Record<string, string> = { 'mcp-protocol-version': protoVersion };

  let raw: string;
  try {
    raw = await readBodyText(req);
  } catch {
    sendJson(res, store, 400, { message: 'Bad Request' }, extra);
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, store, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, extra);
    return true;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const id = (body as { id?: unknown } | null)?.id ?? null;
    sendJson(res, store, 400, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } }, extra);
    return true;
  }
  const msg = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const isNotification = !('id' in msg) || msg.id === undefined;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const id = 'id' in msg ? msg.id : null;

  const ok = (result: unknown, headers: Record<string, string> = {}): void => {
    sendJson(res, store, 200, { jsonrpc: '2.0', id, result }, { ...extra, ...headers });
  };
  const err = (code: number, message: string): void => {
    sendJson(res, store, 200, { jsonrpc: '2.0', id, error: { code, message } }, extra);
  };

  // Notifications carry no id and get no JSON-RPC response: HTTP 202, empty body.
  if (isNotification) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      res.writeHead(202, { 'mcp-protocol-version': protoVersion, 'x-github-request-id': store.nextRequestId() });
      res.end();
      return true;
    }
    res.writeHead(202, { 'mcp-protocol-version': protoVersion, 'x-github-request-id': store.nextRequestId() });
    res.end();
    return true;
  }

  switch (method) {
    case 'server/discover': {
      ok({ supportedVersions: SUPPORTED_VERSIONS, serverInfo: SERVER_INFO, capabilities: { tools: {} } });
      return true;
    }
    case 'initialize': {
      const params = (msg.params ?? {}) as { protocolVersion?: unknown };
      const offered = typeof params.protocolVersion === 'string' && params.protocolVersion !== '' ? params.protocolVersion : '2025-11-25';
      ok(
        { protocolVersion: offered, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
        { 'mcp-session-id': 'sess-1' },
      );
      return true;
    }
    case 'tools/list': {
      ok({ tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      const toolName = typeof params.name === 'string' ? params.name : '';
      if (!TOOLS.some((t) => t.name === toolName)) {
        err(-32602, `Unknown tool: ${toolName}`);
        return true;
      }
      const result = await callTool(toolName, params.arguments ?? {}, store);
      ok(result);
      return true;
    }
    case 'ping': {
      ok({});
      return true;
    }
    default: {
      err(-32601, `Method not found: ${method}`);
      return true;
    }
  }
}
