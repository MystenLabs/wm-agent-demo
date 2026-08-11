# Minimal agent harness with portable memory

An agent loop whose memory lives on [Walrus](https://walrus.xyz) instead of in the
process. [`src/agent.ts`](src/agent.ts) is the whole thing, and it is short enough
to read in one sitting.

Every turn does three things:

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
pnpm install
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

Confirm the relayer is reachable:

```bash
pnpm mem health          # → ok  ·  relayer 0.1.0
```

## Run

```bash
pnpm agent
```

```
  namespace agent-demo  ·  claude-opus-5  ·  ctrl-c to quit

you › I prefer pnpm over npm, and I always use TypeScript strict mode.
agent › Noted — pnpm and strict mode it is.
  ↳ storing   User prefers pnpm over npm · User always uses TypeScript strict mode
  ↳ stored    2/2 on Walrus
```

Now kill it and start it again:

```
you › what should I scaffold a new package with?
  ↳ recalled  0.69  User prefers pnpm over npm
  ↳ recalled  0.77  User always uses TypeScript strict mode
agent › Use `pnpm init` and set up TypeScript with `strict: true` in your
        tsconfig — matching your usual setup.
```

That second run is a brand-new process with an empty history array. The memories
came back over the network.

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

**Recall has no relevance floor, so calibrate the cutoff yourself.** Recall
returns the closest K matches, which means a small namespace will hand back
filler simply because it is the closest thing available. That is what
`maxDistance` in [`src/agent.ts`](src/agent.ts) is for.

The right cutoff depends on your data. Measured for this example, with
natural-language questions against short stored facts:

| Query                                          | `User prefers pnpm over npm` | `…TypeScript strict mode` | unrelated sentence |
| ---------------------------------------------- | ---------------------------- | ------------------------- | ------------------ |
| "what package manager should I use?"           | 0.525                        | 0.776                     | 0.986              |
| "how do I like my TypeScript projects set up?" | 0.615                        | 0.335                     | 0.858              |
| "what should I scaffold a new package with?"   | 0.692                        | 0.767                     | 0.866              |
| "set up a new package in this repo"            | 0.739                        | 0.815                     | 0.869              |

Relevant hits land around **0.33–0.82** and unrelated ones at **0.86+**, so this
example uses `0.8`. Short facts embedded at this length are not cleanly
separable, so expect some overlap either way, and measure against your own corpus
rather than reusing this number.

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

- **Idempotent writes.** The relayer does not deduplicate, so an at-least-once job
  queue will store the same memory twice. Gate writes on a key you control.
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
