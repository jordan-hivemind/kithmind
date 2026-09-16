#!/usr/bin/env node
// `kith-deferred-work`: the daemon command section 2.6 puts on the always-on
// worker host. "One more launchd job and one `kith deferred-work drain`
// command" is the whole cost the plan assigns this row on the daemon side;
// this file and `docs/kithmind-deferred-work.launchd.plist.txt` are it.
//
// Argument shape follows `packages/pipeline/src/cli.ts`'s own convention
// (explicit flags, a `usage()` that throws rather than a library), because
// this daemon lives beside that one on the same host and a second argument
// style would be its own maintenance cost for no benefit.
//
//   kith-deferred-work once                     one tick, then exit
//   kith-deferred-work tick [--interval-ms N]    tick on a loop, or once
//   kith-deferred-work drain [--interval-ms N] [--max-jobs N]
//
// `KITH_STORE_DATABASE_URL` is required; nothing here defaults a connection
// string. Every mode prints one JSON summary line per round to standard
// output and exits nonzero when a sweep or drain round itself throws (a
// database or programming failure) -- not when an individual job merely ends
// up `failed`, which is normal operation the summary already reports.

import process from "node:process";
import { pathToFileURL } from "node:url";

import { createKithPool } from "../schema.js";
import { drain, type DrainSummary } from "./drain.js";
import { createRegistry, type DeferredWorkRegistry } from "./registry.js";
import { tick, type TickSummary } from "./tick.js";

function usage(): never {
  process.stderr.write(
    "Usage: kith-deferred-work once | tick [--interval-ms N] | drain [--interval-ms N] [--max-jobs N]\n",
  );
  process.exit(2);
}

type Parsed =
  | { command: "once" }
  | { command: "tick"; intervalMs: number | null }
  | { command: "drain"; intervalMs: number | null; maxJobs: number | null };

// The lowest `--interval-ms` this daemon accepts. Below this, a loop is a
// busy poll against the pool rather than a periodic tick.
const MIN_INTERVAL_MS = 1_000;

function positiveInteger(value: string | undefined, flag: string): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) {
    process.stderr.write(`${flag} requires a positive integer\n`);
    usage();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) usage();
  if (flag === "--interval-ms" && parsed < MIN_INTERVAL_MS) {
    process.stderr.write(
      `${flag} must be at least ${MIN_INTERVAL_MS} (busy-loops the pool below that)\n`,
    );
    usage();
  }
  return parsed;
}

export function argumentsFor(argv: string[]): Parsed {
  const forwarded = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = forwarded;
  if (command === "once") {
    if (rest.length > 0) usage();
    return { command: "once" };
  }
  if (command === "tick" || command === "drain") {
    let intervalMs: number | null = null;
    let maxJobs: number | null = null;
    for (let index = 0; index < rest.length; index += 1) {
      const flag = rest[index];
      if (flag === "--interval-ms") {
        intervalMs = positiveInteger(rest[index + 1], "--interval-ms");
        index += 1;
      } else if (flag === "--max-jobs" && command === "drain") {
        maxJobs = positiveInteger(rest[index + 1], "--max-jobs");
        index += 1;
      } else {
        usage();
      }
    }
    return command === "tick"
      ? { command: "tick", intervalMs }
      : { command: "drain", intervalMs, maxJobs };
  }
  usage();
}

function requireDatabaseUrl(): string {
  const url = process.env.KITH_STORE_DATABASE_URL;
  if (!url) {
    process.stderr.write(
      "KITH_STORE_DATABASE_URL must be set to the brain's PostgreSQL endpoint.\n",
    );
    process.exit(2);
  }
  return url;
}

function writeSummary(summary: TickSummary | DrainSummary): void {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

/** The registry this daemon drains with. Empty today: every kind in
 * `migrations/017_deferred_work.sql`'s CHECK list is documented as
 * unregistered by this row (see `sweeps.ts`'s header). The row that ports
 * inline admission, P2-39g2 or P2-39f registers a handler here as it lands;
 * nothing about the daemon command itself needs to change when it does. */
function defaultRegistry(): DeferredWorkRegistry {
  return createRegistry();
}

async function runLoop(
  signal: AbortSignal,
  intervalMs: number,
  round: () => Promise<void>,
): Promise<void> {
  while (!signal.aborted) {
    await round();
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

export async function main(argv: string[]): Promise<number> {
  const parsed = argumentsFor(argv);
  const url = requireDatabaseUrl();
  const pool = createKithPool(url);
  const registry = defaultRegistry();
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  let sawFailure = false;
  try {
    if (parsed.command === "once") {
      writeSummary(await tick(pool, registry));
      return 0;
    }
    if (parsed.command === "tick") {
      const round = async () => {
        try {
          writeSummary(await tick(pool, registry));
        } catch (error) {
          sawFailure = true;
          process.stderr.write(`${errorMessage(error)}\n`);
        }
      };
      if (parsed.intervalMs === null) {
        await round();
      } else {
        await runLoop(stop.signal, parsed.intervalMs, round);
      }
      return sawFailure ? 1 : 0;
    }
    // drain
    const round = async () => {
      try {
        writeSummary(await drain(pool, registry, { maxJobs: parsed.maxJobs ?? undefined }));
      } catch (error) {
        sawFailure = true;
        process.stderr.write(`${errorMessage(error)}\n`);
      }
    };
    if (parsed.intervalMs === null) {
      await round();
    } else {
      await runLoop(stop.signal, parsed.intervalMs, round);
    }
    return sawFailure ? 1 : 0;
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    await pool.end();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
