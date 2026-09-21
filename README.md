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
- **The activity feed is minimal.** Without an indexer it shows which transactions
  touched the allowance's address and whether the network accepted each one — no
  amounts, no refusal reasons. It is the history of an *address*: cancelling closes the
  account, the same seeds derive the same address again, and an older row may belong to
  a permission that no longer exists. The screen says so.
- **A one-off allowance does not record what it has already spent.** The account holds
  only the remainder, and the card says that in words rather than showing a zero.
- **Nothing is hosted.** Everything runs on a laptop; there is no indexer, no push
  notifications and no way to grant an allowance from the interface yet — allowances
  are seeded by `merchant-sim`.

## Layout

```
apps/web            React 18 + Vite 7 · wallet-standard connection, list, card, cancel flow
apps/api            Hono 4 · read-only over the network, shared Zod contracts, 60 req/min
packages/chain      @solana/kit 7.1.1 · account decoding, PDA derivation, instruction builders
packages/shared     Zod schemas and error format used by both sides of the API
packages/db         Drizzle schema (empty until the indexer exists)
tools/merchant-sim  devnet-only test merchant: `whoami`, `charge`, `plan`
tests               devnet campaigns and the allowance seeder
```

The three Solana packages are pinned exactly, without `^`, through a pnpm catalog:
`@solana/kit 7.1.1`, `@solana/react 7.1.1`, `@solana/subscriptions 0.5.0`. Raising kit to
8 breaks the SDK silently at dependency resolution; a test guards the resolved versions.

## Running it

Requirements: Node ≥ 22, pnpm 9.

```bash
pnpm install
cp .env.example .env      # then fill in SOLANA_RPC_URL and USDC_MINT
pnpm gate                 # lint → typecheck → test; must be green before every commit
pnpm dev                  # api + web
```

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

## Hosting

`apps/web` is a static bundle and deploys to **GitHub Pages** from
`.github/workflows/pages.yml` on every push to `main`: the gate runs first, then the
build, then the deploy. Pages serves files only, so the API has to live elsewhere and be
named in the repository variable `API_URL`; the API, in turn, must list the site's origin
in `CORS_ORIGINS`. A build in `api` mode with no `API_URL` is refused, not deployed. To
publish the invented-data demo on purpose, set `DATA_SOURCE=mock`.

One-time setup: *Settings → Pages → Source: GitHub Actions*. The page is served under
`/<repository name>/` unless `PAGES_BASE_PATH` says otherwise (a custom domain wants `/`).

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
