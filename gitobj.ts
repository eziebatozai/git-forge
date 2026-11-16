// gitobj.ts — pure-Node git object model: hashing, trees, commits, tags,
// packfile read (plain + OFS/REF deltas, thin packs) and write (plain entries).
// Only node:crypto and node:zlib are used. No git binary, no randomness.
import { createHash } from 'node:crypto';
import { deflateSync, createInflate } from 'node:zlib';
import type { GitObject, ObjectType, Repo } from './store.ts';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) throw new Error('corrupt tree: no space');
    const mode = data.subarray(off, sp).toString('utf8');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul === -1) throw new Error('corrupt tree: no NUL');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function makeCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const p of info.parents) lines.push(`parent ${p}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function makeTag(info: TagInfo): Buffer {
  return Buffer.from(`object ${info.object}\ntype ${info.type}\ntag ${info.tag}\ntagger ${info.tagger}\n\n${info.message}`, 'utf8');
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4);
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Full reachable closure (commits, trees, blobs, tags) from the given tips. */
export function reachableObjects(repo: Repo, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** True when anc === desc or anc is reachable from desc via parents. */
export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

/** path -> {oid, mode} for every blob (and subtree) under a tree, recursively. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pre: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = pre === '' ? e.name : `${pre}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Diff two trees (null = empty). Returns path changes. */
export function diffTrees(
  repo: Repo,
  oldTreeOid: string | null,
  newTreeOid: string,
): { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] {
  const oldMap = oldTreeOid ? flattenTree(repo, oldTreeOid) : new Map<string, { oid: string; mode: string }>();
  const newMap = flattenTree(repo, newTreeOid);
  const out: { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] = [];
  for (const [path, n] of newMap) {
    const o = oldMap.get(path);
    if (!o) out.push({ path, status: 'added', oldOid: null, newOid: n.oid });
    else if (o.oid !== n.oid) out.push({ path, status: 'modified', oldOid: o.oid, newOid: n.oid });
  }
  for (const [path, o] of oldMap) {
    if (!newMap.has(path)) out.push({ path, status: 'removed', oldOid: o.oid, newOid: null });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

/** Simple LCS line diff (files in the checks are small). */
export function countLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return { additions: m - lcs, deletions: n - lcs };
}

/** Set (content != null) or delete (content == null) a path in a tree. Returns new tree oid. */
export function setPathInTree(
  repo: Repo,
  treeOid: string | null,
  parts: string[],
  blobOid: string | null,
  mode: string,
): string {
  const entries = treeOid ? parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)) : [];
  const [head, ...rest] = parts;
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    if (blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode, name: head, oid: blobOid };
    } else {
      entries.push({ mode, name: head, oid: blobOid });
    }
  } else {
    const child = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : null;
    if (blobOid === null && child === null) {
      // deleting a path that does not exist: tree unchanged
    } else {
      const newChild = setPathInTree(repo, child, rest, blobOid, mode);
      const childEntries = parseTree(repo.objects.get(newChild)?.data ?? Buffer.alloc(0));
      if (childEntries.length === 0 && blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '40000', name: head, oid: newChild };
      } else {
        entries.push({ mode: '40000', name: head, oid: newChild });
      }
    }
  }
  return putObject(repo, 'tree', serializeTree(entries));
}

/**
 * Create a commit on `branch` that sets/deletes `path`.
 * Returns { commitOid, blobOid } (blobOid null on delete).
 * `epochSec` must be deterministic (caller passes store.nextEpochSec()).
 */
export function commitPathChange(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
  authorLine: string,
  epochSec: number,
): { commitOid: string; blobOid: string | null } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const parentTree = tip ? parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree : null;
  let blobOid: string | null = null;
  if (content !== null) blobOid = putObject(repo, 'blob', content);
  const newTree = setPathInTree(repo, parentTree, path.split('/'), blobOid, '100644');
  const stamp = `${epochSec} +0000`;
  const author = authorLine.includes('<') ? `${authorLine} ${stamp}` : `${authorLine} ${stamp}`;
  const commit = makeCommit({
    tree: newTree,
    parents: tip ? [tip] : [],
    author,
    committer: author,
    message,
  });
  const commitOid = putObject(repo, 'commit', commit);
  repo.refs.set(ref, commitOid);
  return { commitOid, blobOid };
}

// ---- packfile ----

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] & 0x0f;
  let shift = 4;
  let i = off + 1;
  while (buf[i - 1] & 0x80) {
    value |= (buf[i] & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { value, next: i };
}

function inflateExact(buf: Buffer, off: number): Promise<{ data: Buffer; next: number }> {
  return new Promise((resolve, reject) => {
    const inf = createInflate();
    const chunks: Buffer[] = [];
    inf.on('data', (c: Buffer) => chunks.push(c));
    inf.on('error', reject);
    inf.on('end', () => resolve({ data: Buffer.concat(chunks), next: off + (inf as unknown as { bytesRead: number }).bytesRead }));
    inf.end(buf.subarray(off));
  });
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readDeltaVarint = (): number => {
    let v = 0;
    let shift = 0;
    while (true) {
      const b = delta[off];
      off += 1;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readDeltaVarint();
  const tgtSize = readDeltaVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          cpOff |= delta[off] << (i * 8);
          off += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          cpSize |= delta[off] << (i * 8);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      parts.push(delta.subarray(off, off + op));
      total += op;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== tgtSize || total !== tgtSize) throw new Error('delta target size mismatch');
  return out;
}

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface PackEntry {
  type: ObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Parse a packfile. `have` supplies objects for thin packs (oid -> object).
 *  Returns the new objects keyed by oid. Throws on corrupt input. */
export async function readPack(pack: Buffer, have: Map<string, GitObject>): Promise<Map<string, GitObject>> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // trailer check: last 20 bytes must be sha1 of the rest
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  if (sha1Hex(pack.subarray(0, pack.length - 20)) !== trailer) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeNum: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raws: Raw[] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const typeNum = (pack[off] >> 4) & 0x07;
    const sizeInfo = readVarint(pack, off);
    off = sizeInfo.next;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeNum === 6) {
      // OFS_DELTA
      let b = pack[off];
      off += 1;
      let v = b & 0x7f;
      while (b & 0x80) {
        b = pack[off];
        off += 1;
        v = ((v + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - v;
    } else if (typeNum === 7) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = await inflateExact(pack, off);
    if (inflated.data.length !== sizeInfo.value) throw new Error('pack entry size mismatch');
    off = inflated.next;
    raws.push({ offset: start, typeNum, data: inflated.data, baseOffset, baseOid });
  }

  const byOffset = new Map<number, Raw>();
  for (const r of raws) byOffset.set(r.offset, r);
  const resolved = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const memoByOffset = new Map<number, GitObject>();

  const resolveRaw = (r: Raw): GitObject => {
    const memo = memoByOffset.get(r.offset);
    if (memo) return memo;
    let out: GitObject;
    if (r.typeNum >= 1 && r.typeNum <= 4) {
      out = { type: PACK_TYPES[r.typeNum], data: r.data };
    } else {
      if (resolving.has(r.offset)) throw new Error('delta cycle');
      resolving.add(r.offset);
      let base: GitObject;
      if (r.typeNum === 6) {
        const br = byOffset.get(r.baseOffset as number);
        if (!br) throw new Error('ofs-delta base not in pack');
        base = resolveRaw(br);
      } else {
        const oid = r.baseOid as string;
        let found: GitObject | undefined = have.get(oid);
        if (!found) {
          for (const cand of raws) {
            if (cand.offset === r.offset) continue;
            const resolvedCand = resolveRaw(cand);
            if (hashObject(resolvedCand.type, resolvedCand.data) === oid) {
              found = resolvedCand;
              break;
            }
          }
        }
        if (!found) throw new Error(`ref-delta base ${oid} not available`);
        base = found;
      }
      const data = applyDelta(base.data, r.data);
      resolving.delete(r.offset);
      out = { type: base.type, data };
    }
    memoByOffset.set(r.offset, out);
    return out;
  };

  for (const r of raws) {
    const obj = resolveRaw(r);
    resolved.set(hashObject(obj.type, obj.data), obj);
  }
  if (resolved.size !== count) throw new Error('pack object count mismatch');
  return resolved;
}

/** Write a packfile (version 2, plain entries only, no deltas) for the given oids. */
export function writePack(repo: Repo, oids: string[]): Buffer {
  const sorted = [...oids].sort();
  const parts: Buffer[] = [Buffer.from('PACK')];
  const head = Buffer.alloc(8);
  head.writeUInt32BE(2, 0);
  head.writeUInt32BE(sorted.length, 4);
  parts.push(head);
  const typeNums: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const oid of sorted) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    const typeNum = typeNums[obj.type];
    const size = obj.data.length;
    const header: number[] = [];
    let s = size;
    let first = (typeNum << 4) | (s & 0x0f);
    s >>= 4;
    if (s > 0) first |= 0x80;
    header.push(first);
    while (s > 0) {
      let b = s & 0x7f;
      s >>= 7;
      if (s > 0) b |= 0x80;
      header.push(b);
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}
