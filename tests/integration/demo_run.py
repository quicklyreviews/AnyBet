"""Populate a market with real bettors, so the book on screen is a real book.

Not a test - a seeding run. It deploys a fresh contract, creates one market,
then puts a handful of independent wallets on both sides of it. Every wallet is
a real StudioNet account with its own key, and every bet is a real transaction:
what the interface then shows is the contract's own record, not a replay of a
script.

    gltest tests/integration/demo_run.py --network studionet -v -s

Bets are sent in parallel. Nonces are per-account, so six wallets acting at once
is six independent transactions rather than a queue - which turns a fifteen
minute sequence into about three rounds of consensus.
"""

import json
import os
import pathlib
import random
import time
from concurrent.futures import ThreadPoolExecutor

from genlayer_py import create_account
from gltest import get_contract_factory, get_accounts, get_gl_client, create_accounts
from gltest.assertions import tx_execution_succeeded


ONE_GEN = 10**18
WALLET_GRANT = 20 * ONE_GEN           # headroom over the largest possible stake
DEPOSIT = 12 * ONE_GEN                # what each wallet moves into the contract
MIN_BET = ONE_GEN // 2                # 0.5 GEN, under the smallest stake
BETTING_MINUTES = 15

# How many independent bettors to put in the book. Wallets are minted here
# rather than taken from the configured set, which caps out at ten - and the
# whole point is that one account cannot make a market: a market only one side
# ever bets on has no counterparty, so it voids and refunds however good the
# question was.
BETTORS = int(os.environ.get("DEMO_BETTORS", 12))

# Where the cohort lives between runs.
#
# The first version of this script minted wallets in memory and dropped them
# when it exited, which quietly stranded money: the contract had already
# recorded what each one was owed, but nothing could ever claim it, because
# claiming is signed by the winner and the winner no longer existed. A demo that
# creates unclaimable winnings is demonstrating the wrong thing.
#
# StudioNet keys, worth nothing, kept out of version control all the same -
# writing private keys to disk is a habit worth not forming.
WALLETS_FILE = pathlib.Path(__file__).resolve().parents[2] / "demo-wallets.json"

# Sides alternate so both pools are funded. Stakes are random within 1-5 GEN, so
# the book has a real shape rather than N identical rows and the implied price
# ends up somewhere worth reading.

# Seeded per run rather than fixed: two runs should not produce the same book,
# but one run stays reproducible from the seed it prints.
SEED = int(os.environ.get("DEMO_SEED", time.time()))

# Attach to an existing deployment instead of making another, so seeded markets
# accumulate on the contract the frontend already points at.
EXISTING = os.environ.get("ANYBET_CONTRACT", "").strip()


def random_stake(rng):
    """1.000 to 5.000 GEN, to the milli-GEN."""
    return rng.randint(1000, 5000) * (ONE_GEN // 1000)

QUESTION = "Will Bitcoin be above 60,000 USD when this market closes?"
CRITERIA = (
    "Read the BTC/USD price from any of the source JSON bodies. Answer YES if that "
    "price is greater than 60000, and NO if it is not. If none of the sources "
    "returned a usable price, answer UNKNOWN."
)
SOURCES = ",".join([
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    "https://api.coinbase.com/v2/prices/BTC-USD/spot",
    "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
])


def load_or_mint_wallets(n):
    """Reuse the saved cohort, topping it up if a bigger one is asked for."""
    saved = []
    if WALLETS_FILE.exists():
        saved = json.loads(WALLETS_FILE.read_text(encoding="utf-8")).get("keys", [])

    minted = 0
    while len(saved) < n:
        saved.append(create_accounts(n_accounts=1)[0].key.hex())
        minted += 1
    if minted:
        WALLETS_FILE.write_text(json.dumps({"keys": saved}, indent=2), encoding="utf-8")

    where = f"minted {minted} new" if minted else "reused"
    print(f"{where}; cohort of {len(saved)} wallets in {WALLETS_FILE.name}")
    return [create_account(k) for k in saved[:n]]


def _fund(address, amount, tries=5):
    """StudioNet accounts start empty and deposit() is payable. DNS to
    studio.genlayer.com is intermittently flaky here, hence the retries."""
    last = None
    for _ in range(tries):
        try:
            get_gl_client().fund_account(address, amount)
            return
        except Exception as e:  # noqa: BLE001 - retrying any transport failure
            last = e
            time.sleep(3)
    raise RuntimeError(f"could not fund {address}: {last}")


def test_seed_a_market_with_real_bettors():
    rng = random.Random(SEED)
    print(f"seed {SEED} - re-run with DEMO_SEED={SEED} for the same book")

    house = get_accounts()[0]
    bettors = load_or_mint_wallets(BETTORS)
    plan = [("YES" if i % 2 == 0 else "NO", random_stake(rng)) for i in range(BETTORS)]

    _fund(house.address, 5 * ONE_GEN)
    for a in bettors:
        _fund(a.address, WALLET_GRANT)
    print(f"\nFunded {len(bettors)} wallets with {WALLET_GRANT // ONE_GEN} GEN each")

    factory = get_contract_factory("AnyBet")
    if EXISTING:
        contract = factory.build_contract(contract_address=EXISTING, account=house)
        print(f"Using existing AnyBet at {contract.address}")
    else:
        contract = factory.deploy(args=[], account=house)
        print(f"AnyBet deployed at {contract.address}")

    # Whatever this run creates is the next id, not necessarily 1.
    before = json.loads(contract.get_all_markets(args=[]).call() or "{}")
    market_id = max((int(k) for k in before), default=0) + 1

    close_ts = int(time.time()) + BETTING_MINUTES * 60
    assert tx_execution_succeeded(
        contract.connect(house).create_market(
            args=[QUESTION, CRITERIA, close_ts, SOURCES, MIN_BET, 300]
        ).transact()
    )
    print(f"Market {market_id} open until {close_ts}")

    def deposit(account):
        return tx_execution_succeeded(
            contract.connect(account).deposit().transact(value=DEPOSIT)
        )

    def bet(pair):
        account, (side, amount) = pair
        ok = tx_execution_succeeded(
            contract.connect(account).bet(args=[market_id, side, amount]).transact()
        )
        return account.address, side, amount, ok

    # Capped: a few dozen simultaneous transactions is a load test of the RPC,
    # not a demo, and the node rate-limits before it helps.
    with ThreadPoolExecutor(max_workers=min(len(bettors), 8)) as pool:
        print("Depositing from every wallet at once...")
        assert all(pool.map(deposit, bettors)), "a deposit failed"

        print("Placing bets...")
        for address, side, amount, ok in pool.map(bet, zip(bettors, plan)):
            print(f"  {address[:10]}... {side:<3} {amount / ONE_GEN:>6.3f} GEN  {'ok' if ok else 'FAILED'}")

    book = json.loads(contract.get_market_bets(args=[market_id]).call())
    market = contract.get_market(args=[market_id]).call()
    yes = int(market["yes_pool"])
    no = int(market["no_pool"])

    print(f"\nBook has {len(book)} bets from {len({b['address'] for b in book})} wallets")
    print(f"YES {yes / ONE_GEN:.3f} GEN   NO {no / ONE_GEN:.3f} GEN")
    print(f"implied YES {round(100 * yes / (yes + no))}%")
    print(f"\nPoint the frontend at: {contract.address}")

    assert len(book) == len(plan)
    assert yes > 0 and no > 0, "both sides must have money or the market voids"
