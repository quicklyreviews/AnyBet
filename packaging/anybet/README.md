# AnyBet — bet on anything, resolved by GenLayer consensus

**Track:** Prediction Markets & Real-World Settlement — Agent Tank hackathon
(`https://portal.genlayer.foundation/agent-tank/hackathon`)

**Demo:** <https://anybet.onrender.com/anybet.html> — the overview.
The app, where you open markets, bet, resolve and collect, is at
[`/app.html`](https://anybet.onrender.com/app.html).

**Contract:** [`0x99F7ECE24CdfFb9Eb5C7493Cb6bAC42DAc3B3774`](https://explorer-studio.genlayer.com/address/0x99F7ECE24CdfFb9Eb5C7493Cb6bAC42DAc3B3774)
on GenLayer StudioNet, chain 61999 — every market, every bet on its book, and
the reasoning the validators agreed on, is readable there without trusting this
repository, or the link above, at all. The first deployment,
[`0xffB459Ee6a6332dC3c412ff53Fa57413049B5149`](https://explorer-studio.genlayer.com/address/0xffB459Ee6a6332dC3c412ff53Fa57413049B5149),
still holds the first end-to-end runs and is unchanged.

## Try it in four steps

1. **Connect a wallet** in the app. StudioNet is added for you; the bar at the
   top names the chain, the contract and your balance, and turns amber if the
   wallet is anywhere else.
2. **Take test GEN** from the checklist and deposit some. It is a test network
   and the GEN is free.
3. **Open a market.** Click the *ISS over the north* template — it reads the
   station's live position and closes in six minutes — or bet on one that is
   already open. Bets are YES or NO, parimutuel.
4. **Resolve it** once the countdown ends. Or resolve somebody else's: markets
   past their close time show **Resolve now**, and anyone may press it. That
   is the point.

If you won, **Collect** moves the payout to your wallet. Watch the balance in
the top bar rather than your wallet's own screen: the transfer is a second
transaction that lands about a minute later.

A prediction market with no topic list. Write a question in plain English, say
how it should be judged and where to look. When it closes, independent
validators fetch the evidence themselves and have to agree before a single coin
moves — and if they cannot tell, every stake comes back in full.

## The problem

Prediction markets are gated by resolution cost. Polymarket-scale markets need
an operator to define, monitor and settle each one, so only questions worth that
overhead exist — and "will BTC be up in 5 minutes" is covered many times over on
GenLayer already. Everything below that line is unserved: *will it rain in
Hanoi tomorrow*, *will the next 24 hours have more earthquakes than the last*,
the bet two friends want to settle without trusting each other.

The blocker was never the money plumbing. It was that settling an arbitrary
question means reading evidence and exercising judgment, which a deterministic
chain cannot do and an oracle can only do by being trusted. On GenLayer the
validators do it themselves, and a market carries its own criteria.

## The three verdicts

| Outcome | What happens |
| --- | --- |
| `YES` / `NO` | The pool, minus a 3% fee, splits across the winning side in proportion to stake. |
| `UNKNOWN` | Absent, partial or ambiguous evidence. **The market voids and every stake is refunded in full.** |
| one-sided | Nobody took the other side. There is no counterparty to win from, so it voids and refunds, and no fee is charged. |

`UNKNOWN` is the design, not an error path: a wrong `UNKNOWN` only delays a
market, while a wrong `YES` pays the wrong person. The prompt tells the
resolver to reach for it whenever the evidence is thin. The first market ever
resolved on-chain proved the path works — see *Verified on StudioNet*.

## Why this equivalence strategy

`strict_eq` is the obvious choice and it is wrong here. It demands
byte-identical output across validators — fine for a price feed, impossible for
a judgment, since two honest readings of the same evidence will word their
reasoning differently while agreeing completely on the verdict.

So the comparison is narrowed to the one field that has to match for consensus
to mean anything:

```python
def validator_fn(leaders_res) -> bool:
    mine   = leader_fn()                 # I fetch the sources myself
    theirs = leaders_res.calldata        # what the leader concluded
    return mine["outcome"] == theirs["outcome"]

result = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
```

`reasoning` is left free to vary and is stored alongside the verdict, so every
settled market carries the validators' own account of why.

## Project layout

```
contracts/any_bet.py                         the Intelligent Contract (Python, GenVM)
frontend/index.html + anybet-home.js         the overview - live figures, read-only
frontend/app.html + app.js                   the app - open, bet, resolve, collect
frontend/templates.js                        the worked market questions, built from live data
frontend/wallet.js                           wallet, network check, and the request queue
frontend/brand.js                            the mark, as SVG geometry shared by header and favicon
HUONG-DAN.md                                 Vietnamese user guide
SUBMISSION.md                                the portal write-up
tests/direct/conftest.py                     mock `genlayer` module, no GenVM needed
tests/direct/test_any_bet.py                 fast unit tests (18)
tests/integration/test_deploy_studionet.py   deploy + state on a real network (3)
tests/integration/test_resolution_consensus.py  the one that matters (1, ~6.5 min)
tests/integration/test_book_studionet.py     the book, audited against real data
tests/integration/probe_sources.py           which URLs can validators actually reach
tests/integration/demo_run.py                seeds a market with real, independent bettors
tests/integration/demo_claim.py              the cohort collects what it won
tests/integration/resolve_closed.py          resolves anything past its close time
```

## Running it

```bash
python -m http.server 5174 --directory frontend
```

Then open <http://localhost:5174>. There is no build step — the import map
pulls `genlayer-js` from a CDN.

`index.html` is the overview: read-only and wallet-free, because a page that
opens a wallet prompt before saying what the product is has the order
backwards. Its figures and market cards are read off the chain on load rather
than written into the HTML, so it is either current or honestly blank.

`app.html` is the app. A sticky bar names the chain, the chain id, the contract
and the connected account, and turns amber the moment the wallet is on anything
else. "How to take part" is a live checklist whose ticks come from real state.
Markets come first, ordered by what needs attention — open, then awaiting
resolution, then history — and each leads with the implied price: in a
parimutuel pool the share of money on a side *is* the crowd's probability.

**Templates built from live data.** Eleven chips fill the create form, grouped
by reach — and the grouping is the argument:

| Group | Examples | Source |
|---|---|---|
| **Planet** | earthquakes worldwide, ISS north of the equator, crew in orbit | USGS, Open Notify |
| **Markets** | Bitcoin price, total crypto market cap | CoinGecko, Coinbase, Kraken |
| **Cities** | rain in London, Tokyo heat, rain in Hanoi, Hanoi heat, Hanoi PM2.5 | Open-Meteo |
| **Code** | GitHub stars | GitHub API |

The same contract settles a question about the whole planet, one about a single
city, and one about a single repository, and nothing in it changes between them.
Each template *reads its source first and sets the threshold from what it
finds*, so it lands on the knife edge instead of on a number that aged into a
foregone conclusion. **Check sources now** shows what a URL returns before
anyone stakes on it.

## Tests

```bash
genvm-lint lint contracts/any_bet.py --json                                       # clean
pytest tests/direct -q                                                            # 18, seconds
gltest tests/integration/test_deploy_studionet.py --network studionet -v -s       # 3
gltest tests/integration/test_resolution_consensus.py --network studionet -v -s   # 1, ~6.5 min
```

The direct tests prove the accounting against a mocked `genlayer` module,
including a solvency invariant walked through a full round: what the ledger
owes plus the fees it has booked always equals what came in minus what went
out. The consensus test proves the part that cannot be mocked.

## Verified on StudioNet

Not a claim — a run. `tests/integration/test_resolution_consensus.py`, chain
61999:

```
Market 1 created, closes at 1788542374
0xdF70347F... bet YES        (0.5 GEN)
0x53944603... bet NO         (0.5 GEN)
Waiting 282s for the betting window to close...
Resolving -- real web fetch + real LLM, across independent validators...
Outcome: YES / PAID
Reasoning: Multiple sources confirm BTC/USD is well above $1: CoinGecko shows
$79,565, Coinbase shows $79,590.955, and Kraken shows $79,600.40, all far
exceeding the $1 threshold specified in the resolution criteria.
Alice collected 970000000000000000 wei; balance now 1470000000000000000
1 passed in 391.10s
```

Independent validators each fetched the sources over the real internet, each ran
the resolution prompt against a real model, and the transaction reached ACCEPTED
— which it only does if their normalized outcomes matched. The 1 GEN pool paid
out minus the 3% fee, to the wei.

The first attempt sourced the market from Binance and resolved **UNKNOWN**:

> The Binance API returned an error indicating the service is unavailable from a
> restricted location, so no price field was provided in the source data.

The validators agreed on UNKNOWN, the market voided, and every stake was
refundable in full. The safety path did in production exactly what it was
designed to do.

On the live contract the vault reconciles exactly: what it holds equals what it
owes plus booked fees, to within 8 wei of floor-division residue across 17
winning bets — bounded by a test rather than rounded away. The book audit reads
every market back off the chain: 34 bets and 83.97 GEN of payouts reconciled
against the pools the contract reports.

## Things that bit, written down

**StudioNet rate-limits, and disguises it as CORS.** Reads get 300 a minute,
transactions far fewer. When it refuses it answers **429 without CORS headers**,
so the browser reports a CORS policy block that does not exist. Calls are now
serialised onto one lane with a floor on the gap between them, a 429 triggers a
real backoff honouring `Retry-After`, and polling stops while the tab is hidden.

**Validators are geo-blocked from some sources, and the source lies about it.**
Binance answers GenLayer's validator nodes with **HTTP 200 and an error body**.
`tests/integration/probe_sources.py` deploys a throwaway contract that reports
what a validator actually receives, so picking a source takes 80 seconds
instead of a 6-minute market cycle. Every template URL was checked with it.

**Contract source must be pure ASCII.** `genlayer-py` hex-encodes the source
ASCII-only, and an em dash in a comment breaks deployment *after* the contract
has already been created.

**`time.time()` is non-deterministic and will not pass the linter.** The
contract's clock is `datetime.datetime.now()`, which `genvm-lint` accepts and
`gltest`'s `vm.warp()` can patch. Confirmed on-chain: the stored `created_ts`
reaches consensus.

**A comma inside a URL.** The sources box is comma-separated and Open-Meteo's
multi-field form puts a literal comma inside a URL, so a template split in half.
The templates now request one field per URL, and the form warns when a source
does not start with `http`.

## Deploying

There is no backend, so any static host works. `render.yaml` is a Render
blueprint — point Render at this repository as a Blueprint and the service is
created with the publish path and headers already set. `.github/workflows/pages.yml`
publishes `frontend/` to GitHub Pages on every push to `main` instead, if you
prefer: set *Settings → Pages → Source* to **GitHub Actions** once.

One consequence of having no keeper: a market that closes sits at *awaiting
resolution* until somebody clicks **Resolve now**. That is correct rather than
broken — the contract deliberately gives no one special authority over
settlement — but a deployment nobody visits will accumulate unresolved markets.
`tests/integration/resolve_closed.py` is the operator's version of that button,
with no more authority than the button has.

## Known gaps

- **State grows without bound.** Markets are never pruned, so the JSON blob
  the contract stores gets monotonically larger. Fine for a hackathon, not
  fine forever.
- **No anti-spam bond on opening a market.** Nothing stops a flood of tiny
  markets that nobody will bet on.
- **Two templates use plain `http://` sources** (ISS position, crew in orbit),
  so on an HTTPS deployment the browser blocks the in-form preview for them as
  mixed content. The markets still resolve, because validators fetch
  server-side.
- **A few wei per settled market go to nobody.** Floor division on each
  winner's share leaves a residue that no one can claim. Economically nothing;
  asserted rather than ignored so that it cannot quietly grow.
