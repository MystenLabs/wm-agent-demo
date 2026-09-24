# Workshop: give an agent memory that outlives it

An agent loop whose memory lives on [Walrus](https://walrus.xyz) instead of in the
process. This branch is the starting point: [`src/agent.ts`](src/agent.ts) is a
working chatbot with no memory, and in the workshop you build the memory in, one
step at a time, with the coding agent of your choice. The finished version is on
the [`complete-agent`](../../tree/complete-agent) branch.

By the end, every turn does three things:

| Step         | Call                        | What happens                                                           |
| ------------ | --------------------------- | ---------------------------------------------------------------------- |
| **Recall**   | `memwal.recall({ query })`  | Semantic search over this memory space, ranked by similarity            |
| **Generate** | `anthropic.messages.create` | The recalled memories go into the system prompt as context              |
| **Remember** | `memwal.analyze(input)`     | An LLM extracts discrete facts; each is encrypted and stored on Walrus  |

The interesting property is what happens when you kill the process. Nothing is
lost. The memories are Walrus blobs owned by a Sui account, so the next run finds
them again.

## Setup

```bash
pnpm install          # Node 22 or newer
cp .env.example .env
```

Fill in `.env`:

1. **Walrus Memory credentials.** Generate a delegate key and an account ID from
   the dashboard, then paste both in.

   | Network | Dashboard                                                      | Relayer                                     |
   | ------- | -------------------------------------------------------------- | ------------------------------------------- |
   | mainnet | [memory.walrus.xyz](https://memory.walrus.xyz)                 | `https://relayer.memory.walrus.xyz`         |
   | testnet | [staging.memory.walrus.xyz](https://staging.memory.walrus.xyz) | `https://relayer-staging.memory.walrus.xyz` |

   Credentials are per network. A key generated on one will not authenticate
   against the other, so make sure `MEMWAL_SERVER_URL` matches where you created
   the account.

2. **`ANTHROPIC_API_KEY`** is optional. Without it the harness runs in echo mode:
   recall and remember still work end to end, only the model call is stubbed. That
   is useful if you want to see the memory layer work without wiring up a model.

Check that everything is wired up:

```bash
pnpm mem health               # → ok  ·  relayer 0.1.0
pnpm mem recall "anything"    # → 0 result(s) in "agent-demo"
```

`health` only proves the relayer is reachable. `recall` signs its request with
your delegate key, so an answer with no error means your credentials work too.

## Start: an agent that forgets

```bash
pnpm agent
```

Tell it something about yourself, then ask about it. It knows, because `history`
holds the conversation inside the process. Now quit with ctrl-c, start it again,
and ask the same question:

```
you › how do I take my coffee?
agent › I don't have anything stored about how you take your coffee — tell me and
        I'll remember it.
```

That's what the workshop fixes.

## Build it

Open [`src/agent.ts`](src/agent.ts). There are four TODOs, meant to be done in
order:

| TODO               | What you build                                         | It works when                                                   |
| ------------------ | ------------------------------------------------------ | --------------------------------------------------------------- |
| **1 · Connect**    | A `MemWal` client from the values in `.env`            | `pnpm agent` still starts cleanly                               |
| **2 · Recall**     | Search memory for each input and hand the hits to the model | Recalled facts print before the answer. Seed one first with `pnpm mem remember "I take my coffee black."` |
| **3 · Remember**   | Store the facts in each input with `analyze()`         | `stored n/n on Walrus` prints, and a restarted agent still knows |
| **4 · Corrections** | Make a newer fact beat the one it replaces            | "what package manager do we use?" answers bun, not pnpm         |

Use whichever coding agent you like. Give it the TODO you're on and the
[SDK reference](https://docs.wal.app/walrus-memory/sdk/api-reference), let it
write the code, and read what it wrote before you run it. "Things worth knowing"
below covers the traps you'll hit along the way.

Stuck? The whole solution is one command away:

```bash
git fetch origin complete-agent
git diff main origin/complete-agent -- src/agent.ts
```

## Where you'll end up

```
  namespace agent-demo  ·  claude-opus-5  ·  ctrl-c to quit

you › I always use TypeScript strict mode, and our package manager is pnpm.
agent › Got it — TypeScript strict mode and pnpm noted; I'll assume both in any
        code or setup suggestions going forward.
  ↳ storing   User always uses TypeScript strict mode · User's package manager is pnpm
  ↳ stored    2/2 on Walrus
you › We switched from pnpm to bun last week.
  ↳ recalled  0.68  2026-09-24 13:15:43  User always uses TypeScript strict mode
agent › Noted — I'll use bun for install/run commands from now on, still with
        TypeScript strict mode.
  ↳ storing   User switched from pnpm to bun last week.
  ↳ stored    1/1 on Walrus
```

Now kill it and start it again:

```
you › what should I scaffold a new package with?
  ↳ recalled  0.70  2026-09-24 13:16:59  User switched from pnpm to bun last week.
  ↳ recalled  0.61  2026-09-24 13:16:34  User's package manager is pnpm
  ↳ recalled  0.77  2026-09-24 13:15:43  User always uses TypeScript strict mode
agent › Go with bun — you switched over last week, so `bun init` (or `bun create`)
        keeps the new package consistent with the rest of your setup. Just make
        sure `strict: true` is in the generated tsconfig, since bun's default
        template is looser than you'd want.
```

That second run is a brand-new process with an empty history array. The memories
came back over the network.

Look at the order, too. The pnpm fact is the closer match (0.61 against 0.70),
but the correction comes first because it was written later. That is
`sort: "recent"`, covered below.

## Poke at the memory directly

[`src/mem.ts`](src/mem.ts) is a small CLI for working with the memory space
without the agent in the way:

```bash
pnpm mem health                                # relayer reachable (no auth)
pnpm mem recall "what do you know about me?"   # scores + blob IDs
pnpm mem remember "I take my coffee black."    # blocks until indexed
pnpm mem restore 50                            # rebuild the index from Walrus
```

## Things worth knowing

**Pass `serverUrl` explicitly.** The SDK has a default, but being explicit keeps
it obvious which network a given run is writing to, and lets you move between
mainnet and testnet by editing `.env` rather than code.

**Namespaces are opaque, flat and exact-match.** `agent-demo` and `Agent-Demo`
are two different memory spaces, and `chat/user-42` is a single label rather than
a path. Recall is scoped to `owner + namespace` in SQL, so a cross-namespace read
is not filtered out of the results, it never happens.

**`remember` appends, it never upserts.** Storing the same sentence twice gives
you two entries that both surface in recall. Deduplicate before writing if that
matters to you.

It also means you can't update a fact in place. A correction is just a newer
fact that contradicts an older one, and on relevance alone the older one often
wins, because it states the thing you're asking about more directly. Recall with
`sort: "recent"` fixes that: it over-fetches candidates, then orders them by
write time, so the newest match comes first. That's TODO 4, and it's why the
finished agent prints each memory's write time. One catch: `maxDistance` is applied
before the sort, so a cutoff tight enough to drop the correction serves you the
stale fact with no warning.

**Recall has no relevance floor, so calibrate the cutoff yourself.** Recall
returns the closest K matches, which means a small namespace will hand back
filler simply because it is the closest thing available. That is what recall's
`maxDistance` option is for.

The right cutoff depends on your data. Measured for this example, with
natural-language questions against short stored facts:

| Query                                          | `User prefers pnpm over npm` | `…TypeScript strict mode` | unrelated sentence |
| ---------------------------------------------- | ---------------------------- | ------------------------- | ------------------ |
| "what package manager should I use?"           | 0.525                        | 0.776                     | 0.986              |
| "how do I like my TypeScript projects set up?" | 0.615                        | 0.335                     | 0.858              |
| "what should I scaffold a new package with?"   | 0.692                        | 0.767                     | 0.866              |
| "set up a new package in this repo"            | 0.739                        | 0.815                     | 0.869              |

Relevant hits land around **0.33–0.82** and unrelated ones mostly at **0.86+**,
but not always: in later runs, short facts of the same `User …` shape scored
0.77 against questions that had nothing to do with them. The ranges overlap, so
no cutoff is clean.

The finished agent defaults to `0.8`, because a dropped match is silent while a
stray one is just noise the model is told to ignore, and reads
`MEMWAL_MAX_DISTANCE` from `.env` to override it. `0.7` is cleaner when you control how the questions are
phrased, as in a scripted demo. Either way, measure against your own corpus
rather than reusing these numbers.

**Durable writes take 20–30 seconds.** `analyze()` and `remember()` return as
soon as the job is accepted, so the loop stays responsive, but the embed →
encrypt → upload → index pipeline runs in the background. Anything that waits for
durability (`rememberAndWait`, `analyzeAndWait`, `waitForRememberJobs`) will sit
for that long. Budget for it in UI work.

**The delegate key in `.env` is a real credential.** It can read and write every
memory on the account until you revoke it from the dashboard. Keep it
server-side. Each account supports 20 delegate keys, so give each app its own and
revoke individually.

## Taking this further

- **Refusal fallbacks.** Add server-side fallbacks to the model call so a declined
  request is retried rather than surfacing as an empty response:

  ```ts
  const reply = await anthropic.beta.messages.create({
    model: "claude-opus-5",
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // ...
  });
  ```

- **Idempotent writes.** `remember` and `rememberAndWait` take an
  `idempotencyKey`, which collapses a retried write onto the original job rather
  than paying for a second one:

  ```ts
  await memwal.rememberAndWait(fact, NAMESPACE, { idempotencyKey: `${turnId}:0` });
  ```

  That covers transport retries. It does not deduplicate by content, so an
  at-least-once job queue still needs a key you control.
- **Multi-tenant apps.** One namespace per user (`myapp-<wallet>`) if a single
  account serves many users. See the
  [multi-tenant cookbook](https://docs.wal.app/walrus-memory/sdk/cookbook-multi-tenant).
- **Client-side encryption.** If the relayer should never see plaintext, use
  [`MemWalManual`](https://docs.wal.app/walrus-memory/sdk/usage/memwal-manual),
  which embeds and encrypts on the client.

## Docs

- [Walrus Memory documentation](https://docs.wal.app/walrus-memory)
- [TypeScript SDK reference](https://docs.wal.app/walrus-memory/sdk/api-reference)
- [`@mysten-incubation/memwal` on npm](https://www.npmjs.com/package/@mysten-incubation/memwal)

## License

Apache 2.0. See [LICENSE](LICENSE).
