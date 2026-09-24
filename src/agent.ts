/**
 * A minimal agent harness with portable memory.
 *
 * Every turn does three things:
 *
 *   1. RECALL    ask Walrus Memory what it knows that's relevant to this input
 *   2. GENERATE  hand those memories to the model as context, get an answer
 *   3. REMEMBER  extract durable facts from the turn and store them
 *
 * The memory lives on Walrus, encrypted, owned by a Sui account — not in this
 * process. Kill the process and start it again: step 1 still finds everything.
 */

import { createInterface } from "node:readline/promises";
import { MemWal } from "@mysten-incubation/memwal";
import Anthropic from "@anthropic-ai/sdk";

loadEnv();

// ─── Memory ──────────────────────────────────────────────────────────────

const NAMESPACE = process.env.MEMWAL_NAMESPACE ?? "agent-demo";

// Recall cutoff, see step 1 below. 0 or unset falls back to the default.
const MAX_DISTANCE = Number(process.env.MEMWAL_MAX_DISTANCE) || 0.8;

const memwal = MemWal.create({
  key: required("MEMWAL_KEY"), // Ed25519 delegate key, registered on-chain
  accountId: required("MEMWAL_ACCOUNT_ID"), // the MemWalAccount object on Sui
  serverUrl: required("MEMWAL_SERVER_URL"),
  namespace: NAMESPACE, // recall is scoped to owner + namespace
});

// ─── Model ───────────────────────────────────────────────────────────────

const SYSTEM = [
  "You are a personal assistant with long-term memory.",
  "Use the remembered facts when they're relevant, and say so plainly when they don't cover the question.",
  "Ignore remembered facts that aren't relevant to the current message, and don't mention them.",
  "Keep replies to one or two sentences.",
].join("\n");

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

/** One model call. Falls back to an echo stub when no API key is configured. */
async function generate(
  history: Anthropic.MessageParam[],
  memories: string[],
): Promise<string> {
  if (!anthropic) {
    const text = memories.length
      ? `(echo mode) I remember: ${memories.join("; ")}`
      : "(echo mode) I don't have anything on that yet.";
    history.push({ role: "assistant", content: text });
    return text;
  }

  const reply = await anthropic.messages.create({
    model: "claude-opus-5",
    max_tokens: 2048,
    output_config: { effort: "low" },
    system: memories.length
      ? `${SYSTEM}\n\nWhat you remember about this user:\n${memories.map((m) => `- ${m}`).join("\n")}`
      : SYSTEM,
    messages: history,
  });

  // Check this before reading content — a refusal returns HTTP 200 with an
  // empty content array.
  if (reply.stop_reason === "refusal") return "(the model declined that one)";

  history.push({ role: "assistant", content: reply.content });
  return reply.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// ─── The loop ────────────────────────────────────────────────────────────

const history: Anthropic.MessageParam[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on("close", () => process.exit(0));

console.log(
  `\n  namespace ${NAMESPACE}  ·  ${anthropic ? "claude-opus-5" : "echo mode"}  ·  ctrl-c to quit\n`,
);

for (;;) {
  const input = (await rl.question("\x1b[36myou ›\x1b[0m ")).trim();
  if (!input) continue;

  // 1. RECALL ─ semantic search over this memory space.
  //    Results come back scored by cosine distance, lower is more similar.
  //    There's no default relevance threshold, so maxDistance drops the
  //    weak matches that would otherwise show up in a small namespace.
  //
  //    Calibrate this against your own data. Measured for this example, with
  //    natural-language questions against short stored facts, relevant hits
  //    land around 0.33-0.78 and unrelated ones mostly at 0.86+, but not
  //    always: short facts in the same "User ..." shape can score 0.77 against
  //    a question that has nothing to do with them. The ranges overlap, so no
  //    cutoff is clean. The default leans loose, because dropping a real match
  //    is silent while a stray one is just noise the model is told to ignore
  //    (see SYSTEM). When you control the phrasing, as in a scripted demo,
  //    MEMWAL_MAX_DISTANCE=0.7 is tighter and cleaner.
  //
  //    sort: "recent" is what makes a correction stick. Memory here is
  //    append-only, so updating a fact means storing a second one that
  //    contradicts the first, and pure relevance has no reason to prefer the
  //    newer one — it usually prefers the older one, which states the thing
  //    you're asking about more directly. Say "Our package manager is pnpm."
  //    and later "We switched from pnpm to bun last week.", then ask "what
  //    package manager do we use?": the stale fact scores 0.33 and the
  //    correction 0.61, so relevance answers pnpm. "recent" over-fetches
  //    candidates, orders them by write time, and answers bun.
  //
  //    Mind the interaction with maxDistance: the threshold is applied first,
  //    and only the survivors get reordered. A correction that the threshold
  //    drops never reaches the sort, and you're served the stale fact with no
  //    sign anything was missing. analyze() helps here — it keeps the old
  //    value in the correction ("switched from pnpm to bun"), which anchors it
  //    to the topic. The same correction stored as raw text, "We switched to
  //    bun last week.", scores 0.79 for that question and 0.77 for an
  //    unrelated one about deploy days, so no threshold separates the two.
  const { results } = await retrying("recall", () =>
    memwal.recall({ query: input, limit: 5, maxDistance: MAX_DISTANCE, sort: "recent" }),
  ).catch((err) => {
    // Out of retries. Answer without memories rather than killing the loop.
    console.log(dim(`  ↳ recall failed: ${err.message}`));
    return { results: [] };
  });
  for (const m of results) {
    // Write time, so it's visible why a weaker match can rank first.
    const at = m.created_at?.slice(0, 19).replace("T", " ") ?? "";
    console.log(dim(`  ↳ recalled  ${m.distance.toFixed(2)}  ${at}  ${m.text}`));
  }

  // 2. GENERATE ─ the memories are just context in the prompt.
  history.push({ role: "user", content: input });
  const answer = await generate(
    history,
    results.map((m) => m.text),
  );
  console.log(`\x1b[35magent ›\x1b[0m ${answer}\n`);

  // 3. REMEMBER ─ analyze() extracts discrete facts and returns them right
  //    away; the embed → encrypt → upload → index work runs in the
  //    background, one job per fact.
  const { facts, job_ids } = await retrying("analyze", () =>
    memwal.analyze(input),
  ).catch((err) => {
    console.log(dim(`  ↳ store failed: ${err.message}\n`));
    return { facts: [], job_ids: [] as string[] };
  });
  if (facts.length) {
    console.log(dim(`  ↳ storing   ${facts.map((f) => f.text).join(" · ")}`));
    memwal
      .waitForRememberJobs(job_ids)
      .then(({ succeeded, total }) =>
        console.log(dim(`  ↳ stored    ${succeeded}/${total} on Walrus\n`)),
      )
      .catch((err) => console.log(dim(`  ↳ store failed: ${err.message}\n`)));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Retry a relayer call through a transient failure.
 *
 * `recall()` and `analyze()` are single-shot: each one issues one signed
 * request and returns. The SDK's own backoff only covers job polling
 * (`rememberAndWait` and friends), so these two need a retry of their own.
 *
 * Backoff matters more than attempt count here. The failures arrive in windows
 * several seconds wide rather than as isolated blips — everything fails for the
 * length of the window, then clears — so an immediate retry just lands in the
 * same window. The relayer states its own backoff on the error as
 * `retryAfterSeconds`; prefer it, and fall back to a ladder wide enough to
 * outlast a typical window when it is absent.
 */
async function retrying<T>(label: string, call: () => Promise<T>): Promise<T> {
  // Local, not module-level: the loop above runs before the bottom of this
  // file is evaluated, so a top-level `const` here would be in the temporal
  // dead zone on the first call. Function declarations hoist; `const` doesn't.
  const fallbackDelays = [1000, 2000, 4000, 8000];

  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const fallback = fallbackDelays[attempt];
      if (fallback === undefined || !isTransient(err)) throw err;
      // The SDK reads `Retry-After` for us, and falls back to the 429 body
      // when a proxy strips the header.
      const hinted = (err as { retryAfterSeconds?: number }).retryAfterSeconds;
      // Cap it: a server that asks for a long wait shouldn't stall the demo.
      const delay = Math.min(hinted ? hinted * 1000 : fallback, 8000);
      const why = hinted ? " (Retry-After)" : "";
      console.log(dim(`  ↳ ${label} failed, retrying in ${delay}ms${why}`));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Worth retrying: rate limits, server errors, dropped sockets.
 *
 * Not 401. The relayer used to answer a valid key with 401 while an upstream
 * it depends on was rate-limiting it, which was indistinguishable from a bad
 * key; SDK 0.1.6 moved that case to a retryable 503, so a bare 401 now means
 * the credentials really are wrong. Retrying it would only make a mistyped
 * key take four backoffs to report itself.
 */
function isTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429) return true;
  if (status !== undefined) return status >= 500;
  return err instanceof Error; // network/abort — no status to read
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set — copy .env.example to .env`);
  return value;
}

function loadEnv(): void {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env file; fall back to whatever is already exported.
  }
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
