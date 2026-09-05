# v0.2.0 -- AnyBet: long-tail parimutuel prediction markets, resolved by web+LLM consensus
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

# GenVM parses the two lines above as the "runner comment" and is strict about them:
# line 1 must START with the version token, the Depends line must come immediately
# after, and NO further comment may follow before the code -- violating any of these
# fails deployment with a bare `invalid_contract` error.
#
# Zero gl.ContractState usage -- nested dynamic collections (markets, bets, keyed by
# ever-growing ids) are JSON-encoded into plain instance-field strings instead, the
# same architecture GenPredict (contracts/predict_market.py, live on Studionet)
# uses to sidestep a ContractState write bug on GenLayer.
#
# Never return a float from a public method or from a nondeterministic block: GenVM's
# calldata codec has no float type and aborts with `not calldata encodable ...: float`.

from genlayer import *

import json
import typing
import datetime


def _now() -> int:
    """Current block time, as a unix timestamp.

    Deliberately `datetime.datetime.now()` and not `time.time()`. Deadlines
    derived from this get written to contract state, and state has to match
    across every validator exactly -- so the clock has to be the deterministic
    one GenVM provides, not wall-clock. Two independent pieces of official
    tooling confirm which is which: `genvm-lint` raises W002
    "Non-deterministic call" on `time.time()` and says nothing about
    `datetime.datetime.now()`, and gltest's native VM (`gltest.direct`)
    implements its `vm.warp(timestamp)` cheatcode by patching
    `datetime.datetime` -- so this is also the only form a direct test can
    time-travel.
    """
    return int(datetime.datetime.now().timestamp())


@gl.evm.contract_interface
class _Recipient:
    class Write:
        pass
    class View:
        pass


RESOLUTION_PROMPT = """
You are a neutral resolver for a prediction market on GenLayer, an AI-validator
blockchain. Multiple independent validators run this exact prompt and must reach
the same conclusion, so answer only from verifiable evidence -- never from opinion,
speculation, or what seems likely.

QUESTION: {question}

RESOLUTION CRITERIA (how the market creator said this must be judged): {criteria}

CURRENT UNIX TIMESTAMP: {now}

EXTERNAL SOURCE DATA (fetched live, may be empty or partial):
{context}

Decide the outcome strictly from the criteria and the source data above. If the
source data is empty, insufficient, ambiguous, or does not clearly settle the
question against the criteria, answer UNKNOWN rather than guessing -- a wrong
UNKNOWN only delays resolution, a wrong YES or NO pays the wrong side.

Return strictly a single valid JSON object matching this exact schema -- no
markdown formatting, no code fences, no extra text before or after it:
{{
    "outcome": "<YES|NO|UNKNOWN>",
    "reasoning": "<one or two sentences citing the specific evidence used>"
}}
"""

ALLOWED_OUTCOMES = {"YES", "NO", "UNKNOWN"}
MAX_SOURCES = 3
MAX_SOURCE_CHARS = 4000
MAX_QUESTION_CHARS = 300
MAX_CRITERIA_CHARS = 600
MIN_BETTING_WINDOW_SECONDS = 300  # 5 minutes, so a market can't close before anyone can bet
MAX_FEE_BPS = 1000  # 10%


class AnyBet(gl.Contract):
    """
    AnyBet -- "bet on anything" long-tail parimutuel markets, settled by GenLayer's
    Equivalence Principle instead of an admin, an oracle, or a fixed asset list.

    Anyone creates a market with a natural-language question, the criteria that
    should decide it, an optional close time, and up to three source URLs the
    resolver should check (a specific webpage, an API endpoint, anything public).
    Anyone bets YES or NO from their deposited balance. After close, anyone calls
    resolve_market(): every validator independently re-fetches the sources and
    re-runs the same resolution prompt, and only a matching normalized outcome
    (YES / NO / UNKNOWN) is accepted -- this is the custom leader/validator
    equivalence pattern GenLayer requires for judgment calls, not strict_eq.

    Money model mirrors GenPredict's proven vault (contracts/predict_market.py):
    deposit() once, bet() debits that balance, resolve_market() only *records*
    what each bet is owed, and claim()/claim_all() is a separate, deliberate step
    the winner takes -- so a win is something you noticed, not something that
    silently happened to you. A market voids and refunds in full, no fee taken,
    when the resolver says UNKNOWN or when one side never attracted a single bet
    (there is no counterparty to win from, so charging a fee would take money
    from a bet nobody opposed).
    """

    owner: str
    treasury: u256                # accumulated fees, withdrawable by owner
    total_markets: u256
    total_bets_placed: u256
    total_volume: u256
    balances_json: str            # { "0xaddr": "wei" } -- spendable, already deposited
    balances_total: u256          # sum of balances_json, so solvency is O(1) to check
    staked_total: u256            # stakes sitting in markets not yet resolved
    unclaimed_total: u256         # winnings decided but not yet collected
    markets_json: str             # { "1": {market...} }
    bets_json: str                # { "1": { "0xaddr": {bet...} } }
    next_market_id: u256

    # --- Construction ------------------------------------------------

    def __init__(self):
        self.owner = str(gl.message.sender_address).lower()
        self.treasury = u256(0)
        self.total_markets = u256(0)
        self.total_bets_placed = u256(0)
        self.total_volume = u256(0)
        self.balances_json = "{}"
        self.balances_total = u256(0)
        self.staked_total = u256(0)
        self.unclaimed_total = u256(0)
        self.markets_json = "{}"
        self.bets_json = "{}"
        self.next_market_id = u256(1)

    # --- Internal helpers -------------------------------------------

    def _load(self, s: str, default: typing.Any) -> typing.Any:
        try:
            return json.loads(s) if s else default
        except Exception:
            return default

    def _require_owner(self) -> None:
        if str(gl.message.sender_address).lower() != self.owner:
            raise gl.vm.UserError("Only owner can call this")

    def _market(self, markets: dict, market_id: str) -> dict:
        m = markets.get(market_id)
        if not m:
            raise gl.vm.UserError(f"Unknown market: {market_id}")
        return m

    def _credit(self, balances: dict, addr: str, amount: int) -> None:
        a = addr.lower()
        balances[a] = str(int(balances.get(a, "0")) + amount)
        self.balances_total += u256(amount)

    def _debit(self, balances: dict, addr: str, amount: int) -> None:
        a = addr.lower()
        have = int(balances.get(a, "0"))
        if have < amount:
            raise gl.vm.UserError(
                f"Insufficient balance: have {have} wei, need {amount} wei. Deposit first."
            )
        rest = have - amount
        if rest == 0:
            balances.pop(a, None)
        else:
            balances[a] = str(rest)
        self.balances_total -= u256(amount)

    def _parse_llm_json(self, response: typing.Any) -> dict:
        """Defensive JSON extraction: the model sometimes wraps its answer in a
        markdown code fence even when told not to, so strip that before parsing.

        Returns an empty dict rather than raising on anything malformed -- the
        caller reads a missing/unusable outcome as UNKNOWN, which voids and
        refunds the market. A parse failure is not a *user* error (nobody
        calling the contract did anything wrong), so raising gl.vm.UserError
        here would abort a resolution that has a perfectly good fallback.
        """
        if isinstance(response, dict):
            return response
        text = str(response).strip()
        if text.startswith("```json"):
            text = text[7:]
        if text.startswith("```"):
            text = text[3:]
        if text.endswith("```"):
            text = text[:-3]
        parsed = json.loads(text.strip())
        return parsed if isinstance(parsed, dict) else {}

    def _resolve_question(self, question: str, criteria: str, sources: list) -> dict:
        """Live resolution agreed by validators through the Equivalence Principle.

        Every validator independently fetches the same sources and runs the same
        prompt; only an exact match on the normalized `outcome` field is accepted.
        This is the right equivalence strategy here (rather than strict_eq on the
        whole response) because two honest LLM calls can phrase reasoning
        differently while still agreeing on the verdict -- the verdict is the part
        that has to be identical for consensus to mean anything.
        """

        def leader_fn() -> dict:
            context_parts = []
            for url in sources[:MAX_SOURCES]:
                try:
                    resp = gl.nondet.web.get(url)
                    body = str(resp.body)[:MAX_SOURCE_CHARS]
                    context_parts.append(f"SOURCE: {url}\n{body}")
                except Exception:
                    context_parts.append(f"SOURCE: {url}\n(fetch failed)")
            context = "\n\n".join(context_parts) if context_parts else "(no source URLs provided)"

            prompt = (
                RESOLUTION_PROMPT
                .replace("{question}", question)
                .replace("{criteria}", criteria)
                .replace("{now}", str(_now()))
                .replace("{context}", context)
            )
            try:
                response = gl.nondet.exec_prompt(prompt, response_format="json")
                parsed = self._parse_llm_json(response)
                outcome = str(parsed.get("outcome", "UNKNOWN")).strip().upper()
                if outcome not in ALLOWED_OUTCOMES:
                    outcome = "UNKNOWN"
                reasoning = str(parsed.get("reasoning", ""))[:500]
                return {"outcome": outcome, "reasoning": reasoning}
            except Exception:
                return {"outcome": "UNKNOWN", "reasoning": "resolution_failed"}

        def validator_fn(leaders_res) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return False
            try:
                mine = leader_fn()
                leader_res = leaders_res.calldata
                if isinstance(leader_res, str):
                    leader_res = json.loads(leader_res)
                return str(mine.get("outcome")) == str(leader_res.get("outcome"))
            except Exception:
                return False

        result = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except Exception:
                result = {"outcome": "UNKNOWN", "reasoning": "resolution_failed"}
        if not isinstance(result, dict):
            result = {"outcome": "UNKNOWN", "reasoning": "resolution_failed"}
        return result

    def _payout_for(self, mkt: dict, side: str, amount: int) -> int:
        """Parimutuel share of the pool, or a full refund when the market voided.

        A market voids on outcome UNKNOWN, or whenever one side attracted no
        stake at all. That second case matters: with an empty losing side there
        is nobody to win from, so charging a fee would take money from a bet
        that had no counterparty; with an empty *winning* side nobody could ever
        claim, which would strand the pool in the contract forever. Refunding
        everyone in full is the only settlement that is both fair and leaves
        nothing behind.
        """
        if mkt.get("settlement") == "VOID":
            return amount
        winner = mkt.get("outcome", "")
        if side != winner:
            return 0
        yes_pool = int(mkt.get("yes_pool", "0"))
        no_pool = int(mkt.get("no_pool", "0"))
        total = yes_pool + no_pool
        winner_pool = yes_pool if winner == "YES" else no_pool
        if winner_pool <= 0:
            return 0
        fee = total * int(mkt["fee_bps"]) // 10000
        distributable = total - fee
        return amount * distributable // winner_pool

    # --- Market creation -----------------------------------------------

    @gl.public.write
    def create_market(
        self,
        question: str,
        criteria: str,
        close_ts: u256,
        sources: str,
        min_bet: u256,
        fee_bps: u256,
    ) -> dict[str, typing.Any]:
        """Open a new market. `sources` is a comma-separated list of up to 3
        http(s) URLs the resolver should check (may be empty -- the resolver
        still answers from the question/criteria alone, just less reliably)."""
        question = question.strip()
        criteria = criteria.strip()
        if not question or len(question) > MAX_QUESTION_CHARS:
            raise gl.vm.UserError(f"question must be 1-{MAX_QUESTION_CHARS} chars")
        if not criteria or len(criteria) > MAX_CRITERIA_CHARS:
            raise gl.vm.UserError(f"criteria must be 1-{MAX_CRITERIA_CHARS} chars")

        now = _now()
        close = int(close_ts)
        if close < now + MIN_BETTING_WINDOW_SECONDS:
            raise gl.vm.UserError(
                f"close_ts must be at least {MIN_BETTING_WINDOW_SECONDS}s from now"
            )

        src_list = [s.strip() for s in sources.split(",") if s.strip()] if sources else []
        if len(src_list) > MAX_SOURCES:
            raise gl.vm.UserError(f"at most {MAX_SOURCES} source URLs")
        for url in src_list:
            if not (url.startswith("http://") or url.startswith("https://")):
                raise gl.vm.UserError(f"invalid source URL: {url}")

        mb = int(min_bet)
        if mb <= 0:
            raise gl.vm.UserError("min_bet must be > 0")
        fee = int(fee_bps)
        if fee > MAX_FEE_BPS:
            raise gl.vm.UserError(f"fee_bps too high (max {MAX_FEE_BPS} = 10%)")

        markets = self._load(self.markets_json, {})
        mid = str(int(self.next_market_id))
        markets[mid] = {
            "id": mid,
            "creator": str(gl.message.sender_address).lower(),
            "question": question,
            "criteria": criteria,
            "sources_json": json.dumps(src_list),
            "created_ts": now,
            "close_ts": close,
            "fee_bps": fee,
            "min_bet": str(mb),
            "status": "OPEN",
            "yes_pool": "0",
            "no_pool": "0",
            "yes_count": 0,
            "no_count": 0,
            "outcome": "",
            "settlement": "",
            "reasoning": "",
        }
        self.markets_json = json.dumps(markets)
        self.next_market_id += u256(1)
        self.total_markets += u256(1)
        return {"market_id": mid, "close_ts": close}

    @gl.public.write
    def cancel_market(self, market_id: u256) -> None:
        """Withdraw a market before anyone has bet on it. Creator or owner only,
        and only while it is still empty -- once real money is riding on it,
        cancelling would mean picking a side to disappoint."""
        mid = str(int(market_id))
        markets = self._load(self.markets_json, {})
        mkt = self._market(markets, mid)
        caller = str(gl.message.sender_address).lower()
        if caller != mkt["creator"] and caller != self.owner:
            raise gl.vm.UserError("Only the creator or owner can cancel")
        if mkt["status"] != "OPEN":
            raise gl.vm.UserError(f"Market is {mkt['status']}, cannot cancel")
        if int(mkt["yes_pool"]) + int(mkt["no_pool"]) > 0:
            raise gl.vm.UserError("Market already has bets, cannot cancel")
        mkt["status"] = "CANCELLED"
        markets[mid] = mkt
        self.markets_json = json.dumps(markets)

    # --- Vault: deposit / withdraw -----------------------------------

    @gl.public.write.payable
    def deposit(self) -> dict[str, typing.Any]:
        """Top up your account. The sender's wallet address is the account number."""
        amount = int(gl.message.value)
        if amount <= 0:
            raise gl.vm.UserError("Deposit must be greater than zero")
        balances = self._load(self.balances_json, {})
        player = str(gl.message.sender_address).lower()
        self._credit(balances, player, amount)
        self.balances_json = json.dumps(balances)
        return {"address": player, "deposited": str(amount), "balance": balances[player]}

    @gl.public.write
    def withdraw(self, amount: u256) -> dict[str, typing.Any]:
        """Take GEN back out. Only ever touches the caller's own balance; stakes
        already committed to an unresolved market are not part of it."""
        amt = int(amount)
        if amt <= 0:
            raise gl.vm.UserError("Withdraw amount must be greater than zero")
        balances = self._load(self.balances_json, {})
        player = str(gl.message.sender_address).lower()
        self._debit(balances, player, amt)
        self.balances_json = json.dumps(balances)
        _Recipient(gl.message.sender_address).emit_transfer(value=u256(amt))
        return {"withdrawn": str(amt), "balance": balances.get(player, "0")}

    @gl.public.write
    def withdraw_all(self) -> dict[str, typing.Any]:
        balances = self._load(self.balances_json, {})
        player = str(gl.message.sender_address).lower()
        amt = int(balances.get(player, "0"))
        if amt <= 0:
            raise gl.vm.UserError("Nothing to withdraw")
        self._debit(balances, player, amt)
        self.balances_json = json.dumps(balances)
        _Recipient(gl.message.sender_address).emit_transfer(value=u256(amt))
        return {"withdrawn": str(amt), "balance": "0"}

    # --- Betting -----------------------------------------------------

    @gl.public.write
    def bet(self, market_id: u256, side: str, amount: u256) -> dict[str, typing.Any]:
        """Back YES or NO on an open market, staking from your deposited balance.
        Not payable on purpose: funds come from the vault you already topped up."""
        side = side.upper()
        if side not in ("YES", "NO"):
            raise gl.vm.UserError("side must be YES or NO")

        mid = str(int(market_id))
        markets = self._load(self.markets_json, {})
        mkt = self._market(markets, mid)
        if mkt["status"] != "OPEN":
            raise gl.vm.UserError(f"Market is {mkt['status']}, not open for betting")
        now = _now()
        if now >= int(mkt["close_ts"]):
            raise gl.vm.UserError("Betting has closed for this market")

        stake = int(amount)
        if stake < int(mkt["min_bet"]):
            raise gl.vm.UserError(f"Bet must be at least {mkt['min_bet']} wei")

        player = str(gl.message.sender_address).lower()
        balances = self._load(self.balances_json, {})
        self._debit(balances, player, stake)
        self.balances_json = json.dumps(balances)
        self.staked_total += u256(stake)

        bets = self._load(self.bets_json, {})
        mbets = bets.get(mid, {})
        if player in mbets:
            raise gl.vm.UserError(f"Already bet {mbets[player]['side']} on this market")
        mbets[player] = {"side": side, "amount": str(stake), "settled": 0, "payout": "0", "claimed": 0}
        bets[mid] = mbets
        self.bets_json = json.dumps(bets)

        if side == "YES":
            mkt["yes_pool"] = str(int(mkt["yes_pool"]) + stake)
            mkt["yes_count"] = int(mkt["yes_count"]) + 1
        else:
            mkt["no_pool"] = str(int(mkt["no_pool"]) + stake)
            mkt["no_count"] = int(mkt["no_count"]) + 1
        markets[mid] = mkt
        self.markets_json = json.dumps(markets)

        self.total_bets_placed += u256(1)
        self.total_volume += u256(stake)

        return {"market_id": mid, "side": side, "amount": str(amount), "close_ts": int(mkt["close_ts"])}

    # --- Resolution (permissionless keeper action) --------------------

    @gl.public.write
    def resolve_market(self, market_id: u256) -> dict[str, typing.Any]:
        """Fetch sources, ask the LLM, and settle. Callable by anyone once
        close_ts has passed -- resolution needs no admin and no oracle key."""
        mid = str(int(market_id))
        markets = self._load(self.markets_json, {})
        mkt = self._market(markets, mid)
        if mkt["status"] != "OPEN":
            raise gl.vm.UserError(f"Market is {mkt['status']}, expected OPEN")
        now = _now()
        if now < int(mkt["close_ts"]):
            raise gl.vm.UserError(f"Not resolvable yet, {int(mkt['close_ts']) - now}s remaining")

        sources = self._load(mkt.get("sources_json", "[]"), [])
        result = self._resolve_question(mkt["question"], mkt["criteria"], sources)
        outcome = result.get("outcome", "UNKNOWN")

        yes_pool = int(mkt["yes_pool"])
        no_pool = int(mkt["no_pool"])
        total = yes_pool + no_pool
        one_sided = yes_pool == 0 or no_pool == 0
        settlement = "VOID" if (outcome == "UNKNOWN" or one_sided) else "PAID"

        mkt["outcome"] = outcome
        mkt["settlement"] = settlement
        mkt["status"] = "RESOLVED"
        mkt["reasoning"] = str(result.get("reasoning", ""))[:500]
        markets[mid] = mkt

        fee = 0
        if settlement == "PAID":
            fee = total * int(mkt["fee_bps"]) // 10000
            self.treasury += u256(fee)

        bets = self._load(self.bets_json, {})
        mbets = bets.get(mid, {})
        owed = 0
        winners = 0
        for addr, b in mbets.items():
            if int(b.get("settled", 0)) == 1:
                continue
            payout = self._payout_for(mkt, b["side"], int(b["amount"]))
            b["settled"] = 1
            b["payout"] = str(payout)
            if payout > 0:
                owed += payout
                winners += 1
        if mbets:
            bets[mid] = mbets
            self.bets_json = json.dumps(bets)

        self.staked_total = u256(max(0, int(self.staked_total) - total))
        self.unclaimed_total += u256(owed)
        self.markets_json = json.dumps(markets)

        return {
            "market_id": mid,
            "outcome": outcome,
            "settlement": settlement,
            "reasoning": mkt["reasoning"],
            "fee": str(fee),
            "claimable": str(owed),
            "winners": winners,
        }

    # --- Claiming ----------------------------------------------------

    @gl.public.write
    def claim(self, market_id: u256) -> dict[str, typing.Any]:
        """Collect a win (or a void refund). Credits your play balance so it is
        ready to bet again, or to withdraw."""
        mid = str(int(market_id))
        markets = self._load(self.markets_json, {})
        mkt = self._market(markets, mid)
        if mkt["status"] != "RESOLVED":
            raise gl.vm.UserError("This market has not resolved yet")

        player = str(gl.message.sender_address).lower()
        bets = self._load(self.bets_json, {})
        b = bets.get(mid, {}).get(player)
        if not b:
            raise gl.vm.UserError("You did not bet on this market")
        if int(b.get("claimed", 0)) == 1:
            raise gl.vm.UserError("Already collected")
        payout = int(b.get("payout", "0"))
        if payout <= 0:
            raise gl.vm.UserError("This bet did not win -- there is nothing to collect")

        b["claimed"] = 1
        bets[mid][player] = b
        self.bets_json = json.dumps(bets)

        balances = self._load(self.balances_json, {})
        self._credit(balances, player, payout)
        self.balances_json = json.dumps(balances)
        self.unclaimed_total = u256(max(0, int(self.unclaimed_total) - payout))

        return {
            "market_id": mid,
            "collected": str(payout),
            "refund": 1 if mkt.get("settlement") == "VOID" else 0,
        }

    @gl.public.write
    def claim_all(self) -> dict[str, typing.Any]:
        """Collect every outstanding win across every market in one transaction."""
        player = str(gl.message.sender_address).lower()
        markets = self._load(self.markets_json, {})
        bets = self._load(self.bets_json, {})
        balances = self._load(self.balances_json, {})

        total = 0
        claimed = []
        for mid, mbets in bets.items():
            b = mbets.get(player)
            if not b or int(b.get("claimed", 0)) == 1:
                continue
            payout = int(b.get("payout", "0"))
            if payout <= 0:
                continue
            mkt = markets.get(mid)
            if not mkt or mkt.get("status") != "RESOLVED":
                continue
            b["claimed"] = 1
            total += payout
            claimed.append(mid)

        if total <= 0:
            raise gl.vm.UserError("Nothing to collect")

        self.bets_json = json.dumps(bets)
        self._credit(balances, player, total)
        self.balances_json = json.dumps(balances)
        self.unclaimed_total = u256(max(0, int(self.unclaimed_total) - total))
        return {"collected": str(total), "markets": len(claimed)}

    # --- Views -------------------------------------------------------

    @gl.public.view
    def get_owner(self) -> str:
        return self.owner

    @gl.public.view
    def get_market(self, market_id: u256) -> dict[str, typing.Any]:
        markets = self._load(self.markets_json, {})
        return self._market(markets, str(int(market_id)))

    @gl.public.view
    def get_open_markets(self) -> str:
        markets = self._load(self.markets_json, {})
        return json.dumps([m for m in markets.values() if m.get("status") == "OPEN"])

    @gl.public.view
    def get_all_markets(self) -> str:
        return self.markets_json

    @gl.public.view
    def get_bet(self, market_id: u256, addr: str) -> dict[str, typing.Any]:
        bets = self._load(self.bets_json, {})
        b = bets.get(str(int(market_id)), {}).get(addr.lower())
        return b or {}

    @gl.public.view
    def get_market_bets(self, market_id: u256) -> str:
        """Every bet on one market, oldest first.

        Without this there is no way to see who is on which side: the contract
        stored the bets but only ever handed one back at a time, and only to a
        caller who already knew the address to ask for. A market whose book
        cannot be read is a market you have to take on trust, which is the
        opposite of the point.

        Returns a JSON list rather than the raw address-keyed map, because the
        caller wants a feed in order, not something to sort itself.
        """
        mid = str(int(market_id))
        bets = self._load(self.bets_json, {})
        out = []
        for addr, b in bets.get(mid, {}).items():
            out.append({
                "address": addr,
                "side": b.get("side", ""),
                "amount": b.get("amount", "0"),
                "settled": int(b.get("settled", 0)),
                "payout": b.get("payout", "0"),
                "claimed": int(b.get("claimed", 0)),
            })
        return json.dumps(out)

    @gl.public.view
    def get_balance(self, addr: str) -> str:
        balances = self._load(self.balances_json, {})
        return balances.get(addr.lower(), "0")

    @gl.public.view
    def get_claimable(self, addr: str) -> str:
        addr = addr.lower()
        markets = self._load(self.markets_json, {})
        bets = self._load(self.bets_json, {})
        out = []
        for mid, mbets in bets.items():
            b = mbets.get(addr)
            if not b or int(b.get("claimed", 0)) == 1:
                continue
            payout = int(b.get("payout", "0"))
            if payout <= 0:
                continue
            mkt = markets.get(mid)
            if not mkt or mkt.get("status") != "RESOLVED":
                continue
            out.append({
                "market_id": mid,
                "question": mkt.get("question", ""),
                "side": b["side"],
                "amount": b["amount"],
                "payout": str(payout),
                "outcome": mkt.get("outcome", ""),
                "settlement": mkt.get("settlement", ""),
            })
        return json.dumps(out)

    @gl.public.view
    def get_stats(self) -> dict[str, typing.Any]:
        return {
            "total_markets": int(self.total_markets),
            "total_bets_placed": int(self.total_bets_placed),
            "total_volume": str(self.total_volume),
            "treasury": str(self.treasury),
            "player_balances": str(self.balances_total),
            "at_risk_in_markets": str(self.staked_total),
            "unclaimed_winnings": str(self.unclaimed_total),
        }

    # --- Admin -------------------------------------------------------

    @gl.public.write
    def transfer_ownership(self, new_owner: str) -> None:
        self._require_owner()
        self.owner = new_owner.lower()

    @gl.public.write
    def withdraw_treasury(self, amount: u256) -> None:
        self._require_owner()
        amt = int(amount)
        if amt <= 0 or amt > int(self.treasury):
            raise gl.vm.UserError(f"Cannot withdraw more than treasury ({int(self.treasury)} wei)")
        self.treasury -= u256(amt)
        _Recipient(gl.message.sender_address).emit_transfer(value=u256(amt))
