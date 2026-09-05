"""The book, read back off a real network.

`get_market_bets` is what lets anyone see who is on which side, and the direct
tests only prove it against a mocked `genlayer` module. This checks the same
view through GenVM's calldata codec on StudioNet - which is where a return type
that looks fine in Python turns out not to be encodable.

    gltest tests/integration/test_book_studionet.py --network studionet -v -s
"""

import json
import os
import time

import pytest
from gltest import get_contract_factory, get_accounts, get_gl_client
from gltest.assertions import tx_execution_succeeded


ONE_GEN = 10**18
MIN_BETTING_WINDOW_SECONDS = 300
CONTRACT = os.environ.get("ANYBET_CONTRACT", "").strip()


def _fund(address, amount, tries=5):
    last = None
    for _ in range(tries):
        try:
            get_gl_client().fund_account(address, amount)
            return
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(3)
    raise RuntimeError(f"could not fund {address}: {last}")


@pytest.fixture(scope="module")
def contract():
    factory = get_contract_factory("AnyBet")
    house = get_accounts()[0]
    _fund(house.address, 5 * ONE_GEN)
    if CONTRACT:
        return factory.build_contract(contract_address=CONTRACT, account=house)
    return factory.deploy(args=[], account=house)


def test_empty_market_returns_an_empty_book(contract):
    """A market nobody has touched has a book, and it is empty - not an error,
    and not a missing field the caller has to guard against."""
    house = get_accounts()[0]
    close_ts = int(time.time()) + MIN_BETTING_WINDOW_SECONDS + 60
    assert tx_execution_succeeded(
        contract.connect(house).create_market(args=[
            "Does the book read back on an untouched market?",
            "Not for betting - this market exists to be read while empty. Answer UNKNOWN.",
            close_ts,
            "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
            ONE_GEN // 100,
            300,
        ]).transact()
    )

    markets = json.loads(contract.get_all_markets(args=[]).call() or "{}")
    mine = max(int(k) for k in markets)
    book = json.loads(contract.get_market_bets(args=[mine]).call())
    assert book == [], f"expected an empty list, got {book!r}"
    print(f"\nmarket {mine}: empty book reads back as []")


def test_seeded_books_carry_stakes_and_payouts(contract):
    """Every market with bets returns one row per bettor, and a settled market
    carries the payout the contract actually recorded."""
    markets = json.loads(contract.get_all_markets(args=[]).call() or "{}")
    checked = 0

    for mid, m in sorted(markets.items(), key=lambda kv: int(kv[0])):
        expected = int(m["yes_count"]) + int(m["no_count"])
        if not expected:
            continue

        book = json.loads(contract.get_market_bets(args=[int(mid)]).call())
        assert len(book) == expected, f"market {mid}: {len(book)} rows for {expected} bets"

        # The rows have to add back up to the pools the market reports, or the
        # book is describing a different market than the card above it.
        staked = {"YES": 0, "NO": 0}
        for row in book:
            assert row["side"] in ("YES", "NO")
            assert row["address"].startswith("0x")
            staked[row["side"]] += int(row["amount"])
        assert staked["YES"] == int(m["yes_pool"])
        assert staked["NO"] == int(m["no_pool"])

        if m["status"] == "RESOLVED" and m["settlement"] == "PAID":
            winners = [r for r in book if int(r["payout"]) > 0]
            assert winners, f"market {mid} paid out but no row records a payout"
            assert all(r["side"] == m["outcome"] for r in winners), \
                "a payout was recorded against the losing side"
            fee = (int(m["yes_pool"]) + int(m["no_pool"])) * int(m["fee_bps"]) // 10000
            distributable = int(m["yes_pool"]) + int(m["no_pool"]) - fee
            paid = sum(int(r["payout"]) for r in winners)
            # Integer division on each share leaves a few wei behind; anything
            # more than that would mean the pool did not balance.
            assert 0 <= distributable - paid < len(winners), \
                f"market {mid}: paid {paid} of {distributable}"
            print(f"market {mid}: {len(book)} bets, {len(winners)} paid {paid / ONE_GEN:.3f} GEN")
        else:
            print(f"market {mid}: {len(book)} bets, unsettled")
        checked += 1

    assert checked, "no market on this contract has any bets to check"


def test_contract_is_solvent_on_chain(contract):
    """The invariant that matters most, measured against the real balance.

    Direct tests can only check the ledger against itself. This compares what
    the contract says it owes with the GEN the chain says it actually holds -
    if those ever diverge, every payout figure above is fiction.
    """
    import requests

    stats = contract.get_stats(args=[]).call()
    owed = (int(stats["player_balances"])
            + int(stats["at_risk_in_markets"])
            + int(stats["unclaimed_winnings"]))
    treasury = int(stats["treasury"])

    held = None
    for _ in range(6):
        try:
            body = requests.post(
                "https://studio.genlayer.com/api",
                json={"jsonrpc": "2.0", "method": "eth_getBalance",
                      "params": [contract.address, "latest"], "id": 1},
                timeout=60,
            ).json()
            held = int(body["result"], 16)
            break
        except Exception:  # noqa: BLE001
            time.sleep(4)
    assert held is not None, "could not read the contract balance"

    dust = held - owed - treasury
    print(f"holds {held} wei, owes {owed}, fees {treasury}, unallocated {dust}")

    assert held >= owed, f"INSOLVENT: owes {owed} wei but holds only {held}"
    assert dust >= 0, "fees are not fully backed by the balance"

    # Whatever is left over is rounding dust and nothing else.
    #
    # Each winner's share is `stake * distributable // winner_pool`, and floor
    # division discards under one wei per winner, so the contract keeps a few
    # wei per settled market that is owed to nobody and cannot be withdrawn -
    # not by a player, and not by the owner, since it never reaches the
    # treasury. Economically nothing, but worth bounding rather than ignoring:
    # a gap growing faster than this would mean money arriving with no claim
    # attached to it.
    markets = json.loads(contract.get_all_markets(args=[]).call() or "{}")
    winners = 0
    for mid, m in markets.items():
        if m.get("status") == "RESOLVED" and m.get("settlement") == "PAID":
            book = json.loads(contract.get_market_bets(args=[int(mid)]).call())
            winners += sum(1 for r in book if int(r["payout"]) > 0)

    assert dust < max(winners, 1), (
        f"{dust} wei unallocated across {winners} winning bets - more than "
        "floor division can explain"
    )
    print(f"unallocated {dust} wei across {winners} winning bets - rounding dust only")
