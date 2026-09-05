# AnyBet — bet on anything, resolved by GenLayer consensus

**Track:** Prediction Markets & Real-World Settlement — Agent Tank hackathon
(`https://portal.genlayer.foundation/agent-tank/hackathon`)

Basic crypto up/down markets are covered on GenLayer (see
[GenPredict](https://github.com/) — a live parimutuel BTC/ETH/... market).
AnyBet is the next layer the track asks for: **anyone bets on anything**, not
just a fixed asset list, because resolution is no longer "compare two numbers"
but "ask an AI validator quorum to read the evidence and decide."

## How it works

1. **Create a market** — a natural-language question, the criteria that should
   decide it, a close time, and up to 3 source URLs the resolver should check
   (a news page, an API endpoint, anything public). No admin approval, no
   fixed topic list.
2. **Bet YES or NO** — parimutuel, like a normal prediction market: the pool
   minus a small fee splits across the winning side in proportion to stake.
3. **Resolve** — after close, anyone calls `resolve_market()`. Every validator
   independently re-fetches the same source URLs and re-runs the same
   resolution prompt against an LLM; only a matching normalized outcome
   (`YES` / `NO` / `UNKNOWN`) is accepted through GenLayer's **Equivalence
   Principle**. `UNKNOWN` — insufficient or ambiguous evidence — voids the
   market and refunds everyone in full, on purpose: a wrong `UNKNOWN` only
   delays resolution, a wrong `YES`/`NO` pays the wrong side.
4. **Claim** — a deliberate step, not an automatic payout, so a win is
   something you noticed. `claim_all()` sweeps every market at once.

A market also voids if one side never attracted a single bet — there is no
counterparty to win from, so charging a fee (or paying out) would be wrong.

## Why this is the right equivalence strategy

`strict_eq` only works when every validator can reproduce byte-identical
output — fine for a price feed, wrong for a judgment call, since two honest
LLM calls can phrase their reasoning differently while still agreeing on the
verdict. AnyBet uses a **custom leader/validator function**
(`gl.vm.run_nondet_unsafe`) that compares only the normalized `outcome` field
across independent runs — the part that has to be identical for consensus to
mean anything — and lets `reasoning` vary freely.

## Project layout

```
contracts/any_bet.py                        the Intelligent Contract (Python, GenVM)
frontend/index.html + home.js               the home page - live figures, read-only
frontend/app.html + app.js                  the app - no build step, open and use
frontend/templates.js                       the worked examples, grouped by reach
frontend/brand.js                           the mark, as SVG geometry shared by header and favicon
HUONG-DAN.md                                Vietnamese user guide
tests/direct/conftest.py                    mock `genlayer` module, no GenVM needed
tests/direct/test_any_bet.py                fast unit tests (13)
tests/integration/test_deploy_studionet.py  deploy + state on a real network (3)
tests/integration/test_resolution_consensus.py  the one that matters (1, ~6.5 min)
tests/integration/test_book_studionet.py    the book, read back through GenVM's codec
tests/integration/probe_sources.py          which URLs can validators actually reach
tests/integration/demo_run.py               seeds a market with real, independent bettors
tests/integration/demo_claim.py             the cohort collects what it won
tests/integration/resolve_closed.py         resolves anything past its close time
```

## Running the app

```bash
python -m http.server 5174 --directory frontend
```

Then open <http://localhost:5174>. There is no build step.

Two pages. **`index.html` is the home page** — read-only and wallet-free, because
a landing page that opens a wallet prompt before saying what the product is has
the order backwards. Its figures and its market cards are read off the chain on
load rather than written into the HTML: a landing page quoting numbers that were
true the day somebody typed them is a brochure, and this one is either current or
honestly blank. Its markets heading follows what is actually below it —
*Open right now* when there are open markets, *Recently settled* when there are
not, because promising the first while showing the second is the page telling a
small lie about itself.

**`app.html` is the app.** Markets are readable straight away; playing needs a
wallet.

### Signing in is mandatory, and it is a real wallet

Nothing that moves money works signed out — betting, creating a market,
depositing, collecting. Reading is wide open: every market, pool and verdict is
visible before you commit to anything, because asking someone to sign in before
they have seen what the thing does is backwards.

There is exactly one way in: **connect a wallet**. An earlier build also offered
a guest account — a throwaway key minted into `localStorage` — which made trying
the app easier and was wrong. It handed people an account they were never told
they had: open the site in a second browser and the money left in the first one
is simply unreachable, which happened during development. A market whose
accounts evaporate with the browser cache is not one anybody should put money
into, and no amount of "back up your key" copy fixes that as a default.

So the page holds no keys at all. The wallet signs every action, and
disconnecting leaves nothing of yours behind.

The panel names the network the wallet is actually on — *GenLayer StudioNet
(61999)* in green, or *Polygon (137) — wrong network* in amber with a **Switch
network** button — and a write on the wrong chain is refused up front rather
than signed and left to fail a minute later. Connecting adds StudioNet to the
wallet if it has never seen it, and test GEN is one button away.

#### What broke the first time, and why

The first wallet build discarded a wallet the user had just approved. Three
faults, all in the same few lines:

1. **The chain switch ran before the account was registered.** Any failure or
   refusal threw out of `connectWallet`, so a network problem silently became a
   connection problem. Connecting and switching are now separate: the account is
   attached first, and a bad chain is reported rather than fatal.
2. **MetaMask's "unrecognised chain" code is often nested** in
   `err.data.originalError.code`, not `err.code`. The top-level-only check meant
   `wallet_addEthereumChain` was never reached and the switch just failed.
3. **`createClient` was given an `endpoint` alongside the `provider`**, unlike
   the call GenPredict uses in production — which is how writes stop being
   signed by the wallet at all.

Adding a network also does not reliably select it, so the switch is re-issued
after the add and the result verified with `eth_chainId`.

> Not yet exercised against a real MetaMask — this browser has no extension. It
> **was** driven end to end against a stand-in provider reproducing MetaMask's
> behaviour, including the nested-4902 shape, a refused switch, and recovery:
> connect on mainnet → add chain → switch → verified on 61999; refuse the switch
> → wallet stays connected, network shown as wrong, deposit refused; switch →
> back to normal. Worth one real click-through anyway.

Verified in a browser against the live contract: faucet, create market, deposit,
bet, resolve, and collect a refund — 2 GEN in, 0.5 staked, market voided, 2 GEN
back.

**A guide, in both languages.** The page opens with a five-step *How to play*
(dismissible, remembered), and [HUONG-DAN.md](HUONG-DAN.md) is the full
Vietnamese walkthrough — install, play, read a verdict, and a table of the
errors people actually hit.

**Templates built from live data.** Eleven chips fill the create form, grouped
by reach — and the grouping is the argument, not decoration:

| Group | Examples | Source |
|---|---|---|
| **Planet** | earthquakes worldwide, ISS north of the equator, crew in orbit | USGS, Open Notify |
| **Markets** | Bitcoin price, total crypto market cap | CoinGecko, Coinbase, Kraken |
| **Cities** | rain in London, Tokyo heat, rain in Hanoi, Hanoi heat, Hanoi PM2.5 | Open-Meteo |
| **Code** | GitHub stars | GitHub API |

The same contract settles a question about the whole planet, one about a single
city, and one about a single repository, and nothing in it changes between them.
That is the long-tail claim made concrete rather than asserted.

Two are worth singling out. **Earthquakes worldwide** asks whether the next 24
hours beat the last 24 hours — a parametric, physical-world question of exactly
the kind the track's *parametric insurance* idea is about. **ISS over the north**
closes in six minutes and reads one number: the station circles the Earth every
90 minutes, so it is close to a genuine coin flip and it is the fastest way to
watch a full resolution happen.

Each one *reads its source first and sets the threshold from what it finds*. A
number typed into a template ages badly: "above 80,000 USD" is a coin flip one
week and settled the next, and a market whose answer is already known is not a
market. Built live, they land on the knife edge — the rain template offered
"at least 1mm tomorrow" against a forecast of 0.9mm, the earthquake template
"more than 6" against 6 in the last day, and the market-cap template "above 2.71
trillion" against 2.70 — and each says so under the chips.

They also model what a resolvable question looks like: the criteria **names the
exact field** to read and **says what counts as UNKNOWN**.

**Check sources now** fetches whatever is in the sources box and shows what
comes back, so a question can be sanity-checked against real data before anyone
stakes on it, and a dead or geo-blocked URL is caught here rather than as an
UNKNOWN at settlement. A browser CORS refusal is reported as *no preview* rather
than a failure — validators fetch server-side, so the browser's opinion is not
the last word; `probe_sources.py` is.

> Every URL offered was checked against what a validator node actually receives
> (`probe_sources.py`). A template pointed at a host validators cannot reach
> would hand a first-time user the Binance failure as their introduction to the
> product.

**A comma bug worth knowing about.** The sources box is comma-separated, and
Open-Meteo's multi-field form (`daily=precipitation_sum,temperature_2m_max`)
puts a literal comma *inside* a URL — so the template split in half and
registered a fragment as a second source. Caught by a 404 in the preview. The
templates now request one field per URL, and the form warns when any source does
not start with `http`, since the contract would otherwise reject it with a
message that explains nothing.

**A mark, and the chain stated up front.** The logo is inline SVG in
[brand.js](frontend/brand.js) rather than an image file, so it takes its colour
from the theme, stays sharp at favicon size, and needs no second request — the
same geometry serves the header lockup and the tab icon, which is what keeps
them from drifting apart.

Beside the name sits a badge reading **Built on GenLayer / StudioNet 61999**,
linking to genlayer.com. Its dot is live state rather than livery: it turns
amber the moment the connected wallet is on some other chain, matching the
network row and the refusal to sign there. The footer names what is actually
running — an Intelligent Contract in GenVM — and each settled market credits
the verdict to *GenLayer validators*, because that is the entire claim the
product makes and burying it in a footnote would undersell it.

**The book is readable, and that needed a contract change.** The first version
stored every bet but only ever handed one back at a time, and only to a caller
who already knew the address to ask for - so there was no way to see who was on
which side. A market whose book cannot be read is a market you have to take on
trust, which is the opposite of the point. `get_market_bets(market_id)` now
returns the lot, and each card can open it on demand.

That is a new ABI method, so it meant a redeploy: the contract is now
`0x99F7ECE24CdfFb9Eb5C7493Cb6bAC42DAc3B3774`. The older one (`0xffB459Ee6a6332dC3c412ff53Fa57413049B5149`)
still holds the first end-to-end runs and is unchanged.

**Seeded with real bettors, not a mock.** `tests/integration/demo_run.py`
creates independent StudioNet wallets, funds each from the faucet, and puts them
on both sides of a market with a random 1-5 GEN stake apiece - all deposits and
all bets fired in parallel, since nonces are per-account and six wallets acting
at once is six transactions rather than a queue. What the interface then shows
is the contract's own record: six addresses, six stakes, an implied price of 60%.
It prints its seed, so a run can be reproduced exactly.

**Solvency is an invariant, not an assumption.** A vault that can owe more
than it holds is broken however correct its payout maths looks, so it is checked
from both ends. Two direct tests walk a full round - deposit, bet, resolve,
claim, withdraw - asserting at every step that what the ledger says it owes,
plus the fees it has booked, still equals what came in minus what went out. An
integration test then compares the ledger against the balance the chain
actually reports.

On the live contract that reconciles exactly:

```
holds 336300000000000000000 wei
owes  333703109999999999992
fees    2596890000000000000
unallocated                8 wei
```

Those 8 wei are worth naming rather than rounding away. Each winner's share is
`stake * distributable // winner_pool`, and floor division discards under a wei
per winner, so a few wei per settled market end up owed to nobody — a player
cannot claim them and the owner cannot withdraw them, since they never reach the
treasury. Across 17 winning bets the residue is 8 wei, which is what floor
division predicts and what the test now bounds. Economically nothing; a gap
growing faster than that would mean money arriving with no claim attached, which
is why it is asserted instead of ignored.

**The book is audited, not just displayed.**
`tests/integration/test_book_studionet.py` reads every market's book back off
StudioNet and checks the accounting holds against real data: one row per bet,
stakes summing exactly to the pools the market reports, payouts recorded only
against the winning side, and the total paid matching the distributable pool to
within the wei that integer division leaves behind. Across the four settled
markets that is 34 bets and 83.97 GEN of payouts reconciled — the sort of thing
a mocked test cannot tell you, because the codec and the arithmetic are both
real.

**The implied price, drawn.** In a parimutuel pool the share of money on a side
*is* the crowd's probability for it — the one number a prediction market exists
to produce, and the page previously did not show it at all. Each market now
leads with a YES/NO bar and the two percentages; an empty market sits at 50/50,
which is not a claim but the honest absence of an opinion.

**The page is the markets.** They come first, ordered by what needs attention —
open, then awaiting resolution, then history — because newest-first alone buries
a live market under a week of settled ones. Opening a market is a drawer rather
than a permanent fixture: the form is long, and parked above the list it hides
the thing people came to look at.

**Numbers the contract already had.** A strip under the masthead reads
`get_stats()` — markets opened, bets placed, staked to date, riding on open
markets. The contract was counting all of it and the page was ignoring it, which
left a market list with no sense of scale, reading like a mockup.

**Live without stealing your caret.** Countdowns tick every second and pool
figures are re-read from chain every 20 seconds, but a card is only rebuilt when
its *shape* changes — a new market, or one moving between open, closed and
resolved. Everything else is written straight into the existing nodes, because a
rebuild costs the user whatever they were typing into a stake field, and on a
chain where a bet takes a minute to land that is a real loss. Verified: after a
poll the input is the same element, still focused, still holding its value.

Two more things the UI takes care to say honestly:

- **Betting stops before the market does.** A bet needs roughly a minute to
  reach consensus, so inside the last 75 seconds the buttons disable and the
  badge reads *"too late to bet"*. Letting someone spend that minute to be
  rejected on arrival is worse than telling them up front.
- **Seconds appear only in the last five minutes.** A market four hours out
  does not need a second hand; one showing a frozen "4m" for a minute at a time
  looks broken rather than calm.

- **A one-sided market is quoted as a refund, not as odds.** Deriving a
  multiplier from the only pool with money in it would advertise something below
  1x that the contract can never pay.
- **"Voided" says which kind.** A market that voids because the resolver could
  not decide is a different event from one that voids because nobody took the
  other side — the first run of this UI reported the second as the first, which
  was simply untrue, so the badge now reads e.g. *"Voided - YES, unopposed"*.

## Architecture reference

Money handling (deposit/bet/claim vault, parimutuel payout math, JSON-blob
storage to avoid the `gl.ContractState` write bug) follows the pattern proven
live on Studionet by GenPredict's `predict_market.py`. The LLM
resolution/equivalence pattern (`gl.nondet.exec_prompt`, defensive JSON
parsing, tolerance-based `validator_fn`) follows a tested reference contract
(`meme_rug_auditor.py`) from another local GenLayer project. Both patterns are
reused here as proven GenVM idioms, not copied code — this contract and its
deployment are independent of those live projects.

## Verified on StudioNet

Not a claim — a run. `tests/integration/test_resolution_consensus.py`, chain
61999, contract `0xffB459Ee6a6332dC3c412ff53Fa57413049B5149`:

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

### What the first run taught us, and why it counts as a pass

The first attempt sourced the market from Binance and resolved **UNKNOWN**, with
this reasoning:

> The Binance API returned an error indicating the service is unavailable from a
> restricted location, so no price field was provided in the source data.

Binance geo-blocks GenLayer's validator nodes — and answers with **HTTP 200 and
an error body**, so naive code would have parsed a price out of nothing. The
validators agreed on UNKNOWN, the market voided, and every stake was refundable
in full. The safety path did in production exactly what it was designed to do:
refuse to guess when the evidence is not there, rather than pay the wrong side.

`tests/integration/probe_sources.py` exists because of this — a throwaway
contract that reports what a validator node actually receives from a URL, so
picking a source takes 80 seconds instead of a 6-minute market cycle. Run it
before trusting any new source.

## Quality gates

```bash
genvm-lint lint contracts/any_bet.py --json                          # clean: ok, 3 passed
pytest tests/direct/ -q                                              # 18/18, mocked LLM/web
gltest tests/integration/test_deploy_studionet.py --network studionet -v -s   # 3/3
gltest tests/integration/test_resolution_consensus.py --network studionet -v -s  # 1/1, ~6.5 min
```

### Two things the contract source must respect

**Time comes from `datetime.datetime.now()`, never `time.time()`.** Deadlines
derived from it are written to state, and state must match across validators
exactly. Two independent pieces of official tooling agree on which is which:
`genvm-lint` raises W002 "Non-deterministic call" on `time.time()` and says
nothing about `datetime.datetime.now()`, and gltest's native VM implements its
`vm.warp()` cheatcode by patching `datetime.datetime`. Confirmed on-chain — the
market-creation transaction stores a `created_ts` from this clock and reaches
ACCEPTED, which requires validators to agree on it.

**The source file must be pure ASCII.** `genlayer-py` hex-encodes contract
source with `eth_utils.encode_hex`, which is ASCII-only, so a single em dash in
a comment breaks `get_contract_schema_for_code` — the deploy still succeeds and
then the client cannot build the contract object, which reads as a confusing
"Failed to get schema from all clients". (`genlayer-js` does not have this
limitation, which is why contracts written for the JS SDK can carry typography
this one cannot.)

### `genvm-lint check` passes, and what it took

Full semantic validation now runs clean:

```json
{"ok":true,
 "lint":     {"ok":true,"passed":3},
 "validate": {"ok":true,"contract":"AnyBet","methods":20,
              "view_methods":9,"write_methods":11,"ctor_params":0}}
```

It was reported here for most of this project as blocked on DNS, which was only
half right. `sdk.genlayer.com` genuinely did fail to resolve at times — DNS on
this machine is intermittently flaky, and StudioNet runs occasionally still need
a retry. But the reason `check` appeared to hang for ten minutes and produce
nothing was that it downloads a 128.6 MB GenVM toolchain at around 58 KB/s, and
`--json` suppresses the progress bar while it does. Running `genvm-lint download`
on its own showed the bar and settled the question. Once cached it is instant.

The one remaining note is informational: `I200`, a newer `py-genlayer` runner
exists. The pin stays as it is — it is the version this contract was deployed,
tested and settled four markets with, and the one GenPredict runs live on.
Changing the runner would mean redeploying and re-verifying everything to chase
a version whose changes we have not read.

## Status

- [x] Contract written, storage/equivalence patterns verified against two
      working local reference contracts
- [x] `genvm-lint lint` clean — `ok: true, passed: 3`, no warnings
- [x] Direct unit tests (18/18) — creation, betting, resolution
      (PAID / VOID-unknown / VOID-one-sided), claiming, cancellation
- [x] **Deployed and running on StudioNet**
- [x] **Full lifecycle verified on-chain** — deposit, bet both sides, LLM
      resolution through validator consensus, correct parimutuel payout, claim
- [x] UNKNOWN → VOID → refund safety path exercised for real (Binance geo-block)
- [x] **Frontend** — no build step, no wallet extension; full flow exercised in
      a browser against the live contract
- [x] **Submission write-up** — `SUBMISSION.md` (text to paste into the portal
      form) and `docs/submission-page.html` (the same case as a shareable page)
- [x] `genvm-lint check` — full lint + semantic validation clean
