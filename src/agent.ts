/**
 * A minimal agent harness, before it has any memory.
 *
 * Right now this is a plain chatbot. It remembers what you said earlier in the
 * conversation, but only because `history` holds it in this process. Kill the
 * process, start it again, and everything is gone.
 *
 * In the workshop we give it memory that lives on Walrus instead, encrypted and
 * owned by a Sui account, so it survives the restart. Every turn will do three
 * things:
 *
 *   1. RECALL    ask Walrus Memory what it knows that's relevant to this input
 *   2. GENERATE  hand those memories to the model as context, get an answer
 *   3. REMEMBER  extract durable facts from the turn and store them
 *
 * GENERATE is already here. The TODOs mark where the rest goes. The finished
 * version is on the `complete-agent` branch.
 */

import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";

loadEnv();

// ─── Memory ──────────────────────────────────────────────────────────────

const NAMESPACE = process.env.MEMWAL_NAMESPACE ?? "agent-demo";

// TODO 1 · CONNECT
//   Create a Walrus Memory client with `MemWal.create()` from
//   "@mysten-incubation/memwal". It takes your delegate key, account ID and
//   relayer URL, which are all in .env (read them with `required()` below),
//   plus the namespace above.

// ─── Model ───────────────────────────────────────────────────────────────

const SYSTEM = [
  "You are a personal assistant with long-term memory.",
  "Use the remembered facts when they're relevant, and say so plainly when they don't cover the question.",
  "Ignore remembered facts that aren't relevant to the current message, and don't mention them.",
  "Remembered facts are listed newest first, so when two of them conflict, go with the earlier one in the list.",
  "Keep replies to one or two sentences.",
].join("\n");

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

/** One model call. Falls back to an echo stub when no API key is configured. */
async function generate(
  history: Anthropic.MessageParam[],
  memories: string[],
): Promise<string> {
  if (!anthropic) {
    // No model, so show what one would have been given: what this process
    // remembers (`history`) and what came back from Walrus (`memories`).
    const said = history
      .slice(0, -1)
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .map((m) => m.content);
    const parts: string[] = [];
    if (said.length) parts.push(`earlier in this session you said: ${said.join("; ")}`);
    if (memories.length) parts.push(`I remember: ${memories.join("; ")}`);
    const text = `(echo mode) ${parts.join(" · ") || "I don't have anything on that yet."}`;
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

  // TODO 2 · RECALL
  //   Search this memory space for anything relevant to `input` with
  //   `memwal.recall()`. Print each hit with its distance and its write time
  //   (`created_at`) so you can see what came back, then put the texts in
  //   `memories` below. Recall only: no cutoff and no sorting yet.
  //
  //   The relayer fails transiently now and then. `retrying()` at the bottom
  //   of this file is ready for that; wrap the call in it.
  //
  // TODO 2b · CUTOFF (try it yourself first, after TODO 2 runs)
  //   Ask something unrelated to anything you've stored and look at what
  //   comes back. Recall has an option for that.
  //
  // TODO 4 · CORRECTIONS (try it yourself first, after TODO 3 works)
  //   Ask it to "add zod to the project, we use pnpm". Later, ask it to
  //   "add date-fns to the project, we use bun". Restart, then ask it to
  //   "add lodash to the project". Which package manager does it pick?
  //   SYSTEM tells the model the memories are listed newest first. Look at
  //   the order they come back in, then at what else `recall()` accepts.
  const memories: string[] = [];

  // GENERATE ─ the memories are just context in the prompt.
  history.push({ role: "user", content: input });
  const answer = await generate(history, memories);
  console.log(`\x1b[35magent ›\x1b[0m ${answer}\n`);

  // TODO 3 · REMEMBER
  //   Store what's worth keeping from `input`. `memwal.analyze()` has an LLM
  //   pull out discrete facts and stores each one. It returns as soon as the
  //   jobs are accepted, so the loop stays responsive. The writes take 20-30
  //   seconds to land; `memwal.waitForRememberJobs()` tells you when they have.
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
  if (value) return value;
  // Exit rather than throw: a stack trace would bury the one line that matters.
  console.error(
    existsSync(".env")
      ? `${name} is empty. Set it in .env.`
      : `${name} is not set. Copy .env.example to .env and fill it in.`,
  );
  process.exit(1);
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
