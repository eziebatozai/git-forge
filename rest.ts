// rest.ts — GitHub REST v3 API surface for the forge.
//
// Routes live under /api/v3. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors are {"message": "<non-empty string>"}.
// Auth (checkAuth) is required on every route except GET /api/v3/.
// Any {owner} != VIEWER.login ("adaiversen") is a 404, never a 403.
//
// Shared helpers (sendJson, jsonError, readJsonBody, mergePullRequest) are
// exported for graphql.ts / mcp.ts to reuse.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkAuth, VIEWER, type Issue, type Pull, type Repo, type Store } from './store.ts';
import {
  commitPathChange,
  countLineDiff,
  diffTrees,
  flattenTree,
  getObject,
  makeCommit,
  parseCommit,
  parseTree,
  putObject,
} from './gitobj.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const AUTHOR_LINE = 'ada iversen <adaiversen@example.invalid>';

/** Store bound by the most recent handler entry; sendJson falls back to it. */
let activeStore: Store | null = null;
let fallbackReq = 0;

export function setActiveStore(store: Store): void {
  activeStore = store;
}

function requestId(store?: Store): string {
  if (store) return store.nextRequestId();
  if (activeStore) return activeStore.nextRequestId();
  fallbackReq += 1;
  return `req-local-${fallbackReq}`;
}

/** Answer with a JSON body. `headers` go beside the JSON ones. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  store?: Store,
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(store),
    ...headers,
  });
  res.end(text);
}

/** Answer with a JSON error body {"message": ...}. */
export function jsonError(res: ServerResponse, status: number, message: string, store?: Store): void {
  sendJson(res, status, { message: message === '' ? 'Error' : message }, {}, store);
}

/** Answer with an empty body (e.g. 204), still carrying X-GitHub-Request-Id. */
function sendEmpty(res: ServerResponse, status: number, store?: Store): void {
  res.writeHead(status, { 'x-github-request-id': requestId(store) });
  res.end();
}

/** Read and parse a JSON request body. Empty body counts as {} (ok).
 *  Malformed JSON -> {ok:false}. */
export async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: any } | { ok: false }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Alias kept for the name DESIGN.md mentions. */
export const readBody = readJsonBody;

// ---- shape helpers ----

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

function isoAt(store: Store, seq: number): string {
  return new Date((store.baseEpochSec + seq) * 1000).toISOString();
}

function repoJson(repo: Repo, req: IncomingMessage, store: Store): Record<string, unknown> {
  const origin = originOf(req);
  const ts = isoAt(store, repo.createdSeq);
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: ts,
    updated_at: ts,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    clone_url: `${origin}/${repo.owner}/${repo.name}.git`,
    git_url: `git://${req.headers.host ?? 'localhost'}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${req.headers.host ?? 'localhost'}:${repo.owner}/${repo.name}.git`,
    homepage: '',
    language: null,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    topics: [],
  };
}

function issueJson(repo: Repo, issue: Issue, req: IncomingMessage, store: Store): Record<string, unknown> {
  const origin = originOf(req);
  const ts = isoAt(store, issue.createdSeq);
  return {
    id: repo.id * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login },
    created_at: ts,
    updated_at: ts,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: (repo.comments.get(issue.number) ?? []).length,
  };
}

function pullJson(repo: Repo, pull: Pull, req: IncomingMessage, store: Store): Record<string, unknown> {
  const origin = originOf(req);
  const ts = isoAt(store, pull.createdSeq);
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? '';
  return {
    id: repo.id * 100000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: headSha, label: `${VIEWER.login}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${VIEWER.login}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    user: { login: VIEWER.login },
    created_at: ts,
    updated_at: ts,
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ---- pagination ----

function pageParams(url: URL): { perPage: number; page: number } {
  const pp = Number(url.searchParams.get('per_page') ?? '30');
  const pg = Number(url.searchParams.get('page') ?? '1');
  return {
    perPage: Number.isFinite(pp) && pp > 0 ? Math.min(Math.floor(pp), 100) : 30,
    page: Number.isFinite(pg) && pg > 0 ? Math.floor(pg) : 1,
  };
}

function paginate<T>(items: T[], perPage: number, page: number): { items: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), hasNext: start + perPage < items.length };
}

function nextLinkHeader(req: IncomingMessage, url: URL, perPage: number, page: number, hasNext: boolean): Record<string, string> {
  if (!hasNext) return {};
  return { link: `<${originOf(req)}${url.pathname}?per_page=${perPage}&page=${page + 1}>; rel="next"` };
}

// ---- git helpers ----

function treeOfCommit(repo: Repo, oid: string | null): string | null {
  if (!oid) return null;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

function tipTree(repo: Repo, branch: string): string | null {
  return treeOfCommit(repo, repo.refs.get(`refs/heads/${branch}`) ?? null);
}

/** Walk a tree to the node at `parts`; returns {oid, mode} or null. */
function lookupPath(repo: Repo, treeOid: string, parts: string[]): { oid: string; mode: string } | null {
  let cur = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    cur = entry.oid;
  }
  return null;
}

interface CommitListEntry {
  sha: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string; date: string };
  };
  author: { login: string };
  committer: { login: string };
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const m = /^(.+?) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
  if (!m) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
}

function walkCommits(repo: Repo, tip: string): CommitListEntry[] {
  const out: CommitListEntry[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    out.push({
      sha: oid,
      commit: {
        message: c.message,
        author: parseIdent(c.author),
        committer: parseIdent(c.committer),
      },
      author: { login: VIEWER.login },
      committer: { login: VIEWER.login },
    });
    for (let i = c.parents.length - 1; i >= 0; i -= 1) stack.push(c.parents[i]);
  }
  return out;
}

function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

// ---- squash merge (shared with graphql.ts / mcp.ts) ----

/**
 * Squash-merge pull `n` of `repo` onto its base branch.
 * Unknown PR -> 404; conflicted -> 405; already merged -> 200 (idempotent,
 * stored result); else 200 {sha, merged:true, message}.
 */
export function mergePullRequest(repo: Repo, n: number, store: Store): { status: number; body: any } {
  const pull = repo.pulls.get(n);
  if (!pull) return { status: 404, body: { message: 'Not Found' } };
  const message = `Merge pull request #${n} from ${VIEWER.login}/${pull.head}`;
  if (pull.merged) {
    return { status: 200, body: { sha: pull.mergeSha, merged: true, message } };
  }
  if (pull.state !== 'open') {
    return { status: 405, body: { message: 'Pull request is closed' } };
  }
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? null;
  const headTree = treeOfCommit(repo, headTip ?? null);
  if (!headTip || !headTree) {
    return { status: 405, body: { message: 'Merge conflict' } };
  }
  // Conflict detection: paths changed head-vs-PR-baseSha; conflict when such
  // a path's blob differs between PR-base tree and current base tip tree AND
  // head's blob differs from the current base's blob for that path.
  const prBaseTree = treeOfCommit(repo, pull.baseSha === '' ? null : pull.baseSha);
  const curBaseTree = treeOfCommit(repo, baseTip);
  const prBaseFlat = prBaseTree ? flattenTree(repo, prBaseTree) : new Map<string, { oid: string; mode: string }>();
  const headFlat = flattenTree(repo, headTree);
  const curBaseFlat = curBaseTree ? flattenTree(repo, curBaseTree) : new Map<string, { oid: string; mode: string }>();
  const changed = diffTrees(repo, prBaseTree, headTree);
  for (const change of changed) {
    const prBaseOid = prBaseFlat.get(change.path)?.oid ?? null;
    const curBaseOid = curBaseFlat.get(change.path)?.oid ?? null;
    const headOid = headFlat.get(change.path)?.oid ?? null;
    if (prBaseOid !== curBaseOid && headOid !== curBaseOid) {
      return { status: 405, body: { message: 'Merge conflict' } };
    }
  }
  const epoch = store.nextEpochSec();
  const stamp = `${AUTHOR_LINE} ${epoch} +0000`;
  const commit = makeCommit({ tree: headTree, parents: baseTip ? [baseTip] : [], author: stamp, committer: stamp, message });
  const sha = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeSha = sha;
  pull.mergedAt = store.nowIso();
  return { status: 200, body: { sha, merged: true, message } };
}

// ---- handler ----

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  setActiveStore(store);
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return false;
  }
  const path = url.pathname;
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';

  // GET /api/v3/ — starter behavior, no auth.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
      store,
    );
    return true;
  }

  if (!checkAuth(req)) {
    jsonError(res, 401, 'Requires authentication', store);
    return true;
  }

  const segs = path.split('/').filter((s) => s !== '').map(safeDecode);
  // segs[0] = 'api', segs[1] = 'v3'
  const notFound = (): boolean => {
    jsonError(res, 404, 'Not Found', store);
    return true;
  };

  // GET /api/v3/meta
  if (method === 'GET' && segs.length === 3 && segs[2] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0' }, {}, store);
    return true;
  }

  // GET /api/v3/user
  if (method === 'GET' && segs.length === 3 && segs[2] === 'user') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' }, {}, store);
    return true;
  }

  // /api/v3/user/repos
  if (segs.length === 4 && segs[2] === 'user' && segs[3] === 'repos') {
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) {
        jsonError(res, 400, 'Malformed JSON', store);
        return true;
      }
      const name = typeof body.value.name === 'string' ? body.value.name : '';
      if (name === '') {
        jsonError(res, 422, 'name is required', store);
        return true;
      }
      const repo = store.createRepo(name, {
        description: typeof body.value.description === 'string' ? body.value.description : undefined,
        private: typeof body.value.private === 'boolean' ? body.value.private : undefined,
      });
      if (!repo) {
        jsonError(res, 422, 'already exists', store);
        return true;
      }
      sendJson(res, 201, repoJson(repo, req, store), {}, store);
      return true;
    }
    if (method === 'GET') {
      const { perPage, page } = pageParams(url);
      const all = store.listViewerRepos();
      const { items, hasNext } = paginate(all, perPage, page);
      sendJson(res, 200, items.map((r) => repoJson(r, req, store)), nextLinkHeader(req, url, perPage, page, hasNext), store);
      return true;
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segs.length < 5 || segs[2] !== 'repos') return notFound();
  const owner = segs[3];
  const repoName = segs[4];
  if (owner !== VIEWER.login) return notFound();
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound();
  const rest = segs.slice(5);

  // /api/v3/repos/{o}/{r} itself
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo, req, store), {}, store);
      return true;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      if (!body.ok) {
        jsonError(res, 400, 'Malformed JSON', store);
        return true;
      }
      if (typeof body.value.description === 'string') repo.description = body.value.description;
      if (typeof body.value.private === 'boolean') repo.private = body.value.private;
      sendJson(res, 200, repoJson(repo, req, store), {}, store);
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      sendEmpty(res, 204, store);
      return true;
    }
    return notFound();
  }

  // POST /git/refs
  if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.ok) {
      jsonError(res, 400, 'Malformed JSON', store);
      return true;
    }
    const ref = typeof body.value.ref === 'string' ? body.value.ref : '';
    const sha = typeof body.value.sha === 'string' ? body.value.sha : '';
    if (ref === '' || sha === '') {
      jsonError(res, 422, 'ref and sha are required', store);
      return true;
    }
    if (repo.refs.has(ref)) {
      jsonError(res, 422, 'Reference already exists', store);
      return true;
    }
    if (!repo.objects.has(sha)) {
      jsonError(res, 422, 'Invalid sha', store);
      return true;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha } }, {}, store);
    return true;
  }

  // GET /branches
  if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
    const out: { name: string; commit: { sha: string } }[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    sendJson(res, 200, out, {}, store);
    return true;
  }

  // GET /git/refs/heads/{branch}  (branch may contain slashes)
  if (rest.length >= 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && method === 'GET') {
    const branch = rest.slice(3).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) return notFound();
    sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } }, {}, store);
    return true;
  }

  // GET /branches/{branch}
  if (rest.length >= 2 && rest[0] === 'branches' && method === 'GET') {
    const branch = rest.slice(1).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) return notFound();
    sendJson(res, 200, { name: branch, commit: { sha } }, {}, store);
    return true;
  }

  // GET /commits?sha=
  if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
    const shaParam = url.searchParams.get('sha');
    let tip: string | undefined;
    if (shaParam) {
      tip = repo.refs.get(`refs/heads/${shaParam}`);
      if (!tip) {
        const obj = repo.objects.get(shaParam);
        if (obj && obj.type === 'commit') tip = shaParam;
      }
      if (!tip) return notFound();
    } else {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    if (!tip) {
      sendJson(res, 200, [], {}, store);
      return true;
    }
    sendJson(res, 200, walkCommits(repo, tip), {}, store);
    return true;
  }

  // /contents/{path}
  if (rest.length >= 2 && rest[0] === 'contents') {
    const contentPath = rest.slice(1).join('/');
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      if (!body.ok) {
        jsonError(res, 400, 'Malformed JSON', store);
        return true;
      }
      const branch = typeof body.value.branch === 'string' && body.value.branch !== '' ? body.value.branch : repo.defaultBranch;
      const contentB64 = typeof body.value.content === 'string' ? body.value.content : null;
      if (contentB64 === null) {
        jsonError(res, 422, 'content is required', store);
        return true;
      }
      const message = typeof body.value.message === 'string' && body.value.message !== '' ? body.value.message : `Update ${contentPath}`;
      const bytes = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
      const tree = tipTree(repo, branch);
      const existing = tree ? lookupPath(repo, tree, contentPath.split('/')) : null;
      if (existing && typeof body.value.sha === 'string' && body.value.sha !== existing.oid) {
        jsonError(res, 409, 'sha does not match', store);
        return true;
      }
      const isUpdate = existing !== null;
      const { commitOid, blobOid } = commitPathChange(repo, branch, contentPath, bytes, message, AUTHOR_LINE, store.nextEpochSec());
      sendJson(
        res,
        isUpdate ? 200 : 201,
        {
          content: { name: contentPath.split('/').pop(), path: contentPath, sha: blobOid, size: bytes.length, encoding: 'base64', type: 'file' },
          commit: { sha: commitOid },
        },
        {},
        store,
      );
      return true;
    }
    if (method === 'GET') {
      const refParam = url.searchParams.get('ref');
      let tip: string | undefined;
      if (refParam) {
        tip = repo.refs.get(`refs/heads/${refParam}`);
        if (!tip) {
          const obj = repo.objects.get(refParam);
          if (obj && obj.type === 'commit') tip = refParam;
        }
        if (!tip) return notFound();
      } else {
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      }
      if (!tip) return notFound();
      const tree = treeOfCommit(repo, tip);
      if (!tree) return notFound();
      const parts = contentPath.split('/');
      const node = lookupPath(repo, tree, parts);
      if (!node) return notFound();
      if (node.mode === '40000') {
        const children = parseTree(getObject(repo, node.oid)?.data ?? Buffer.alloc(0));
        const out = children.map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name,
          path: `${contentPath}/${e.name}`,
          sha: e.oid,
        }));
        out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        sendJson(res, 200, out, {}, store);
        return true;
      }
      const blob = getObject(repo, node.oid);
      if (!blob) return notFound();
      sendJson(
        res,
        200,
        {
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
          sha: node.oid,
          size: blob.data.length,
          name: parts[parts.length - 1],
          path: contentPath,
        },
        {},
        store,
      );
      return true;
    }
    if (method === 'DELETE') {
      const body = await readJsonBody(req);
      if (!body.ok) {
        jsonError(res, 400, 'Malformed JSON', store);
        return true;
      }
      const branch = typeof body.value.branch === 'string' && body.value.branch !== '' ? body.value.branch : repo.defaultBranch;
      const message = typeof body.value.message === 'string' && body.value.message !== '' ? body.value.message : `Delete ${contentPath}`;
      const tree = tipTree(repo, branch);
      const existing = tree ? lookupPath(repo, tree, contentPath.split('/')) : null;
      if (!existing) return notFound();
      if (typeof body.value.sha === 'string' && body.value.sha !== existing.oid) {
        jsonError(res, 409, 'sha does not match', store);
        return true;
      }
      const { commitOid } = commitPathChange(repo, branch, contentPath, null, message, AUTHOR_LINE, store.nextEpochSec());
      sendJson(res, 200, { commit: { sha: commitOid } }, {}, store);
      return true;
    }
    return notFound();
  }

  // POST /labels
  if (rest.length === 1 && rest[0] === 'labels' && method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.ok) {
      jsonError(res, 400, 'Malformed JSON', store);
      return true;
    }
    const name = typeof body.value.name === 'string' ? body.value.name : '';
    if (name === '') {
      jsonError(res, 422, 'name is required', store);
      return true;
    }
    const existing = repo.labels.get(name);
    if (existing) {
      sendJson(res, 201, { name: existing.name, color: existing.color }, {}, store);
      return true;
    }
    const color = typeof body.value.color === 'string' && body.value.color !== '' ? body.value.color : 'ededed';
    repo.labels.set(name, { name, color });
    sendJson(res, 201, { name, color }, {}, store);
    return true;
  }

  // /issues
  if (rest.length >= 1 && rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.ok) {
          jsonError(res, 400, 'Malformed JSON', store);
          return true;
        }
        const title = typeof body.value.title === 'string' ? body.value.title : '';
        if (title === '') {
          jsonError(res, 422, 'title is required', store);
          return true;
        }
        const rawLabels = Array.isArray(body.value.labels) ? body.value.labels : [];
        const labels: string[] = [];
        for (const l of rawLabels) {
          const name = typeof l === 'string' ? l : typeof l?.name === 'string' ? l.name : '';
          if (name === '') continue;
          if (!repo.labels.has(name)) {
            jsonError(res, 422, `Label does not exist: ${name}`, store);
            return true;
          }
          labels.push(name);
        }
        const issue: Issue = {
          number: repo.nextIssue,
          title,
          body: typeof body.value.body === 'string' ? body.value.body : '',
          state: 'open',
          labels,
          createdSeq: store.nextSeq(),
        };
        repo.nextIssue += 1;
        repo.issues.set(issue.number, issue);
        sendJson(res, 201, issueJson(repo, issue, req, store), {}, store);
        return true;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const direction = url.searchParams.get('direction') ?? 'desc';
        const { perPage, page } = pageParams(url);
        let all = [...repo.issues.values()];
        if (state !== 'all') all = all.filter((i) => i.state === state);
        all.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        const { items, hasNext } = paginate(all, perPage, page);
        sendJson(res, 200, items.map((i) => issueJson(repo, i, req, store)), nextLinkHeader(req, url, perPage, page, hasNext), store);
        return true;
      }
      return notFound();
    }
    const n = Number(rest[1]);
    if (!Number.isInteger(n)) return notFound();
    if (rest.length === 2) {
      const issue = repo.issues.get(n);
      if (!issue) return notFound();
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue, req, store), {}, store);
        return true;
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        if (!body.ok) {
          jsonError(res, 400, 'Malformed JSON', store);
          return true;
        }
        if (typeof body.value.title === 'string') issue.title = body.value.title;
        if (typeof body.value.body === 'string') issue.body = body.value.body;
        if (body.value.state === 'open' || body.value.state === 'closed') issue.state = body.value.state;
        sendJson(res, 200, issueJson(repo, issue, req, store), {}, store);
        return true;
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      const issue = repo.issues.get(n);
      if (!issue) return notFound();
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.ok) {
          jsonError(res, 400, 'Malformed JSON', store);
          return true;
        }
        const commentBody = typeof body.value.body === 'string' ? body.value.body : '';
        if (commentBody === '') {
          jsonError(res, 422, 'body is required', store);
          return true;
        }
        const comment = { id: repo.nextCommentId, body: commentBody, createdSeq: store.nextSeq() };
        repo.nextCommentId += 1;
        const list = repo.comments.get(n) ?? [];
        list.push(comment);
        repo.comments.set(n, list);
        sendJson(res, 201, { id: comment.id, body: comment.body }, {}, store);
        return true;
      }
      if (method === 'GET') {
        const list = repo.comments.get(n) ?? [];
        sendJson(res, 200, list.map((c) => ({ id: c.id, body: c.body })), {}, store);
        return true;
      }
      return notFound();
    }
    return notFound();
  }

  // /pulls
  if (rest.length >= 1 && rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.ok) {
          jsonError(res, 400, 'Malformed JSON', store);
          return true;
        }
        const title = typeof body.value.title === 'string' ? body.value.title : '';
        const head = typeof body.value.head === 'string' ? body.value.head : '';
        const base = typeof body.value.base === 'string' ? body.value.base : '';
        if (title === '') {
          jsonError(res, 422, 'title is required', store);
          return true;
        }
        if (head === '' || base === '') {
          jsonError(res, 422, 'head and base are required', store);
          return true;
        }
        const headTip = repo.refs.get(`refs/heads/${head}`);
        const baseTip = repo.refs.get(`refs/heads/${base}`);
        if (!headTip || !baseTip) {
          jsonError(res, 422, 'head or base branch does not exist', store);
          return true;
        }
        const pull: Pull = {
          number: repo.nextPull,
          title,
          body: typeof body.value.body === 'string' ? body.value.body : '',
          state: 'open',
          head,
          base,
          baseSha: baseTip,
          merged: false,
          mergeSha: null,
          mergedAt: null,
          createdSeq: store.nextSeq(),
        };
        repo.nextPull += 1;
        repo.pulls.set(pull.number, pull);
        sendJson(res, 201, pullJson(repo, pull, req, store), {}, store);
        return true;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let all = [...repo.pulls.values()];
        if (state !== 'all') all = all.filter((p) => p.state === state);
        all.sort((a, b) => b.createdSeq - a.createdSeq);
        sendJson(res, 200, all.map((p) => pullJson(repo, p, req, store)), {}, store);
        return true;
      }
      return notFound();
    }
    const n = Number(rest[1]);
    if (!Number.isInteger(n)) return notFound();
    if (rest.length === 2 && method === 'GET') {
      const pull = repo.pulls.get(n);
      if (!pull) return notFound();
      sendJson(res, 200, pullJson(repo, pull, req, store), {}, store);
      return true;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const pull = repo.pulls.get(n);
      if (!pull) return notFound();
      const baseTree = tipTree(repo, pull.base);
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      const headTree = treeOfCommit(repo, headTip ?? null);
      if (!headTree) return notFound();
      const diffs = diffTrees(repo, baseTree, headTree);
      const out = diffs.map((d) => {
        const oldText = d.oldOid ? (getObject(repo, d.oldOid)?.data.toString('utf8') ?? '') : '';
        const newText = d.newOid ? (getObject(repo, d.newOid)?.data.toString('utf8') ?? '') : '';
        const { additions, deletions } = countLineDiff(oldText, newText);
        return { filename: d.path, status: d.status, additions, deletions, changes: additions + deletions };
      });
      sendJson(res, 200, out, {}, store);
      return true;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const body = await readJsonBody(req);
      if (!body.ok) {
        jsonError(res, 400, 'Malformed JSON', store);
        return true;
      }
      const result = mergePullRequest(repo, n, store);
      sendJson(res, result.status, result.body, {}, store);
      return true;
    }
    return notFound();
  }

  return notFound();
}
