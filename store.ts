// store.ts — in-memory forge store.
//
// Determinism rules (the suite replays trials and compares exports byte for byte):
// - every id / number comes from a counter, never Math.random() / crypto.randomUUID()
// - every timestamp comes from a fixed base epoch + a global sequence counter,
//   never Date.now() / new Date(). The base epoch is MAKEFUN_TRIAL_NOW when set
//   (the trial's opening time), else SCENARIO_EPOCH_SEC.
// - the viewer login is fixed by the suite's own published scenario seed
//   (sdk/conformance/wire.ts: viewer = users[0] = adaiversen, id 1000).

export interface UserInfo {
  login: string;
  id: number;
  name: string;
  email: string;
}

export const VIEWER: UserInfo = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};
export const STRANGER_LOGIN = 'olgabauer';
export const SCENARIO_EPOCH_SEC = 1735689600;

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  /** base branch tip at PR creation time (used for conflict detection). */
  baseSha: string;
  merged: boolean;
  mergeSha: string | null;
  mergedAt: string | null;
  createdSeq: number;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  /** refname (refs/heads/..., refs/tags/...) -> commit/tag oid */
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  nextIssue: number;
  pulls: Map<number, Pull>;
  nextPull: number;
  comments: Map<number, Comment[]>;
  nextCommentId: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** Opaque GraphQL global ids: base64 of a tagged payload. Never the plain id. */
export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`R:${repo.id}`, 'utf8').toString('base64');
}
export function issueGlobalId(repo: Repo, n: number): string {
  return Buffer.from(`I:${repo.id}:${n}`, 'utf8').toString('base64');
}
export function pullGlobalId(repo: Repo, n: number): string {
  return Buffer.from(`P:${repo.id}:${n}`, 'utf8').toString('base64');
}
export function commentGlobalId(repo: Repo, id: number): string {
  return Buffer.from(`C:${repo.id}:${id}`, 'utf8').toString('base64');
}
export function decodeGlobalId(id: string): { kind: string; repoId: number; num: number } | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const m = /^([RIPC]):(\d+)(?::(\d+))?$/.exec(raw);
    if (!m) return null;
    return { kind: m[1], repoId: Number(m[2]), num: m[3] === undefined ? 0 : Number(m[3]) };
  } catch {
    return null;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  /** global creation sequence; drives deterministic timestamps */
  seq = 0;
  /** request counter; drives X-GitHub-Request-Id */
  reqSeq = 0;
  baseEpochSec: number;

  constructor() {
    const now = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = now ? Date.parse(now) / 1000 : Number.NaN;
    this.baseEpochSec = Number.isFinite(parsed) ? Math.floor(parsed) : SCENARIO_EPOCH_SEC;
  }

  /** next sequence number (1-based) */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** deterministic ISO timestamp: base + seq seconds */
  nowIso(): string {
    const s = this.nextSeq();
    return new Date((this.baseEpochSec + s) * 1000).toISOString();
  }

  /** deterministic epoch seconds for git author/committer lines */
  nextEpochSec(): number {
    return this.baseEpochSec + this.nextSeq();
  }

  nextRequestId(): string {
    this.reqSeq += 1;
    return `req-${this.reqSeq}`;
  }

  createRepo(name: string, opts: { description?: string; private?: boolean }): Repo | null {
    const key = repoKey(VIEWER.login, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER.login,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextIssue: 1,
      pulls: new Map(),
      nextPull: 1,
      comments: new Map(),
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER.login) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  findRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) {
      if (repo.id === id) return repo;
    }
    return undefined;
  }
}

export const store = new Store();

/** Bearer token the suite presents. In a trial this is MAKEFUN_SHOP_TOKEN.
 *  When unset (local sdk/run.ts use) any non-empty Bearer token is the viewer. */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

export function checkAuth(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const h = req.headers.authorization;
  const auth = Array.isArray(h) ? h[0] : h;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = expectedToken();
  if (expected === '') return true;
  return token === expected;
}
