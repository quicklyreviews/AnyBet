"""Resolve every market that has closed and is still waiting.

Not a test - an operator action, and a permissionless one: resolve_market() has
no owner check, so this script has no more authority than any visitor clicking
the button. It exists because doing six of them by hand is tedious, not because
it can do anything a person could not.

    gltest tests/integration/resolve_closed.py --network studionet -v -s

Each call sends every validator to fetch the market's sources and run the same
prompt, so expect roughly a minute apiece.
"""

import json
import os
import time

from gltest import get_contract_factory, get_accounts
from gltest.assertions import tx_execution_succeeded


ONE_GEN = 10**18
CONTRACT = os.environ.get(
    "ANYBET_CONTRACT", "0x99F7ECE24CdfFb9Eb5C7493Cb6bAC42DAc3B3774"
).strip()


def test_resolve_every_closed_market():
    caller = get_accounts()[0]
    factory = get_contract_factory("AnyBet")
    contract = factory.build_contract(contract_address=CONTRACT, account=caller)
    print(f"\nAnyBet at {contract.address}")

    markets = json.loads(contract.get_all_markets(args=[]).call() or "{}")
    now = int(time.time())
    due = [
        m for m in markets.values()
        if m.get("status") == "OPEN" and int(m["close_ts"]) <= now
    ]

    if not due:
        soonest = min(
            (int(m["close_ts"]) for m in markets.values() if m.get("status") == "OPEN"),
            default=None,
        )
        print("Nothing due." + (f" Next closes in {soonest - now}s." if soonest else ""))
        return

    print(f"{len(due)} market(s) waiting on a verdict")
    for m in due:
        mid = int(m["id"])
        print(f"\n--- market {mid}: {m['question']}")
        receipt = contract.connect(caller).resolve_market(args=[mid]).transact()
        if not tx_execution_succeeded(receipt):
            print("  resolution did not reach consensus - validators disagreed")
            continue

        fresh = contract.get_market(args=[mid]).call()
        print(f"  {fresh['outcome']} / {fresh['settlement']}")
        print(f"  {fresh['reasoning']}")

        book = json.loads(contract.get_market_bets(args=[mid]).call())
        book.sort(key=lambda b: int(b["amount"]), reverse=True)
        for b in book:
            paid = int(b["payout"])
            staked = int(b["amount"])
            verdict = (
                f"returned {paid / ONE_GEN:.3f}" if paid else "lost"
            )
            print(f"    {b['address'][:10]}... {b['side']:<3} staked {staked / ONE_GEN:>6.3f}  {verdict}")
