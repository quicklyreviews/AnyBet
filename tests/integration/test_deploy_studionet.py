"""Integration tests — real GenVM, real network, real consensus.

Run against StudioNet (gasless):

    gltest tests/integration/ --network studionet -v -s

These are deliberately separate from tests/direct/, which stubs the `genlayer`
module out entirely. Nothing here is mocked: a pass means the contract really
deployed, really executed under GenVM, and — for the resolution test — that
independent validators really agreed on an LLM verdict.
"""

import json
import time

import pytest
from gltest import get_contract_factory, get_default_account
from gltest.assertions import tx_execution_succeeded


MIN_BETTING_WINDOW_SECONDS = 300  # must match contracts/any_bet.py


@pytest.fixture(scope="module")
def contract():
    """Deploy AnyBet once and reuse it across this module's tests."""
    factory = get_contract_factory("AnyBet")
    return factory.deploy(args=[])


def test_deploy_and_initial_state(contract):
    """The contract deploys under real GenVM and starts empty.

    This is the check `genvm-lint` cannot do: the runner comment, the storage
    field types, and the calldata encodability of every return value are only
    truly exercised by a real deployment.
    """
    assert contract.address is not None
    print(f"\nDeployed AnyBet at: {contract.address}")

    stats = contract.get_stats(args=[]).call()
    assert stats["total_markets"] == 0
    assert stats["total_bets_placed"] == 0

    owner = contract.get_owner(args=[]).call()
    assert owner == str(get_default_account().address).lower()


def test_create_market_persists_deadline(contract):
    """Create a market and read it back.

    The point of this test is the deadline: `close_ts` is computed from the
    contract's own clock (`_now()`, i.e. `datetime.datetime.now()`) and written
    to state. If that clock were not deterministic under GenVM, validators would
    disagree on the resulting state and this transaction would never reach
    ACCEPTED — which is exactly why it is asserted here rather than assumed.
    """
    close_ts = int(time.time()) + MIN_BETTING_WINDOW_SECONDS + 60
    receipt = contract.create_market(
        args=[
            "Is the Bitcoin price above 1 USD?",
            "YES if the fetched source shows a BTC/USD price greater than 1. NO otherwise.",
            close_ts,
            "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
            10**15,  # min_bet: 0.001 GEN
            300,     # fee_bps: 3%
        ]
    ).transact()
    assert tx_execution_succeeded(receipt)

    market = contract.get_market(args=[1]).call()
    assert market["status"] == "OPEN"
    assert market["question"] == "Is the Bitcoin price above 1 USD?"
    assert int(market["close_ts"]) == close_ts
    print(f"\nMarket 1 open until {market['close_ts']}")

    open_markets = json.loads(contract.get_open_markets(args=[]).call())
    assert len(open_markets) == 1


def test_resolve_before_close_is_rejected(contract):
    """The deadline is enforced on-chain, not just in the UI."""
    receipt = contract.resolve_market(args=[1]).transact(
        wait_transaction_status="FINALIZED"
    )
    assert not tx_execution_succeeded(receipt)
