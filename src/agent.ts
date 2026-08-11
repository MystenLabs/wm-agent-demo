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
  //    Results come back sorted by cosine distance, lower is more similar.
  //    There's no default relevance threshold, so maxDistance drops the
  //    weak matches that would otherwise show up in a small namespace.
  //
  //    Calibrate this against your own data. Measured for this example, with
  //    natural-language questions against short stored facts, relevant hits
  //    land around 0.33-0.78 and unrelated ones at 0.86+, so 0.8 separates them
  //    well. Longer documents or different phrasing will shift that.
  const { results } = await memwal.recall({
    query: input,
    limit: 5,
    maxDistance: 0.8,
  });
  for (const m of results) {
    console.log(dim(`  ↳ recalled  ${m.distance.toFixed(2)}  ${m.text}`));
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
  const { facts, job_ids } = await memwal.analyze(input);
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
