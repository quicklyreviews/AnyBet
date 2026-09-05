"""Let the demo cohort collect what it won, and cash out.

Winnings in AnyBet are recorded, not pushed: resolution fixes what each bet is
owed and the winner claims it. That is a deliberate product decision, and it has
a consequence this script exists to honour - a winner who cannot sign can never
be paid.

The first demo run learned that the hard way. It minted wallets in memory and
dropped them on exit, so the book ended up full of "returned N - unclaimed"
rows that nothing could ever collect. Wallets now live in demo-wallets.json, and
this is what makes that persistence worth having.

    gltest tests/integration/demo_claim.py --network studionet -v -s
"""

import json
import os
import pathlib
import time
from concurrent.futures import ThreadPoolExecutor

from genlayer_py import create_account
from gltest import get_contract_factory, get_accounts
from gltest.assertions import tx_execution_succeeded


ONE_GEN = 10**18
CONTRACT = os.environ.get(
    "ANYBET_CONTRACT", "0x99F7ECE24CdfFb9Eb5C7493Cb6bAC42DAc3B3774"
).strip()
WALLETS_FILE = pathlib.Path(__file__).resolve().parents[2] / "demo-wallets.json"
WITHDRAW = os.environ.get("DEMO_WITHDRAW", "").lower() in ("1", "true", "yes")


def test_cohort_collects_its_winnings():
    if not WALLETS_FILE.exists():
        print(f"\nNo {WALLETS_FILE.name} - run demo_run.py first")
        return

    keys = json.loads(WALLETS_FILE.read_text(encoding="utf-8")).get("keys", [])
    wallets = [create_account(k) for k in keys]
    print(f"\n{len(wallets)} wallets in the cohort")

    factory = get_contract_factory("AnyBet")
    contract = factory.build_contract(
        contract_address=CONTRACT, account=get_accounts()[0]
    )

    owed = []
    for w in wallets:
        pending = json.loads(contract.get_claimable(args=[w.address]).call() or "[]")
        total = sum(int(p["payout"]) for p in pending)
        if total:
            owed.append((w, total, len(pending)))

    if not owed:
        print("Nothing outstanding - every winner has already collected.")
        return

    print(f"{len(owed)} wallets have {sum(t for _, t, _ in owed) / ONE_GEN:.3f} GEN waiting")

    def collect(entry):
        wallet, total, count = entry
        ok = tx_execution_succeeded(
            contract.connect(wallet).claim_all().transact()
        )
        return wallet, total, count, ok

    # claim_all() sweeps every market a wallet won in, so this is one
    # transaction per winner however many markets they were in.
    with ThreadPoolExecutor(max_workers=min(len(owed), 8)) as pool:
        for wallet, total, count, ok in pool.map(collect, owed):
            mark = "ok" if ok else "FAILED"
            print(f"  {wallet.address[:10]}... collected {total / ONE_GEN:>7.3f} GEN "
                  f"from {count} market(s)  {mark}")

    if WITHDRAW:
        print("\nWithdrawing balances back to the wallets themselves...")
        def cash_out(w):
            try:
                return tx_execution_succeeded(
                    contract.connect(w).withdraw_all().transact()
                )
            except Exception:
                return False  # nothing to withdraw is not a failure worth raising
        with ThreadPoolExecutor(max_workers=8) as pool:
            done = sum(1 for ok in pool.map(cash_out, wallets) if ok)
        print(f"  {done} wallets cashed out")

    time.sleep(3)
    stats = contract.get_stats(args=[]).call()
    print(f"\nStill unclaimed across the contract: "
          f"{int(stats['unclaimed_winnings']) / ONE_GEN:.3f} GEN")
