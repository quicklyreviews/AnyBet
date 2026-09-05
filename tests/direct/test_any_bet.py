import json
import pytest
from contracts.any_bet import AnyBet
from genlayer import gl

OWNER = "0x1111111111111111111111111111111111111111"
ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

FIXED_NOW = 1_700_000_000


@pytest.fixture
def clock(monkeypatch):
    """Mutable fake clock so tests control the contract's notion of now without
    sleeping — set create_market's close_ts relative to it, then move it forward
    past close_ts before resolving.

    Patches `datetime.datetime.now()`, which is what the contract reads (see
    `_now()`); this mirrors how gltest's own VM implements `vm.warp()`.
    """
    import datetime as _dt

    box = {"now": FIXED_NOW}

    class _FrozenDatetime(_dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return _dt.datetime.fromtimestamp(box["now"], tz)

    monkeypatch.setattr("contracts.any_bet.datetime.datetime", _FrozenDatetime)
    return box


@pytest.fixture
def as_owner(monkeypatch):
    monkeypatch.setattr("genlayer.gl.message.sender_address", OWNER)


def _as(monkeypatch, addr):
    monkeypatch.setattr("genlayer.gl.message.sender_address", addr)


def _deposit(monkeypatch, contract, addr, amount):
    _as(monkeypatch, addr)
    monkeypatch.setattr("genlayer.gl.message.value", amount)
    contract.deposit()
    monkeypatch.setattr("genlayer.gl.message.value", 0)


def _make_market(monkeypatch, contract, clock, creator=ALICE, close_in=400, sources=""):
    _as(monkeypatch, creator)
    res = contract.create_market(
        question="Will it rain in Hanoi tomorrow?",
        criteria="YES if a public weather source shows >50% chance of rain for Hanoi tomorrow.",
        close_ts=clock["now"] + close_in,
        sources=sources,
        min_bet=10,
        fee_bps=300,
    )
    return res["market_id"]


def test_create_market_and_list(monkeypatch, clock, as_owner):
    contract = AnyBet()
    mid = _make_market(monkeypatch, contract, clock)
    mkt = contract.get_market(int(mid))
    assert mkt["question"].startswith("Will it rain")
    assert mkt["status"] == "OPEN"
    assert mkt["creator"] == ALICE

    open_markets = json.loads(contract.get_open_markets())
    assert len(open_markets) == 1
    assert open_markets[0]["id"] == mid


def test_create_market_rejects_short_window(monkeypatch, clock, as_owner):
    contract = AnyBet()
    with pytest.raises(gl.vm.UserError):
        contract.create_market(
            question="Q", criteria="C", close_ts=clock["now"] + 10,
            sources="", min_bet=10, fee_bps=300,
        )


def test_create_market_rejects_empty_question(monkeypatch, clock, as_owner):
    contract = AnyBet()
    with pytest.raises(gl.vm.UserError):
        contract.create_market(
            question="   ", criteria="C", close_ts=clock["now"] + 400,
            sources="", min_bet=10, fee_bps=300,
        )


def test_bet_requires_deposit_first(monkeypatch, clock, as_owner):
    contract = AnyBet()
    mid = _make_market(monkeypatch, contract, clock)
    _as(monkeypatch, BOB)
    with pytest.raises(gl.vm.UserError):
        contract.bet(int(mid), "YES", 50)


def test_double_bet_same_market_rejected(monkeypatch, clock, as_owner):
    contract = AnyBet()
    mid = _make_market(monkeypatch, contract, clock)
    _deposit(monkeypatch, contract, BOB, 100)
    _as(monkeypatch, BOB)
    contract.bet(int(mid), "YES", 50)
    with pytest.raises(gl.vm.UserError):
        contract.bet(int(mid), "NO", 20)


def test_resolve_before_close_rejected(monkeypatch, clock, as_owner):
    contract = AnyBet()
    mid = _make_market(monkeypatch, contract, clock)
    with pytest.raises(gl.vm.UserError):
        contract.resolve_market(int(mid))


def test_full_flow_paid_yes(monkeypatch, clock, as_owner):
    """Alice bets YES 100, Bob bets NO 100. LLM resolves YES. Fee 3%, so the
    198 distributable splits entirely to Alice (the only YES bettor)."""
    contract = AnyBet()
    mid = _make_market(monkeypatch, contract, clock)

    _deposit(monkeypatch, contract, ALICE, 1000)
    _as(monkeypatch, ALICE)
    contract.bet(int(mid), "YES", 100)

    _deposit(monkeypatch, contract, BOB, 1000)
    _as(monkeypatch, BOB)
    contract.bet(int(mid), "NO", 100)

    monkeypatch.setattr(
        "genlayer.gl.nondet.exec_prompt",
        lambda prompt, response_format="json": {"outcome": "YES", "reasoning": "source says so"},
    )
    clock["now"] += 401  # past close_ts

    result = contract.resolve_market(int(mid))
    assert result["outcome"] == "YES"
    assert result["settlement"] == "PAID"
    assert result["fee"] == "6"  # 3% of 200
    assert result["claimable"] == "194"

    _as(monkeypatch, ALICE)
    claim = contract.claim(int(mid))
    assert claim["collected"] == "194"
    assert contract.get_balance(ALICE) == str(1000 - 100 + 194)

    # Bob lost — nothing to claim.
    _as(monkeypatch, BOB)
    with pytest.raises(gl.vm.UserError):
        contract.claim(int(mid))


def test_resolve_unknown_voids_and_refunds(monkeypatch, clock, as_owner):
    contract = AnyBet()
    mid = _make_market(monkeypatch, contract, clock)

    _deposit(monkeypatch, contract, ALICE, 1000)
    _as(monkeypatch, ALICE)
    contract.bet(int(mid), "YES", 100)
    _deposit(monkeypatch, contract, BOB, 1000)
    _as(monkeypatch, BOB)
    contract.bet(int(mid), "NO", 100)

    monkeypatch.setattr(
        "genlayer.gl.nondet.exec_prompt",
        lambda prompt, response_format="json": {"outcome": "UNKNOWN", "reasoning": "no evidence"},
    )
    clock["now"] += 401

    result = contract.resolve_market(int(mid))
    assert result["settlement"] == "VOID"
    assert result["fee"] == "0"

    _as(monkeypatch, ALICE)
    assert contract.claim(int(mid))["collected"] == "100"
    _as(monkeypatch, BOB)
    assert contract.claim(int(mid))["collected"] == "100"


def test_resolve_one_sided_voids(monkeypatch, clock, as_owner):
    """Only YES ever got a bet — no counterparty, so even a confident YES
    verdict must void and refund rather than let Alice claim someone else's
    money that was never staked."""
    contract = AnyBet()
    mid = _make_market(monkeypatch, contract, clock)

    _deposit(monkeypatch, contract, ALICE, 1000)
    _as(monkeypatch, ALICE)
    contract.bet(int(mid), "YES", 100)

    monkeypatch.setattr(
        "genlayer.gl.nondet.exec_prompt",
        lambda prompt, response_format="json": {"outcome": "YES", "reasoning": "confident"},
    )
    clock["now"] += 401

    result = contract.resolve_market(int(mid))
    assert result["settlement"] == "VOID"

    claim = contract.claim(int(mid))
    assert claim["collected"] == "100"
    assert claim["refund"] == 1


def test_claim_all_across_markets(monkeypatch, clock, as_owner):
    contract = AnyBet()
    mid1 = _make_market(monkeypatch, contract, clock)
    mid2 = _make_market(monkeypatch, contract, clock, creator=BOB)

    _deposit(monkeypatch, contract, ALICE, 1000)
    _as(monkeypatch, ALICE)
    contract.bet(int(mid1), "YES", 100)
    contract.bet(int(mid2), "YES", 100)

    _deposit(monkeypatch, contract, BOB, 1000)
    _as(monkeypatch, BOB)
    contract.bet(int(mid1), "NO", 100)
    contract.bet(int(mid2), "NO", 100)

    monkeypatch.setattr(
        "genlayer.gl.nondet.exec_prompt",
        lambda prompt, response_format="json": {"outcome": "YES", "reasoning": "x"},
    )
    clock["now"] += 401
    contract.resolve_market(int(mid1))
    contract.resolve_market(int(mid2))

    _as(monkeypatch, ALICE)
    result = contract.claim_all()
    assert result["markets"] == 2
    assert int(result["collected"]) == 194 * 2


def test_cancel_market_before_bets(monkeypatch, clock, as_owner):
    contract = AnyBet()
    mid = _make_market(monkeypatch, contract, clock)
    _as(monkeypatch, ALICE)
    contract.cancel_market(int(mid))
    assert contract.get_market(int(mid))["status"] == "CANCELLED"


def test_cancel_market_rejected_after_bet(monkeypatch, clock, as_owner):
    contract = AnyBet()
    mid = _make_market(monkeypatch, contract, clock)
    _deposit(monkeypatch, contract, BOB, 1000)
    _as(monkeypatch, BOB)
    contract.bet(int(mid), "YES", 50)
    _as(monkeypatch, ALICE)
    with pytest.raises(gl.vm.UserError):
        contract.cancel_market(int(mid))


def test_validator_disagreement_rejected_by_mock_vm(monkeypatch, clock, as_owner):
    """MockVM.run_nondet_unsafe asserts validator_fn(leader's own result) is
    True — this exercises the exact equivalence path resolve_market relies on,
    so a future edit that breaks outcome-normalization fails this test, not a
    live validator disagreement on-chain."""
    contract = AnyBet()
    mid = _make_market(monkeypatch, contract, clock)
    _deposit(monkeypatch, contract, ALICE, 1000)
    _as(monkeypatch, ALICE)
    contract.bet(int(mid), "YES", 100)
    _deposit(monkeypatch, contract, BOB, 1000)
    _as(monkeypatch, BOB)
    contract.bet(int(mid), "NO", 100)

    # Lowercase / stray whitespace from the model must still normalize to a
    # matching outcome across both calls.
    monkeypatch.setattr(
        "genlayer.gl.nondet.exec_prompt",
        lambda prompt, response_format="json": {"outcome": " no ", "reasoning": "x"},
    )
    clock["now"] += 401
    result = contract.resolve_market(int(mid))
    assert result["outcome"] == "NO"


def test_get_market_bets_lists_both_sides(monkeypatch, clock, as_owner):
    """The book has to be readable by anyone, not just by someone who already
    knows which address to ask about."""
    contract = AnyBet()
    mid = _make_market(monkeypatch, contract, clock)

    _deposit(monkeypatch, contract, ALICE, 1000)
    _as(monkeypatch, ALICE)
    contract.bet(int(mid), "YES", 100)
    _deposit(monkeypatch, contract, BOB, 1000)
    _as(monkeypatch, BOB)
    contract.bet(int(mid), "NO", 60)

    book = json.loads(contract.get_market_bets(int(mid)))
    assert len(book) == 2
    by_addr = {b["address"]: b for b in book}
    assert by_addr[ALICE]["side"] == "YES"
    assert by_addr[ALICE]["amount"] == "100"
    assert by_addr[BOB]["side"] == "NO"
    assert by_addr[BOB]["amount"] == "60"
    assert all(b["settled"] == 0 for b in book)


def test_get_market_bets_records_payouts_after_resolution(monkeypatch, clock, as_owner):
    contract = AnyBet()
    mid = _make_market(monkeypatch, contract, clock)
    _deposit(monkeypatch, contract, ALICE, 1000)
    _as(monkeypatch, ALICE)
    contract.bet(int(mid), "YES", 100)
    _deposit(monkeypatch, contract, BOB, 1000)
    _as(monkeypatch, BOB)
    contract.bet(int(mid), "NO", 100)

    monkeypatch.setattr(
        "genlayer.gl.nondet.exec_prompt",
        lambda prompt, response_format="json": {"outcome": "YES", "reasoning": "x"},
    )
    clock["now"] += 401
    contract.resolve_market(int(mid))

    book = {b["address"]: b for b in json.loads(contract.get_market_bets(int(mid)))}
    assert book[ALICE]["payout"] == "194"
    assert book[BOB]["payout"] == "0"
    assert all(b["settled"] == 1 for b in book.values())


def test_get_market_bets_empty_for_untouched_market(monkeypatch, clock, as_owner):
    contract = AnyBet()
    mid = _make_market(monkeypatch, contract, clock)
    assert json.loads(contract.get_market_bets(int(mid))) == []


def _owed(contract):
    """Everything the contract would have to pay out if everyone left today."""
    return (int(contract.balances_total)
            + int(contract.staked_total)
            + int(contract.unclaimed_total))


def test_contract_never_owes_more_than_it_took(monkeypatch, clock, as_owner):
    """The solvency invariant, checked at every step of a full round.

    A vault that can owe more than it holds is broken however correct its
    payout maths looks, so this tracks the two sides independently: deposits in
    minus withdrawals out on one side, and what the ledger says it owes plus
    the fees it has booked on the other. They must never diverge.
    """
    contract = AnyBet()
    mid = _make_market(monkeypatch, contract, clock)
    held = 0

    _deposit(monkeypatch, contract, ALICE, 1000)
    held += 1000
    assert _owed(contract) + int(contract.treasury) == held

    _deposit(monkeypatch, contract, BOB, 1000)
    held += 1000
    assert _owed(contract) + int(contract.treasury) == held

    _as(monkeypatch, ALICE)
    contract.bet(int(mid), "YES", 400)
    _as(monkeypatch, BOB)
    contract.bet(int(mid), "NO", 600)
    # Staking moves money between categories; it does not create or destroy any.
    assert _owed(contract) + int(contract.treasury) == held

    monkeypatch.setattr(
        "genlayer.gl.nondet.exec_prompt",
        lambda prompt, response_format="json": {"outcome": "YES", "reasoning": "x"},
    )
    clock["now"] += 401
    contract.resolve_market(int(mid))
    # Resolution books a fee, so the fee has to show up in the treasury rather
    # than quietly vanish from what is owed.
    assert _owed(contract) + int(contract.treasury) == held

    _as(monkeypatch, ALICE)
    contract.claim(int(mid))
    assert _owed(contract) + int(contract.treasury) == held

    _as(monkeypatch, ALICE)
    out = contract.withdraw_all()
    held -= int(out["withdrawn"])
    assert _owed(contract) + int(contract.treasury) == held

    # Bob lost his stake, so what is left owed is his untouched balance only.
    assert int(contract.balances_total) == 400
    assert int(contract.staked_total) == 0
    assert int(contract.unclaimed_total) == 0


def test_void_refund_keeps_the_books_balanced(monkeypatch, clock, as_owner):
    """A voided market takes no fee, so every wei staked stays owed."""
    contract = AnyBet()
    mid = _make_market(monkeypatch, contract, clock)
    _deposit(monkeypatch, contract, ALICE, 500)
    _deposit(monkeypatch, contract, BOB, 500)
    held = 1000

    _as(monkeypatch, ALICE)
    contract.bet(int(mid), "YES", 300)
    _as(monkeypatch, BOB)
    contract.bet(int(mid), "NO", 200)

    monkeypatch.setattr(
        "genlayer.gl.nondet.exec_prompt",
        lambda prompt, response_format="json": {"outcome": "UNKNOWN", "reasoning": "thin"},
    )
    clock["now"] += 401
    contract.resolve_market(int(mid))

    assert int(contract.treasury) == 0, "a void must not take a fee"
    assert _owed(contract) == held

    _as(monkeypatch, ALICE)
    contract.claim(int(mid))
    _as(monkeypatch, BOB)
    contract.claim(int(mid))
    assert _owed(contract) == held
    assert int(contract.balances_total) == held
