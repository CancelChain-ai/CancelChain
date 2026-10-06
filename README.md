# CancelChain

A subscriptions dashboard for Solana. Connect a wallet and see every recurring-charge
permission ever granted from it — whichever app granted it — then revoke any of them
with one signature, so that the next attempt to charge is refused **by the protocol**,
not by us.

> **Status: devnet only.** The on-chain behaviour below has been measured on devnet.
> There is no mainnet deployment, no hosted instance, and no real merchant on the other
> side — see *What this does not prove*.

## What it stands on

CancelChain writes no on-chain code. It is built on top of the
**Subscriptions Delegation Program** (`De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`,
audited by Cantina/Spearbit), through its official SDK `@solana/subscriptions`. That is
a deliberate boundary, not a gap: a program that holds other people's money should be
one that has been audited, and this repository contains no Anchor, no Rust and no test
validator.

Three consequences follow, and the code is built around them:

- **Transactions are signed only in the browser.** The API has no wallet. Its one job
  with respect to the network is to read it and to hand the browser a recent blockhash,
  so that the RPC provider key never ends up in a public bundle.
- **The network outranks any stored state.** Before a card is shown and before any
  action is taken, the allowance is re-read from the chain. A disagreement between the
  stored copy and the network is shown, never hidden. A revoked allowance is simply a
  closed account: it disappears from the list instead of sitting there labelled
  "cancelled".
- **Every instruction builder has a round-trip test** (encode → decode → equality,
  including fields that were left unset). The encoder writes a silent zero for a missing
  field, and every builder here moves someone else's money.

## What has been measured

All figures below were measured on devnet on 2026-09-02, against our own wallets, our
own mint and an allowance we granted ourselves. Each measurement runs a **control
charge first**, which must succeed — otherwise a run with no tokens or a wrong key would
produce the same zero for the wrong reason.

| Claim | Budget | Measured |
|---|---|---|
| Successful charges after the allowance was revoked | 0 of ≥ 200 attempts | **0 / 200** — every refusal was `InvalidAccountOwner`, i.e. the account no longer exists |
| Charges exceeding the per-period ceiling | 0 of ≥ 200 attempts | **0 / 200** — every refusal was the program's own ceiling error, on an amount one base unit over the remainder |
| Clicks / signatures to cancel from the list | ≤ 2 / 1 | **2 / 1** — clicks and the built transaction on real devnet data; the signature itself is a property of the builder (one signer slot) and has not been exercised with a browser wallet extension |
| Card fields visible without leaving the screen (recipient, ceiling, period, spent, next charge) | 5 of 5 | **5 / 5** |

Only attempts the network actually judged count as attempts. A `429` from a public node
is not a refusal by the protocol and is not counted.

## What this does not prove

Said plainly, because a demo creates a false sense of proof if it is not:

- **There are no real merchants.** The merchant role is played everywhere by
  `tools/merchant-sim`, and nothing here shows that an actual merchant is willing to be
  paid this way.
- **The merchant catalogue, plans and any names on screen are invented.** Only the
  on-chain side is real.
- **The activity feed is minimal.** Until the indexer stores what it decodes, the feed
  shows which transactions touched the allowance's address and whether the network
  accepted each one — no amounts, no refusal reasons. It is the history of an *address*: cancelling closes the
  account, the same seeds derive the same address again, and an older row may belong to
  a permission that no longer exists. The screen says so.
- **A one-off allowance does not record what it has already spent.** The account holds
  only the remainder, and the card says that in words rather than showing a zero.
- **The indexer stores events, but nothing reads them yet.** `apps/indexer` follows the
  program live, decodes each transaction into charges, refusals, cancellations (with the
  date charges stop) and closures, and writes them to Postgres with a cursor it resumes
  from. Each refusal gets a category from the pair (failing program, code); a code we do
  not map stays uncategorised and is logged, never filed under a catch-all. On a sample
  of 52 real devnet refusals, all 52 got a category. The API serves that feed at
  `/v1/allowances/:pda/events`, with whether the indexer knows the permission and whether
  its heartbeat is fresh; the card does not show it yet and still lists the address's
  transactions. A permission closed before the indexer first saw it gets no history:
  there is nothing left on chain to describe it.
- **The hosting is written down, not yet running.** `render.yaml` describes one free
  Render web service with the indexer inside the API process (`RUN_INDEXER=true`), woken
  every five minutes by an uptime monitor on `HEAD /health`; the page on GitHub Pages
  still shows invented data until that service exists — see *Hosting*.
- **The feed keeps 90 days.** Older events are deleted from our store once a day
  (`EVENTS_RETENTION_DAYS`, never fewer than 90); the card names that depth and, where a
  permission's history is cut, the date of the cut with a link to the full trail on the
  network.
- **Without a WebSocket, only open pages are followed.** `INDEXER_USE_WS=false` stops
  reading the whole program and instead polls, every 15 s, the wallets that have a page
  open: their subscription authority and each permission they hold. A wallet nobody is
  looking at is caught up when its page opens again, so its feed has no gap, but a
  refused charge reaches the feed and the push only then, not when it happened. With
  the WebSocket on, the same catch-up runs every 15 s as a watchdog, so a socket that
  dies without closing costs at most one interval.
- **Push reaches only browsers that have Web Push.** Checked end to end in Chrome through
  Google's push service. iOS delivers Web Push only to a web app added to the home
  screen, and this page is not set up as one; Safari there shows the switch as
  unavailable, and the feed carries everything a push would have said.

## Layout

```
apps/web            React 18 + Vite 7 · wallet-standard connection, list, card, cancel flow
apps/api            Hono 4 · read-only over the network, shared Zod contracts, 60 req/min
apps/indexer        logsSubscribe worker (or 15 s polling of open wallets) · transaction → permission events → Postgres, resumes from a cursor
packages/chain      @solana/kit 7.1.1 · account decoding, PDA derivation, instruction builders
packages/shared     Zod schemas and error format used by both sides of the API
packages/push       Web Push for api and indexer: VAPID from env, payload, push-service answers
packages/db         Drizzle schema (empty until the indexer exists)
tools/merchant-sim  devnet-only test merchant: `whoami`, `charge`, `plan`
tests               devnet campaigns and the allowance seeder
```

The three Solana packages are pinned exactly, without `^`, through a pnpm catalog:
`@solana/kit 7.1.1`, `@solana/react 7.1.1`, `@solana/subscriptions 0.5.0`. Raising kit to
8 breaks the SDK silently at dependency resolution; a test guards the resolved versions.

## Running it

Requirements: Node ≥ 22.9, pnpm 9. The version floor is not decorative: `pnpm dev`
starts the API with `--env-file-if-exists`, which older 22.x does not have.

```bash
pnpm install
cp .env.example .env      # then fill in SOLANA_RPC_URL, USDC_MINT, JWT_SECRET, AUTH_DOMAIN
pnpm gate                 # lint → typecheck → test; must be green before every commit
pnpm dev                  # api + web
```

**One file, two readers.** The root `.env` serves both apps under `pnpm dev`: the API
reads it through `--env-file-if-exists`, and Vite is pointed at the same directory
(`envDir` in `apps/web/vite.config.ts`). `start` deliberately takes no file — on a host
the environment comes from the service, and the Pages build passes `VITE_*` as build
environment rather than as a file.

That one file holds `JWT_SECRET` and `DATABASE_URL` next to the `VITE_*` keys. Only the
prefixed ones reach the browser; `envPrefix` is written out in the config instead of
being inherited, and `apps/web/vite.config.test.ts` fails if it ever widens. A build with
a sentinel secret in the root `.env` was checked against `dist/`: the bundle carries
`{VITE_API_URL, VITE_DATA_SOURCE}` and nothing else.

Two variables are **not** read from the file: `API_PROXY_TARGET` and `BASE_PATH`. Vite
puts nothing from `.env` into `process.env`, and those two are read there — they are
launch and build parameters, given on the command line.

The API refuses to start without `JWT_SECRET` (32 characters or more) and `AUTH_DOMAIN`,
rather than accepting an empty secret and answering `401` to an honest signature later.

**Notifications are optional.** With `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and
`VAPID_SUBJECT` set (`npx web-push generate-vapid-keys`), the API and the indexer send
Web Push: a charge due `PUSH_UPCOMING_LEAD_HOURS` ahead (24 by default) and a refused
charge as soon as it is stored. With none of them, both run without push, the page says
so, and every event is still in the feed. Two of three is a refusal at start — as is a
public key that is not the half of the private one. The browser takes the public key
from `GET /v1/push/key`, so a new pair needs no new Pages build.

`VITE_DATA_SOURCE=mock` runs the web app on invented data with no network behind it —
useful for looking at the screens, useless as evidence. The default is `api`.

### Measuring it yourself

The devnet campaign needs two keypairs outside the repository (merchant and owner), some
devnet SOL on each, and an allowance to destroy — every run revokes the one it measures:

```bash
pnpm --filter @cancelchain/e2e seed     # own mint, tokens, authority and allowance
E2E_ALLOWANCE_PDA=<pda> pnpm --filter @cancelchain/e2e test
```

The `E2E_*` variables (owner keypair path, attempts, delay, charge amount) are documented
in `tests/e2e/config.ts`; the merchant's own are in `merchant-sim --help` and
`.env.example`. Without a complete environment the campaign is **skipped with a named
reason**, not failed — a green gate on a machine with no keys must not look like a
measurement. The tools refuse to run against `mainnet-beta`.

The speed criteria (`SC-003`, `SC-006`, `SC-008`, `SC-009`) are measured against the
**deployed** stand — Pages, Render, Supabase — on one wallet holding 100 permissions of
all three kinds. A third keypair owns them (`PERF_OWNER_KEYPAIR_PATH`); `merchant-sim`
funds it, creates and names the plans, and pulls:

```bash
pnpm --filter @cancelchain/e2e perf seed    # bring the wallet to exactly 100, wait for the API
pnpm --filter @cancelchain/e2e perf sc003   # all 100 cards on screen, p95 of 40 first visits
pnpm --filter @cancelchain/e2e perf sc008   # first screen on WebPageTest 3G, CPU ×4, 375 px
pnpm --filter @cancelchain/e2e perf sc006   # a refused charge in the open card's feed
pnpm --filter @cancelchain/e2e perf sc009   # a revocation made elsewhere leaves the open list
```

They need a keyed RPC node and refuse the public one, whose rate limit would be measured
instead of the product. Chrome stable runs them (`PERF_CHROME_PATH`); raw samples go to
`PERF_OUT_DIR`. `sc009` revokes 20 permissions; `seed` grants them back. 3G is a
packet-level proxy (`tests/perf/shaper.ts`), not DevTools throttling, which delays
neither handshakes nor the CORS preflight.

## Hosting

Three free pieces: Supabase for Postgres, one Render web service for the API and the
indexer, GitHub Pages for the page.

**Database — Supabase.** Two connection strings to the same project, and they are not
interchangeable. `DATABASE_URL` is the transaction pooler (port 6543): every query of the
API and the indexer. `DATABASE_LISTEN_URL` is the session pooler (port 5432, same host and
user): the live stream's `LISTEN`, which hears nothing through the transaction pooler, and
the schema migrations. Both connect as `postgres`, the owner of the tables. Every table
has row-level security on with no policy, so Supabase's Data API, which serves the
`public` schema to anyone holding the project's anon key, reads and writes nothing; the
owner is not subject to it, and the application sees no difference.

**API and indexer — Render** (`render.yaml`, a Blueprint). Render's free instance is a
web service only, so the indexer runs inside the API process. With
`MIGRATE_ON_START=true` the API applies every pending migration before the indexer
starts and before the port opens, under an advisory lock; a failed migration stops the
start with the reason in the log. The free plan has no pre-deploy step, so the schema
travels with each push. The instance sleeps after 15 minutes without a request; an
external monitor sending `HEAD /health` every five minutes keeps it up. A GitHub Actions
schedule cannot: GitHub thins frequent schedules out to one run every few hours.

**Page — GitHub Pages** (`.github/workflows/pages.yml`, on every push to `main`: the gate,
then the build, then the deploy). The application is served from `/<repository>/app/`;
the site root forwards there, carrying `?plan=` and `?allowance=` with it, until a
landing page takes its place. Pages serves files only, so the API is named in the
repository variable `API_URL`, and the API lists the site's origin in `CORS_ORIGINS`. A
build in `api` mode with no `API_URL` is refused, not deployed; `DATA_SOURCE=mock`
publishes the invented-data demo on purpose. With a custom domain, `PAGES_BASE_PATH`
becomes `/app/`.

## Rules the code keeps

- No `any`, no non-null assertions — both are lint errors, not conventions.
- Every API boundary is validated with Zod on both sides, from the same schemas.
- Amounts travel as strings: `u64` does not fit in a double, and a ceiling is money.
- A failure is never shown as an empty list. "Nothing can charge this wallet" and "we
  could not read this wallet" are different sentences, and the difference is the product.
- Reasons for a refusal are a finite list. An unknown program error is recorded as
  unknown and logged, not filed under "other".

## Licence

[MIT](LICENSE).
