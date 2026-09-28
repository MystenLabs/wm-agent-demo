/**
 * Direct access to the memory space, without the agent in the way.
 *
 *   pnpm mem health
 *   pnpm mem recall "what do you know about me?"
 *   pnpm mem remember "I take my coffee black."
 *   pnpm mem restore [limit]
 */

import { existsSync } from "node:fs";
import { MemWal } from "@mysten-incubation/memwal";

try {
  process.loadEnvFile(".env");
} catch {
  /* fall back to the exported environment */
}

const NAMESPACE = process.env.MEMWAL_NAMESPACE ?? "agent-demo";

const memwal = MemWal.create({
  key: required("MEMWAL_KEY"),
  accountId: required("MEMWAL_ACCOUNT_ID"),
  serverUrl: required("MEMWAL_SERVER_URL"),
  namespace: NAMESPACE,
});

const [command, ...rest] = process.argv.slice(2);
const arg = rest.join(" ");

switch (command) {
  case "health": {
    // Unauthenticated liveness check — proves the relayer is reachable,
    // says nothing about whether your credentials are good.
    const { status, version } = await memwal.health();
    console.log(`${status}  ·  relayer ${version}`);
    break;
  }

  case "recall": {
    if (!arg) throw new Error('usage: pnpm mem recall "<query>"');
    const { results, total } = await memwal.recall({ query: arg, limit: 10 });
    console.log(`${total} result(s) in "${NAMESPACE}"\n`);
    for (const m of results) {
      // distance is cosine, lower is closer. Nothing is filtered here, so
      // this is the place to calibrate: run the questions you expect against
      // your own facts and see where relevant and unrelated hits land. For
      // this example's data they overlap around 0.77-0.8; `agent.ts` on the
      // `complete-agent` branch explains the default it picks.
      console.log(`  ${m.distance.toFixed(3)}  ${m.text}`);
      console.log(`          \x1b[2mblob ${m.blob_id}\x1b[0m`);
    }
    break;
  }

  case "remember": {
    if (!arg) throw new Error('usage: pnpm mem remember "<fact>"');
    // rememberAndWait blocks until the blob is on Walrus and indexed, so a
    // recall immediately afterwards is guaranteed to see it.
    const stored = await memwal.rememberAndWait(arg, NAMESPACE, {
      timeoutMs: 60_000,
    });
    console.log(`stored  blob ${stored.blob_id}\n        owner ${stored.owner}`);
    break;
  }

  case "restore": {
    // Rebuilds missing index entries for this namespace from Walrus. The
    // blobs are the source of truth; the vector index is a cache.
    const limit = Number(rest[0]) || 50;
    const r = await memwal.restore(NAMESPACE, limit);
    console.log(
      `restored ${r.restored}  ·  already indexed ${r.skipped}  ·  found on-chain ${r.total}`,
    );
    // Restore is single-shot with no cursor. `truncated` is how it tells you
    // the pass was incomplete — raising the limit may or may not fix it.
    if (r.truncated) console.log("incomplete — run it again, or raise the limit");
    break;
  }

  default:
    console.log(
      [
        "usage:",
        "  pnpm mem health",
        '  pnpm mem recall "<query>"',
        '  pnpm mem remember "<fact>"',
        "  pnpm mem restore [limit]",
      ].join("\n"),
    );
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  // Exit rather than throw: a stack trace would bury the one line that matters.
  console.error(
    existsSync(".env")
      ? `${name} is empty. Set it in .env.`
      : `${name} is not set. Copy .env.example to .env and fill it in.`,
  );
  process.exit(1);
}
