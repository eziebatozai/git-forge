# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/eziebatozai/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/eziebatozai/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge: git smart HTTP, REST v3, GraphQL and MCP in one Node 22 process, from its own in-memory store. No UI, no git binary, no dependencies — pure Node standard library.

## Run it

```sh
node main.ts
```

The program binds an ephemeral port, registers it with the suite at `MAKEFUN_ENV_URL`, serves until the suite says done, then exits 0. It runs as `node /bot/main.ts` on Node 22.18 or later. There is nothing to install.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: upload-pack protocol v2, receive-pack v0, with a from-scratch packfile reader/writer (plain + OFS/REF deltas, thin packs, shallow/deepen) |

Every API call arrives with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a missing or wrong token is refused with 401, and a repository belongs to the login the token names. All state is deterministic: ids and timestamps come from counters and a fixed base epoch, never the wall clock, so a replay leaves the same export byte for byte.

## Layout

- `main.ts`: the entry ↔ env lifecycle (bind, register, poll `/done`, exit 0).
- `app.ts`: the HTTP router.
- `store.ts`: the deterministic in-memory store (repos, refs, objects, issues, pulls).
- `gitobj.ts`: the git object model — hashing, trees, commits, tags, packfile read/write.
- `gitproto.ts`: git smart HTTP (advertisements, ls-refs, fetch v2/v0, receive-pack).
- `rest.ts`: the REST v3 surface, including squash-merge with conflict detection.
- `graphql.ts`: a hand-rolled GraphQL parser + executor for the suite's documents.
- `mcp.ts`: MCP server/discover + legacy initialize, tools/list, tools/call.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page: **https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no dependencies at run time, no internet and no `git` binary in the trial; the repository is mounted read-only at `/bot`. Local grade-local score on the kit's practice trial-0: **974/1000** (feature 600, agent 200, perf 174), replay matched byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
