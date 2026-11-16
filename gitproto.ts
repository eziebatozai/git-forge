// gitproto.ts — git smart-HTTP surface (protocol v0 + v2) for the forge.
//
// Routes (all Bearer-authenticated; foreign owner or missing repo -> 404):
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /{owner}/{repo}.git/git-upload-pack
//   POST /{owner}/{repo}.git/git-receive-pack
//
// No git binary, no dependencies: pkt-lines, sideband framing, pack
// building/reading all go through gitobj.ts. Malformed request bodies are
// answered 400 and never crash the server.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkAuth, VIEWER, type Repo, type Store } from './store.ts';
import {
  getObject,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  reachableObjects,
  writePack,
} from './gitobj.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';
const MAX_PKT = 65520;
/** Largest pack chunk per sideband pkt-line: 65520 - 4 (length) - 1 (band). */
const SIDEBAND_CHUNK = 65515;
const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

// ---- pkt-line helpers ----

/** One pkt-line: 4 hex length (including the 4) + payload. */
function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  if (len > MAX_PKT) throw new Error('pkt-line too large');
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

type PktKind = 'data' | 'flush' | 'delim' | 'end';

interface ParsedPkt {
  kind: PktKind;
  payload: Buffer;
  next: number;
}

/** Parse one pkt-line at `off`. Throws on malformed/truncated input. */
function parsePkt(buf: Buffer, off: number): ParsedPkt {
  if (off + 4 > buf.length) throw new Error('truncated pkt-line');
  const hex = buf.subarray(off, off + 4).toString('ascii');
  if (hex === '0000') return { kind: 'flush', payload: Buffer.alloc(0), next: off + 4 };
  if (hex === '0001') return { kind: 'delim', payload: Buffer.alloc(0), next: off + 4 };
  if (hex === '0002') return { kind: 'end', payload: Buffer.alloc(0), next: off + 4 };
  const len = parseInt(hex, 16);
  if (!Number.isFinite(len) || len < 4 || len > MAX_PKT) throw new Error('bad pkt-line length');
  if (off + len > buf.length) throw new Error('truncated pkt-line');
  return { kind: 'data', payload: buf.subarray(off + 4, off + len), next: off + len };
}

interface PktLinesResult {
  lines: string[];
  /** Offset just past the terminating flush/end packet, or buf.length. */
  next: number;
  ended: boolean;
}

/** Read pkt-lines until flush/end (0000/0002) or end of buffer. */
function readPktLines(buf: Buffer, start: number): PktLinesResult {
  const lines: string[] = [];
  let off = start;
  while (off < buf.length) {
    const p = parsePkt(buf, off);
    off = p.next;
    if (p.kind === 'flush' || p.kind === 'end') return { lines, next: off, ended: true };
    if (p.kind === 'delim') continue;
    lines.push(p.payload.toString('utf8'));
  }
  return { lines, next: off, ended: false };
}

/** Split pack bytes into sideband pkt-lines on `band` (1 = pack data). */
function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  if (data.length === 0) return out;
  for (let off = 0; off < data.length; off += SIDEBAND_CHUNK) {
    const chunk = data.subarray(off, Math.min(off + SIDEBAND_CHUNK, data.length));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

// ---- HTTP helpers ----

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJsonError(res: ServerResponse, store: Store, status: number, message: string): void {
  const text = `${JSON.stringify({ message })}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isV2(req: IncomingMessage): boolean {
  const h = req.headers['git-protocol'];
  const v = Array.isArray(h) ? h[0] : h;
  return typeof v === 'string' && v.includes('version=2');
}

// ---- ref helpers ----

function sortedRefs(repo: Repo): { ref: string; oid: string }[] {
  const out: { ref: string; oid: string }[] = [];
  for (const [ref, oid] of repo.refs) out.push({ ref, oid });
  out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return out;
}

/** Peel an annotated tag (following tag->tag chains) to its target oid, else null. */
function peelTag(repo: Repo, oid: string): string | null {
  const obj = getObject(repo, oid);
  if (!obj || obj.type !== 'tag') return null;
  let cur = parseTag(obj.data).object;
  const seen = new Set<string>([oid]);
  while (true) {
    const o = getObject(repo, cur);
    if (!o || o.type !== 'tag') return cur;
    if (seen.has(cur)) return null;
    seen.add(cur);
    cur = parseTag(o.data).object;
  }
}

function commitEpoch(repo: Repo, oid: string): number | null {
  const obj = getObject(repo, oid);
  if (!obj || obj.type !== 'commit') return null;
  const m = / (\d+) [+-]\d{4}$/.exec(parseCommit(obj.data).committer);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function addTreeClosure(repo: Repo, treeOid: string, out: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    }
  }
}

function resolveRefOrOid(repo: Repo, s: string): string | null {
  const ref = repo.refs.get(s);
  if (ref !== undefined) return ref;
  if (/^[0-9a-f]{40}$/.test(s)) return s;
  return null;
}

// ---- advertisements ----

const UPLOAD_CAPS =
  'side-band-64k multi_ack_detailed thin-pack ofs-delta symref=HEAD:refs/heads/main agent=forge/1.0 shallow';
const RECEIVE_CAPS =
  'report-status report-status-v2 delete-refs side-band-64k ofs-delta symref=HEAD:refs/heads/main agent=forge/1.0';

/** v0 advertisement: `# service=...`, flush, ref lines (caps on the first). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const mainTip = repo.refs.get('refs/heads/main');
  const lines: string[] = [];
  if (mainTip !== undefined) lines.push(`${mainTip} HEAD`);
  for (const r of sortedRefs(repo)) {
    lines.push(`${r.oid} ${r.ref}`);
    const peeled = peelTag(repo, r.oid);
    if (peeled !== null) lines.push(`${peeled} ${r.ref}^{}`);
  }
  if (lines.length === 0) lines.push(`${ZERO_OID} capabilities^{}`);
  for (let i = 0; i < lines.length; i += 1) {
    parts.push(i === 0 ? pktLine(`${lines[i]}\0${caps}\n`) : pktLine(`${lines[i]}\n`));
  }
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine('agent=forge/1.0\n'),
    pktFlush(),
  ]);
}

// ---- ls-refs (v2) ----

interface LsEntry {
  oid: string | null;
  ref: string;
  symrefTarget?: string;
  peeled?: string;
}

function lsRefsResponse(repo: Repo, rawArgs: string[]): Buffer {
  const args = rawArgs.map((a) => a.trim());
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes: string[] = [];
  for (const a of args) {
    if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
    else if (a.startsWith('ref-prefix=')) prefixes.push(a.slice('ref-prefix='.length));
  }
  const mainTip = repo.refs.get('refs/heads/main');
  const entries: LsEntry[] = [];
  if (mainTip !== undefined) {
    entries.push({ oid: mainTip, ref: 'HEAD', symrefTarget: 'refs/heads/main' });
  } else if (wantUnborn || repo.refs.size === 0) {
    entries.push({ oid: null, ref: 'HEAD', symrefTarget: 'refs/heads/main' });
    entries.push({ oid: null, ref: 'refs/heads/main' });
  }
  for (const r of sortedRefs(repo)) {
    const e: LsEntry = { oid: r.oid, ref: r.ref };
    if (wantPeel) {
      const peeled = peelTag(repo, r.oid);
      if (peeled !== null) e.peeled = peeled;
    }
    entries.push(e);
  }
  const parts: Buffer[] = [];
  for (const e of entries) {
    if (prefixes.length > 0 && !prefixes.some((p) => e.ref.startsWith(p))) continue;
    let line: string;
    if (e.oid === null) {
      line = `unborn ${e.ref}`;
    } else {
      line = `${e.oid} ${e.ref}`;
    }
    if (wantSymrefs && e.symrefTarget !== undefined) line += ` symref-target:${e.symrefTarget}`;
    if (e.peeled !== undefined) line += ` peeled:${e.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---- fetch argument parsing (v0 + v2) ----

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string | null;
  filter: string | null;
  thinPack: boolean;
  ofsDelta: boolean;
  caps: Set<string>;
}

function emptyFetchArgs(): FetchArgs {
  return {
    wants: [],
    haves: [],
    shallowLines: [],
    deepen: null,
    deepenSince: null,
    deepenNot: null,
    filter: null,
    thinPack: false,
    ofsDelta: false,
    caps: new Set<string>(),
  };
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const out = emptyFetchArgs();
  for (const raw of lines) {
    let line = raw.replace(/\n$/, '').replace(/\r$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      for (const c of line.slice(nul + 1).split(' ')) if (c !== '') out.caps.add(c);
      line = line.slice(0, nul);
    }
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim().split(/\s+/);
      if (rest[0] !== '') out.wants.push(rest[0]);
      for (const c of rest.slice(1)) out.caps.add(c);
    } else if (line.startsWith('have ')) {
      out.haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      out.shallowLines.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) out.deepen = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = parseInt(line.slice(13).trim(), 10);
      if (Number.isFinite(n)) out.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) {
      out.deepenNot = line.slice(11).trim();
    } else if (line.startsWith('filter ')) {
      out.filter = line.slice(7).trim();
    } else if (line === 'thin-pack') {
      out.thinPack = true;
    } else if (line === 'ofs-delta') {
      out.ofsDelta = true;
    }
    // 'done', 'sideband-all', 'wait-for-done', 'agent ...', 'object-format ...'
    // and anything unknown are ignored: the request still gets an answer.
  }
  return out;
}

// ---- fetch pack computation ----

interface FetchPlan {
  oids: Set<string>;
  shallow: string[];
  includedCommits: Set<string>;
}

/**
 * Objects the client still needs: reachable from wants minus reachable from
 * haves (and minus deepen-not), honoring deepen / deepen-since boundaries.
 */
function computeFetch(repo: Repo, args: FetchArgs): FetchPlan {
  // Expand tag wants: the tag object itself is sent, its target is wanted too.
  const wantCommits: string[] = [];
  const extraOids = new Set<string>();
  const queue = [...args.wants];
  const seenWant = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seenWant.has(oid)) continue;
    seenWant.add(oid);
    const obj = getObject(repo, oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extraOids.add(oid);
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'commit') {
      wantCommits.push(oid);
    } else {
      extraOids.add(oid);
    }
  }

  // BFS over parents; generation 1 = the want tips.
  const includedCommits = new Set<string>();
  const genOf = new Map<string, number>();
  const bfs: { oid: string; gen: number }[] = wantCommits.map((oid) => ({ oid, gen: 1 }));
  const visited = new Set<string>();
  while (bfs.length > 0) {
    const cur = bfs.shift() as { oid: string; gen: number };
    if (visited.has(cur.oid)) continue;
    visited.add(cur.oid);
    const obj = getObject(repo, cur.oid);
    if (!obj || obj.type !== 'commit') continue;
    if (args.deepen !== null && cur.gen > args.deepen) continue;
    const info = parseCommit(obj.data);
    if (args.deepenSince !== null) {
      const ts = commitEpoch(repo, cur.oid);
      if (ts !== null && ts < args.deepenSince) continue;
    }
    includedCommits.add(cur.oid);
    genOf.set(cur.oid, cur.gen);
    for (const p of info.parents) bfs.push({ oid: p, gen: cur.gen + 1 });
  }

  // Shallow boundaries: included commits with a parent that is not included,
  // or (when depth-limited) commits sitting exactly at the depth limit — the
  // want tips for deepen 1, the new boundary for a deeper deepen.
  const shallow: string[] = [];
  for (const oid of includedCommits) {
    const obj = getObject(repo, oid);
    if (!obj) continue;
    const info = parseCommit(obj.data);
    const atLimit = args.deepen !== null && genOf.get(oid) === args.deepen;
    if (atLimit || (info.parents.length > 0 && info.parents.some((p) => !includedCommits.has(p)))) shallow.push(oid);
  }
  shallow.sort();

  const oids = new Set<string>(extraOids);
  for (const oid of includedCommits) {
    oids.add(oid);
    const obj = getObject(repo, oid);
    if (obj) addTreeClosure(repo, parseCommit(obj.data).tree, oids);
  }

  const exclude = reachableObjects(repo, args.haves);
  if (args.deepenNot !== null) {
    const target = resolveRefOrOid(repo, args.deepenNot);
    if (target !== null) {
      for (const o of reachableObjects(repo, [target])) exclude.add(o);
    }
  }
  for (const e of exclude) oids.delete(e);

  if (args.filter !== null) {
    if (args.filter === 'blob:none') {
      for (const o of [...oids]) {
        const ob = getObject(repo, o);
        if (ob !== undefined && ob.type === 'blob') oids.delete(o);
      }
    } else if (args.filter === 'tree:0') {
      for (const o of [...oids]) {
        const ob = getObject(repo, o);
        if (ob !== undefined && (ob.type === 'tree' || ob.type === 'blob')) oids.delete(o);
      }
    } else if (args.filter.startsWith('blob:limit=')) {
      const lim = parseInt(args.filter.slice('blob:limit='.length), 10);
      if (Number.isFinite(lim)) {
        for (const o of [...oids]) {
          const ob = getObject(repo, o);
          if (ob !== undefined && ob.type === 'blob' && ob.data.length > lim) oids.delete(o);
        }
      }
    }
  }
  return { oids, shallow, includedCommits };
}

/** Haves that are an ancestor (or equal) of a want — the common base. */
function commonHaves(repo: Repo, args: FetchArgs): string[] {
  const out: string[] = [];
  for (const h of args.haves) {
    if (out.includes(h)) continue;
    for (const w of args.wants) {
      const wobj = getObject(repo, w);
      if (!wobj) continue;
      let target = w;
      if (wobj.type === 'tag') {
        let cur = parseTag(wobj.data).object;
        const seen = new Set<string>();
        while (true) {
          const o = getObject(repo, cur);
          if (!o || o.type !== 'tag' || seen.has(cur)) break;
          seen.add(cur);
          cur = parseTag(o.data).object;
        }
        target = cur;
      }
      if (isAncestor(repo, h, target)) {
        out.push(h);
        break;
      }
    }
  }
  return out;
}

// ---- upload-pack ----

function v2FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const plan = computeFetch(repo, args);
  const common = commonHaves(repo, args);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (common.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const h of common) parts.push(pktLine(`ACK ${h}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(pktFlush());
  parts.push(pktLine('shallow-info\n'));
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  parts.push(pktFlush());
  parts.push(pktLine('wanted-refs\n'));
  for (const r of sortedRefs(repo)) {
    if (args.wants.includes(r.oid)) parts.push(pktLine(`${r.oid} ${r.ref}\n`));
  }
  parts.push(pktFlush());
  parts.push(pktLine('packfile\n'));
  const pack = writePack(repo, [...plan.oids]);
  for (const p of sidebandPackets(1, pack)) parts.push(p);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const plan = computeFetch(repo, args);
  const common = commonHaves(repo, args);
  const parts: Buffer[] = [];
  if (common.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const h of common) parts.push(pktLine(`ACK ${h}\n`));
  }
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  // Boundaries the client had that are no longer boundaries (fully included now).
  for (const s of args.shallowLines) {
    const obj = getObject(repo, s);
    if (!obj || obj.type !== 'commit') continue;
    if (!plan.includedCommits.has(s)) continue;
    const info = parseCommit(obj.data);
    if (info.parents.every((p) => plan.includedCommits.has(p))) parts.push(pktLine(`unshallow ${s}\n`));
  }
  const pack = writePack(repo, [...plan.oids]);
  if (args.caps.has('side-band-64k')) {
    for (const p of sidebandPackets(1, pack)) parts.push(p);
    parts.push(pktFlush());
  } else {
    parts.push(pack);
  }
  return Buffer.concat(parts);
}

function handleV2Upload(repo: Repo, body: Buffer): Buffer {
  const out: Buffer[] = [];
  let off = 0;
  let sawCommand = false;
  while (off < body.length) {
    const { lines, next, ended } = readPktLines(body, off);
    off = next;
    if (lines.length === 0) {
      if (!ended) break;
      continue;
    }
    const first = lines[0].replace(/\n$/, '').trim();
    if (!first.startsWith('command=')) throw new Error('expected command= line');
    sawCommand = true;
    const cmd = first.slice('command='.length).trim();
    const args = lines.slice(1).map((a) => a.replace(/\n$/, '').replace(/\r$/, '').trim());
    if (cmd === 'ls-refs') {
      out.push(lsRefsResponse(repo, args));
    } else if (cmd === 'fetch') {
      out.push(v2FetchResponse(repo, parseFetchArgs(args)));
    } else {
      throw new Error(`unknown command ${cmd}`);
    }
    if (!ended) break;
  }
  if (!sawCommand) throw new Error('no command in request');
  return Buffer.concat(out);
}

async function handleUploadPack(repo: Repo, req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendJsonError(res, store, 400, 'could not read request body');
    return;
  }
  try {
    const out = isV2(req) ? handleV2Upload(repo, body) : v0FetchResponse(repo, parseFetchArgs(readPktLines(body, 0).lines));
    sendBuffer(res, 200, UPLOAD_RESULT_CT, out);
  } catch {
    if (!res.writableEnded) sendJsonError(res, store, 400, 'malformed git request');
  }
}

// ---- receive-pack (v0) ----

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function handleReceivePack(repo: Repo, req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendJsonError(res, store, 400, 'could not read request body');
    return;
  }
  try {
    const { lines, next: packStart } = readPktLines(body, 0);
    const cmds: PushCommand[] = [];
    let caps: string[] = [];
    for (const raw of lines) {
      const line = raw.replace(/\n$/, '').replace(/\r$/, '');
      const nul = line.indexOf('\0');
      let main = line;
      if (nul >= 0) {
        main = line.slice(0, nul);
        caps = line.slice(nul + 1).split(' ').filter((c) => c !== '');
      }
      const parts = main.split(' ');
      if (parts.length < 3 || !/^[0-9a-f]{40}$/.test(parts[0]) || !/^[0-9a-f]{40}$/.test(parts[1]) || parts[2] === '') {
        throw new Error('malformed receive-pack command');
      }
      cmds.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    const sideband = caps.includes('side-band-64k');
    const packBytes = body.subarray(packStart);
    const needsPack = cmds.some((c) => c.newOid !== ZERO_OID);

    let unpackOk = true;
    let unpackErr = '';
    if (needsPack) {
      if (packBytes.length === 0) {
        unpackOk = false;
        unpackErr = 'missing pack';
      } else {
        try {
          const resolved = await readPack(packBytes, repo.objects);
          for (const [oid, obj] of resolved) {
            if (hashObject(obj.type, obj.data) !== oid) throw new Error('object hash mismatch');
            if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
          }
        } catch (err) {
          unpackOk = false;
          unpackErr = err instanceof Error ? err.message : String(err);
        }
      }
    }

    // Per-ref fast-forward checks; apply only the ok commands, in order.
    const results: { ref: string; ok: boolean }[] = [];
    for (const cmd of cmds) {
      if (!unpackOk) {
        results.push({ ref: cmd.ref, ok: false });
        continue;
      }
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (current !== undefined && cmd.oldOid === current) {
          repo.refs.delete(cmd.ref);
          results.push({ ref: cmd.ref, ok: true });
        } else {
          results.push({ ref: cmd.ref, ok: false });
        }
      } else if (cmd.oldOid === ZERO_OID) {
        // create
        if (current === undefined && repo.objects.has(cmd.newOid)) {
          repo.refs.set(cmd.ref, cmd.newOid);
          results.push({ ref: cmd.ref, ok: true });
        } else {
          results.push({ ref: cmd.ref, ok: false });
        }
      } else {
        // update: old must equal the current tip and be an ancestor of new
        if (current !== undefined && cmd.oldOid === current && isAncestor(repo, cmd.oldOid, cmd.newOid)) {
          repo.refs.set(cmd.ref, cmd.newOid);
          results.push({ ref: cmd.ref, ok: true });
        } else {
          results.push({ ref: cmd.ref, ok: false });
        }
      }
    }

    const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackErr || 'failed'}\n`];
    for (const r of results) {
      reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} non-fast-forward\n`);
    }
    const parts: Buffer[] = [];
    if (sideband) {
      for (const line of reportLines) {
        for (const p of sidebandPackets(1, Buffer.from(line, 'utf8'))) parts.push(p);
      }
      parts.push(pktFlush());
    } else {
      for (const line of reportLines) parts.push(pktLine(line));
      parts.push(pktFlush());
    }
    sendBuffer(res, 200, RECEIVE_RESULT_CT, Buffer.concat(parts));
  } catch {
    if (!res.writableEnded) sendJsonError(res, store, 400, 'malformed git request');
  }
}

// ---- entry point ----

export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://forge');
  } catch {
    return false;
  }
  const path = url.pathname;
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length < 2) return false;
  if (!parts[1].endsWith('.git')) return false;

  try {
    const owner = decodeURIComponent(parts[0]);
    const repoName = decodeURIComponent(parts[1].slice(0, -4));
    if (!checkAuth(req)) {
      sendJsonError(res, store, 401, 'authentication required');
      return true;
    }
    if (owner !== VIEWER.login) {
      sendJsonError(res, store, 404, 'Not Found');
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendJsonError(res, store, 404, 'Not Found');
      return true;
    }
    const rest = parts.slice(2);
    const method = req.method ?? 'GET';
    if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJsonError(res, store, 404, 'Not Found');
        return true;
      }
      if (service === 'git-upload-pack' && isV2(req)) {
        sendBuffer(res, 200, UPLOAD_AD_CT, v2Advertisement());
      } else if (service === 'git-upload-pack') {
        sendBuffer(res, 200, UPLOAD_AD_CT, v0Advertisement(repo, 'git-upload-pack'));
      } else {
        sendBuffer(res, 200, RECEIVE_AD_CT, v0Advertisement(repo, 'git-receive-pack'));
      }
      return true;
    }
    if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
      await handleUploadPack(repo, req, res, store);
      return true;
    }
    if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
      await handleReceivePack(repo, req, res, store);
      return true;
    }
    sendJsonError(res, store, 404, 'Not Found');
    return true;
  } catch {
    if (!res.writableEnded) {
      try {
        sendJsonError(res, store, 400, 'bad request');
      } catch {
        // response already gone; nothing more to do
      }
    }
    return true;
  }
}
