"""The test this whole project rests on: does an LLM verdict actually reach
validator consensus on a real network?

Everything else can be faked. This cannot — `resolve_market()` makes each
validator independently fetch the source URL over the real internet and run the
real resolution prompt against a real model, and the transaction only reaches
ACCEPTED if their normalized outcomes match. A pass here means the equivalence
strategy works; a failure means the contract's core premise does not.

Slow by construction: the contract enforces a 5-minute minimum betting window
(so a market cannot close before anyone can realistically bet), and every
transaction waits for consensus. Budget ~8 minutes.

    gltest tests/integration/test_resolution_consensus.py --network studionet -v -s
"""

import json
import time

import pytest
from gltest import get_contract_factory, get_accounts, get_gl_client
from gltest.assertions import tx_execution_succeeded


MIN_BETTING_WINDOW_SECONDS = 300  # must match contracts/any_bet.py
ONE_GEN = 10**18

# Chosen so the correct answer is not in doubt: if a resolver reading Binance's
# live ticker cannot get this right, nothing subtler is worth testing. The point
# under test is validator *agreement*, not model cleverness.
QUESTION = "Is the Bitcoin price above 1 US dollar?"
CRITERIA = (
    "Read the BTC/USD price from any of the source JSON bodies. "
    "Answer YES if that price is greater than 1. Answer NO if it is not."
)
# Binance is deliberately absent: it answers GenLayer's validator nodes with
# HTTP 200 and a body saying "Service unavailable from a restricted location",
# so a market sourced from it resolves UNKNOWN no matter what the price is.
# Verified with probe_sources.py -- run that before trusting any new source.
# Three are passed rather than one because a single source is not survivable:
# validators fetch independently and any one host can rate-limit or block some
# of them, and the contract puts every fetched body in front of the resolver.
SOURCES = ",".join([
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    "https://api.coinbase.com/v2/prices/BTC-USD/spot",
    "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
])


def _fund(address, amount=10 * ONE_GEN, tries=5):
    """StudioNet accounts start empty and `deposit()` is payable, so the two
    bettors have to be funded before they can stake anything. DNS to
    studio.genlayer.com is intermittently flaky on this machine, hence retries.
    """
    last = None
    for _ in range(tries):
        try:
            client = get_gl_client()
            client.fund_account(address, amount)
            return
        except Exception as e:  # noqa: BLE001 - retrying any transport failure
            last = e
            time.sleep(3)
    raise RuntimeError(f"could not fund {address}: {last}")


@pytest.mark.slow
def test_llm_resolution_reaches_validator_consensus():
    accounts = get_accounts()
    alice, bob = accounts[0], accounts[1]
    _fund(alice.address)
    _fund(bob.address)

    factory = get_contract_factory("AnyBet")
    contract = factory.deploy(args=[], account=alice)
    print(f"\nAnyBet deployed at {contract.address}")

    close_ts = int(time.time()) + MIN_BETTING_WINDOW_SECONDS + 30
    assert tx_execution_succeeded(
        contract.connect(alice).create_market(
            args=[QUESTION, CRITERIA, close_ts, SOURCES, ONE_GEN // 100, 300]
        ).transact()
    )
    print(f"Market 1 created, closes at {close_ts}")

    # Both sides must have real money on them or the market voids as one-sided,
    # which would settle without ever testing the resolver.
    for who, side in ((alice, "YES"), (bob, "NO")):
        assert tx_execution_succeeded(
            contract.connect(who).deposit().transact(value=ONE_GEN)
        )
        assert tx_execution_succeeded(
            contract.connect(who).bet(args=[1, side, ONE_GEN // 2]).transact()
        )
        print(f"{who.address[:10]}... bet {side}")

    market = contract.get_market(args=[1]).call()
    assert int(market["yes_pool"]) > 0 and int(market["no_pool"]) > 0

    remaining = close_ts - int(time.time())
    if remaining > 0:
        print(f"Waiting {remaining}s for the betting window to close...")
        time.sleep(remaining + 5)

    print("Resolving -- real web fetch + real LLM, across independent validators...")
    receipt = contract.connect(alice).resolve_market(args=[1]).transact()
    assert tx_execution_succeeded(receipt), (
        "resolve_market did not reach consensus -- validators disagreed on the "
        "LLM outcome, which would mean the equivalence strategy is wrong"
    )

    market = contract.get_market(args=[1]).call()
    print(f"Outcome: {market['outcome']} / {market['settlement']}")
    print(f"Reasoning: {market['reasoning']}")

    assert market["status"] == "RESOLVED"
    assert market["outcome"] == "YES", (
        f"resolver said {market['outcome']!r} for a question whose answer is "
        f"unambiguously YES; reasoning: {market['reasoning']!r}"
    )
    assert market["settlement"] == "PAID"

    # Alice backed YES against a real NO stake, so she is owed the pool minus
    # the 3% fee: 1 GEN staked in total, 0.97 GEN distributable, all of it hers.
    claimable = json.loads(contract.get_claimable(args=[alice.address]).call())
    assert len(claimable) == 1
    expected = ONE_GEN - (ONE_GEN * 300 // 10000)
    assert int(claimable[0]["payout"]) == expected

    assert tx_execution_succeeded(contract.connect(alice).claim(args=[1]).transact())
    balance = int(contract.get_balance(args=[alice.address]).call())
    assert balance == ONE_GEN // 2 + expected
    print(f"Alice collected {expected} wei; balance now {balance}")
