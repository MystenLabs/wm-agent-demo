/**
 * Direct access to the memory space, without the agent in the way.
 *
 *   pnpm mem health
 *   pnpm mem recall "what do you know about me?"
 *   pnpm mem remember "I take my coffee black."
 *   pnpm mem restore [limit]
 */

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
      // distance is cosine: <0.25 near-duplicate, 0.25–0.55 related,
      // 0.55–0.7 weak, >=0.7 usually unrelated.
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
  if (!value) throw new Error(`${name} is not set — copy .env.example to .env`);
  return value;
}
