// Lifecycle between this process and the grading env (see env/src/wire.ts):
// pick a free port, hand it to the env, then stay up until the env reports
// the trial finished. The server itself lives in app.ts; this file only
// owns the handshake. Port 8080 belongs to the env, so it is never bound here.

import { createApp } from "./app.ts";

// The env's origin, e.g. http://store:8080 inside a trial container.
const baseUrl = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (baseUrl === "") {
  process.stderr.write("[forge] MAKEFUN_ENV_URL is unset, nothing to register with\n");
  process.exit(1);
}

const REQUEST_BUDGET_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

// Backoff for attempt n: doubling from BACKOFF_START_MS, never past the ceiling.
function backoffMs(n: number): number {
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_START_MS * 2 ** Math.min(n, 8));
}

class FatalRegisterError extends Error {}

// Tell the env which port we bound. The env combines the request's source
// address with that port and dials us from then on. A 200 means accepted;
// a 409 means some earlier register already won and we simply wait like
// everyone else. 400/405 is a contract violation, so it ends the run, while
// anything else (env still booting, transient status) is retried forever.
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let status: number;
    try {
      const res = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      status = res.status;
      if (status === 200 || status === 409) return;
      if (status === 400 || status === 405) {
        throw new FatalRegisterError(`register rejected with HTTP ${status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof FatalRegisterError) throw err;
    }
    await wait(backoffMs(failures));
    failures += 1;
  }
}

// Keep asking GET /done until the env answers {"done": true}. The env
// replies immediately with {"done": false} while the suite is still
// running, so this is a poll. Any failure just means "not done yet".
async function awaitCompletion(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (res.ok) {
        const payload = (await res.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Env unreachable or the poll timed out: keep polling.
    }
    await wait(backoffMs(failures));
    failures += 1;
  }
}

async function boot(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("server did not bind an ephemeral TCP port");
  }
  process.stdout.write(`[forge] listening on ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write("[forge] registered, waiting for the env to finish\n");

  await awaitCompletion();
  server.close();
  process.stdout.write("[forge] done\n");
}

try {
  await boot();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
