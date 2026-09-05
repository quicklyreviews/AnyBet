# AnyBet — submission

**Track:** Prediction Markets & Real-World Settlement
**Open idea taken:** *Long-tail and local markets. Cheap resolution lets any two
parties bet on anything.*

---

## One line

A prediction market with no topic list: anyone writes a question in plain
English, says how it should be judged, and AI validators settle it from live
evidence.

## The problem

Prediction markets are gated by resolution cost. Polymarket-scale markets need
an operator to define, monitor and settle each one, so only questions worth that
overhead exist — and "will BTC be up in 5 minutes" is covered many times over on
GenLayer already. Everything below that line is unserved: *will my flight be
delayed*, *did the council approve the permit*, *will England win the test*, the
bet two friends want to settle without trusting each other.

The blocker was never the money plumbing. It was that settling an arbitrary
question means reading evidence and exercising judgment, which is exactly the
thing a deterministic chain cannot do and an oracle can only do by being trusted.

## What GenLayer changes

Resolution stops being an operator function. A market carries its own criteria
and its own sources; at close, every validator independently fetches those
sources over the real internet and runs the same resolution prompt, and the
transaction only lands if their verdicts agree. Judgment becomes a consensus
primitive, so the marginal cost of one more market falls to roughly the cost of
one more transaction — which is what makes long-tail markets possible at all.

## How it works

1. **Create** — a question, the criteria that decide it, a close time, and up to
   three source URLs. No approval, no topic list, no admin.
2. **Bet** — YES or NO, parimutuel: the pool minus a small fee splits across the
   winning side in proportion to stake.
3. **Resolve** — permissionless after close. Validators each fetch and each run
   the prompt; only a matching normalized outcome (`YES`/`NO`/`UNKNOWN`) is
   accepted.
4. **Collect** — winners claim; `claim_all()` sweeps every market at once.

A market **voids and refunds in full, no fee taken**, when the resolver answers
`UNKNOWN`, or when one side never attracted a bet — there is no counterparty to
win from, so taking a fee would be taking money from a bet nobody opposed.

## The equivalence strategy, and why it is the interesting part

`strict_eq` works when validators reproduce byte-identical output. That is right
for a price feed and wrong for a judgment: two honest model calls can word their
reasoning differently while agreeing completely on the verdict. AnyBet uses a
custom leader/validator pair (`gl.vm.run_nondet_unsafe`) that compares **only the
normalized outcome** — the part that must be identical for consensus to mean
anything — and lets the reasoning vary freely. The reasoning is still stored and
shown in the UI, so a settlement is auditable without being unanimous prose.

`UNKNOWN` is a first-class outcome, not an error path. The prompt instructs the
resolver to answer it whenever evidence is absent, partial or ambiguous, on the
grounds that **a wrong UNKNOWN only delays a market, while a wrong YES pays the
wrong person.**

## Verified on StudioNet

Contract `0x99F7ECE24CdfFb9Eb5C7493Cb6bAC42DAc3B3774`, chain 61999 (an earlier deployment, `0xffB459Ee6a6332dC3c412ff53Fa57413049B5149`,
holds the first end-to-end runs; the redeploy added a view that returns a
market's whole book, so the interface can show who is on which side). Full
lifecycle on-chain, no mocks: deposit, bets on both sides, LLM resolution through
validator consensus, parimutuel payout correct to the wei, claim.

```
Outcome: YES / PAID
Reasoning: Multiple sources confirm BTC/USD is well above $1: CoinGecko shows
$79,565, Coinbase shows $79,590.955, and Kraken shows $79,600.40, all far
exceeding the $1 threshold specified in the resolution criteria.
Alice collected 970000000000000000 wei
```

### The run we are proudest of is the one that failed

The first live resolution came back **UNKNOWN**:

> The Binance API returned an error indicating the service is unavailable from a
> restricted location, so no price field was provided in the source data.

Binance geo-blocks GenLayer's validator nodes — and does it with **HTTP 200 and
an error body**, so naive parsing would have read a price out of an error page.
The validators agreed on UNKNOWN, the market voided, and every stake was
refundable in full.

That is the whole safety argument demonstrated in production rather than
asserted in a README: when the evidence is not there, the system refuses to
decide instead of paying the wrong side. A demo that only ever shows the happy
path has not shown this.

## The app

No build step. Markets are readable without signing in; playing needs a wallet,
and that is the only way in. Connecting adds StudioNet to the wallet if it has
never seen it, and test GEN is one button away, so a judge goes from a cold
browser to a placed bet in a couple of minutes.

An earlier build also offered a guest account — a throwaway key in
`localStorage`. It made trying the app easier and it was wrong: it handed people
an account they were never told they had, so opening the site in a second
browser left the money in the first one unreachable. That happened to us during
development. A prediction market should not ship that as its default, so it is
gone; the page now holds no keys at all and the wallet signs everything.

The panel names the network the wallet is actually on, and a write on the wrong
chain is refused up front rather than signed and left to fail a minute later.

The UI is careful about two more things it would be easy to lie about: a
one-sided market is quoted as **a refund, not as odds** (a multiplier derived
from the only funded pool would advertise a payout below 1x that can never
happen), and "voided" always says *which kind* — `Voided - YES, unopposed` is a
different event from `Voided - undecidable`.

## Solvency, checked rather than claimed

A vault that can owe more than it holds is broken however good its payout maths
looks. Direct tests walk a full round asserting the ledger balances at every
step; an integration test compares that ledger against the balance the chain
reports. On the live contract they reconcile to 8 wei - the residue floor
division leaves when each winner's share is computed, owed to nobody and
withdrawable by nobody, bounded by a test rather than rounded away.

## Findings worth passing back to the ecosystem

Three things cost real time and are not in the docs:

1. **Use `datetime.datetime.now()`, never `time.time()`,** for contract time.
   `genvm-lint` raises W002 on the latter and accepts the former, and gltest's
   VM implements `vm.warp()` by patching `datetime.datetime` — so `time.time()`
   is also untestable. Confirmed on-chain.
2. **Contract source must be pure ASCII** if you deploy with `genlayer-py`. It
   hex-encodes source via `eth_utils.encode_hex`, which is ASCII-only, so one em
   dash in a comment breaks schema fetching — and it fails *after* a successful
   deploy, as a misleading "Failed to get schema from all clients".
   `genlayer-js` has no such limit.
3. **Binance is unreachable from validators.** CoinGecko, Coinbase and Kraken
   work. `tests/integration/probe_sources.py` deploys a throwaway
   fetch-and-report contract so any new source can be checked in ~80 seconds
   instead of a 6-minute market cycle.

## State of it

Working: contract with `genvm-lint check` fully clean — lint and semantic
validation, 20 methods — 18 direct tests, integration tests on StudioNet, a
verified solvency invariant, four markets settled by validator consensus across
34 independent wallets, and a frontend exercised end to end in a browser.

Not done: the wallet path has never met a real MetaMask, only a stand-in
provider reproducing its behaviour; market pruning for unbounded state growth
(state is re-serialised on every write, which is fine at this scale and will not
be at a few hundred markets); and any anti-spam bond on market creation. All
three are known, and none are load-bearing for the idea.
