/**
 * AnyBet - browser client.
 *
 * No build step: the import map in index.html pulls genlayer-js and viem from
 * esm.sh, the same approach GenPredict's frontend uses.
 *
 * Signing is the user's own wallet and nothing else. An earlier version also
 * offered a throwaway key kept in localStorage, which made trying the app
 * easier but handed people an account they were never told they had: open the
 * site in a second browser and money left in the first one is unreachable. A
 * market whose accounts evaporate with the browser cache is not one anybody
 * should put money into, so that option is gone.
 */
import { createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { TransactionStatus } from 'genlayer-js/types';
import { TEMPLATES } from './templates.js';
import { markSvg, faviconHref } from './brand.js';

const RPC = 'https://studio.genlayer.com/api';
const EXPLORER = 'https://genlayer-explorer.vercel.app';
const CONTRACT_STORAGE = 'anybet_contract_address';

// Deployed and verified end to end by tests/integration/test_resolution_consensus.py,
// then seeded with real bettors by tests/integration/demo_run.py.
const DEFAULT_CONTRACT = '0x99F7ECE24CdfFb9Eb5C7493Cb6bAC42DAc3B3774';

// Binance answers GenLayer's validator nodes with HTTP 200 and a body saying
// the service is unavailable from a restricted location, so a market sourced
// from it resolves UNKNOWN whatever the real answer is. Worth catching before
// somebody stakes on it rather than after.
const BLOCKED_SOURCE_HOSTS = ['binance.com'];

const ONE_GEN = 10n ** 18n;

const CHAIN_ID_HEX = '0xf22f'; // 61999
const MODE_STORAGE = 'anybet_signer_mode';
const GUIDE_STORAGE = 'anybet_guide';

/** The connected wallet. `mode` is null until somebody signs in. */
const signer = {
  mode: null,      // null = signed out; 'session' | 'wallet' once signed in
  account: null,   // viem LocalAccount in session mode, address string in wallet mode
  address: null,
  client: null,
  chainId: null,   // wallet mode only: what the wallet is actually on right now
};

// Chains a wallet is likely to be sitting on, so the panel can name the wrong
// one instead of showing a bare hex id nobody reads.
const KNOWN_CHAINS = {
  '0xf22f': 'GenLayer StudioNet',
  '0x1': 'Ethereum mainnet',
  '0xaa36a7': 'Sepolia',
  '0x89': 'Polygon',
  '0x38': 'BNB Chain',
  '0x2105': 'Base',
  '0xa4b1': 'Arbitrum One',
};

// Reading is not an account action, so it gets its own client and works signed
// out. Browsing the markets is how somebody decides whether to sign in at all;
// making them commit first would be asking for trust before showing anything.
let readClient = null;

let contractAddress = localStorage.getItem(CONTRACT_STORAGE) || DEFAULT_CONTRACT;
let markets = [];
let busy = false;

// --- small helpers ---------------------------------------------------

const $ = (id) => document.getElementById(id);

function toast(message, kind = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 9000 : 5000);
}

function gen(wei, dp = 3) {
  const n = typeof wei === 'bigint' ? wei : BigInt(wei || 0);
  return (Number(n) / Number(ONE_GEN)).toFixed(dp);
}

function toWei(genAmount) {
  const [whole, frac = ''] = String(genAmount).split('.');
  return BigInt(whole || 0) * ONE_GEN + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}

function shorten(addr) {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '-';
}

async function rpc(method, params, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      });
      const body = await res.json();
      if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
      return body.result;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw last;
}

/** Runs an action with the button disabled, so a slow consensus round cannot be
 *  double-submitted by an impatient second click. */
async function withBusy(label, fn) {
  if (busy) { toast('Still waiting on the previous transaction', 'info'); return; }
  busy = true;
  document.body.classList.add('busy');
  try {
    toast(`${label}... this takes about a minute to reach consensus`);
    const result = await fn();
    return result;
  } catch (e) {
    console.error(e);
    toast(cleanError(e), 'error');
  } finally {
    busy = false;
    document.body.classList.remove('busy');
  }
}

/** Contract errors arrive wrapped in a lot of transport noise; the useful part
 *  is the message the contract itself raised. */
function cleanError(e) {
  const raw = String(e?.message || e);
  const m = raw.match(/UserError[^"]*?:?\s*([^"'\\}]{5,200})/);
  if (m) return m[1].trim();
  return raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
}

// --- session wallet --------------------------------------------------

function isSignedIn() {
  return signer.mode !== null;
}

/** Every action that moves money goes through here first.
 *
 *  Signing in used to happen invisibly - the page minted a key on first load and
 *  started playing with it. That is friendlier right up until someone opens the
 *  site in another browser, finds a different account, and cannot see the money
 *  they left behind. An account you were never told you had is not an account
 *  you can keep. */
function requireSignIn(action = 'do that') {
  if (isSignedIn()) return true;
  toast(`Sign in to ${action}`, 'info');
  showLogin();
  return false;
}

function showLogin() {
  $('login-panel').hidden = false;
  $('login-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function signOut() {
  signer.mode = null;
  signer.account = null;
  signer.address = null;
  signer.client = null;
  signer.chainId = null;
  localStorage.removeItem(MODE_STORAGE);
  applyAuthUI();
  toast('Disconnected. Your wallet keeps its keys - nothing of yours was stored here.');
}

/** Shows the signed-in furniture or the sign-in panel, never both.
 *
 *  The create form is a drawer rather than a permanent fixture: it is long, and
 *  leaving it open above the markets buries the thing people came to look at. */
function applyAuthUI() {
  const inFlag = isSignedIn();
  $('btn-open-create').hidden = !inFlag;
  if (!inFlag) $('create-panel').hidden = true;
  $('login-panel').hidden = inFlag;
  $('wallet').hidden = !inFlag;
  $('btn-open-login').hidden = inFlag;
  if (inFlag) renderSignerBar();
  renderMarkets();
}

function getProvider() {
  return window.ethereum || window.okxwallet || null;
}

/** MetaMask reports "unrecognised chain" in more than one shape: sometimes as
 *  err.code, sometimes buried in err.data.originalError.code. Missing the
 *  nested one means never offering to add the network, and the switch just
 *  fails. */
function isUnknownChainError(err) {
  const codes = [
    err?.code,
    err?.data?.originalError?.code,
    err?.data?.code,
    err?.cause?.code,
  ];
  return codes.includes(4902) || codes.includes(-32603);
}

async function readChainId() {
  const provider = getProvider();
  if (!provider) return null;
  try {
    return await provider.request({ method: 'eth_chainId' });
  } catch {
    return null;
  }
}

/**
 * Put the wallet on StudioNet, and say plainly whether it worked.
 *
 * Returns true/false rather than throwing. Connecting and switching networks
 * are separate things: a refused or failed switch should leave the wallet
 * connected and the problem visible, not silently discard the account the user
 * just approved.
 */
async function ensureStudioChain() {
  const provider = getProvider();
  if (!provider) return false;
  if ((await readChainId()) === CHAIN_ID_HEX) return true;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (err) {
    if (!isUnknownChainError(err)) {
      console.error('switch chain failed', err);
      return (await readChainId()) === CHAIN_ID_HEX;
    }
    try {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_ID_HEX,
          chainName: 'GenLayer StudioNet',
          rpcUrls: [RPC],
          nativeCurrency: { name: 'GEN', symbol: 'GEN', decimals: 18 },
          blockExplorerUrls: [EXPLORER],
        }],
      });
      // Adding a network does not reliably select it, so ask again. Ignore a
      // failure here: the add may already have switched us.
      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: CHAIN_ID_HEX }],
        });
      } catch { /* checked below */ }
    } catch (addErr) {
      console.error('add chain failed', addErr);
      return false;
    }
  }
  return (await readChainId()) === CHAIN_ID_HEX;
}

function bindProviderEvents(provider) {
  if (provider._anybetBound) return;
  provider._anybetBound = true;

  provider.on?.('accountsChanged', async (accs) => {
    if (signer.mode !== 'wallet') return;
    if (!accs || !accs.length) { signOut(); return; }
    attachWallet(accs[0], provider);
    await refreshWallet();
    toast(`Switched to ${shorten(accs[0])}`);
  });

  // Reloading the page on every network change loses whatever the user was in
  // the middle of. Just re-read it and let the UI say where they are.
  provider.on?.('chainChanged', async (id) => {
    signer.chainId = id;
    renderSignerBar();
    await refreshWallet();
  });
}

/** The proven call shape from GenPredict: chain + account + provider, and no
 *  endpoint - handing it an HTTP endpoint as well is what stops writes going
 *  through the wallet for signing. */
function attachWallet(address, provider) {
  signer.mode = 'wallet';
  signer.account = address;
  signer.address = address;
  signer.client = createClient({ chain: studionet, account: address, provider });
  localStorage.setItem(MODE_STORAGE, 'wallet');
}

async function connectWallet({ silent = false } = {}) {
  const provider = getProvider();
  if (!provider) {
    if (!silent) toast('No wallet found - install MetaMask or another EVM wallet to play', 'error');
    return false;
  }

  let accounts;
  try {
    accounts = await provider.request({
      method: silent ? 'eth_accounts' : 'eth_requestAccounts',
    });
  } catch (e) {
    console.error('wallet connect rejected', e);
    if (!silent) toast(e?.code === 4001 ? 'Connection cancelled' : cleanError(e), 'error');
    return false;
  }
  if (!accounts || !accounts.length) {
    if (!silent) toast('Your wallet returned no accounts - unlock it and try again', 'error');
    return false;
  }

  // Register the account BEFORE touching the network. Switching chains can fail
  // or be refused, and none of that is a reason to throw away a wallet the user
  // just approved - which is exactly what the previous version did.
  attachWallet(accounts[0], provider);
  bindProviderEvents(provider);

  signer.chainId = await readChainId();
  if (signer.chainId !== CHAIN_ID_HEX) {
    const ok = await ensureStudioChain();
    signer.chainId = await readChainId();
    if (!ok && !silent) {
      toast('Connected, but your wallet is not on StudioNet - use the Switch network button', 'error');
    }
  }

  applyAuthUI();
  if (!silent && signer.chainId === CHAIN_ID_HEX) {
    toast(`Connected ${shorten(accounts[0])} on StudioNet - every action will ask you to sign`, 'success');
  }
  return true;
}

function renderSignerBar() {
  renderNetwork();
  $('signer-note').textContent =
    'Every action asks your wallet to sign. Consensus takes about a minute, so approve promptly - a market can close while the prompt is open.';
  $('wallet-address').textContent = shorten(signer.address);
  $('wallet-address').title = signer.address || '';
}

/** Says which network the wallet is on, and offers the fix when it is wrong.
 *
 *  A wallet is the one thing here that can wander onto another chain, so this
 *  is the one place the app has to check rather than assume. */
function renderNetwork() {
  const nameEl = $('network-name');
  const btn = $('btn-switch-chain');
  const id = signer.chainId;
  const onStudio = id === CHAIN_ID_HEX;
  if (onStudio) {
    nameEl.textContent = 'GenLayer StudioNet (61999)';
  } else if (id) {
    const known = KNOWN_CHAINS[id];
    nameEl.textContent = `${known || 'Unknown chain'} (${parseInt(id, 16)}) - wrong network`;
  } else {
    nameEl.textContent = 'Unknown';
  }
  nameEl.className = onStudio ? 'net-ok' : 'net-bad';
  btn.hidden = onStudio;
  // The badge dot is live state, not livery: amber the moment the wallet is
  // somewhere other than the chain this contract is deployed on.
  $('chain-dot').className = `dot ${onStudio || signer.mode !== 'wallet' ? 'ok' : 'bad'}`;
  $('chain-label').textContent = onStudio || signer.mode !== 'wallet'
    ? 'StudioNet 61999'
    : 'wrong network';
}

async function refreshWallet() {
  renderSignerBar();
  if (!signer.address) return;
  try {
    const balHex = await rpc('eth_getBalance', [signer.address, 'latest']);
    $('wallet-gas').textContent = gen(BigInt(balHex));
  } catch { /* leave the last known figure */ }
  try {
    const deposited = await read('get_balance', [signer.address]);
    $('wallet-balance').textContent = gen(deposited);
  } catch { /* contract may not be reachable yet */ }
}

// --- contract calls --------------------------------------------------

/** Reads retry, because DNS to studio.genlayer.com is intermittently flaky and a
 *  single dropped lookup would otherwise leave a field showing "-" for good. */
async function read(functionName, args = [], tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await (readClient || signer.client).readContract({ address: contractAddress, functionName, args });
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw last;
}

async function write(functionName, args = [], value = 0n) {
  // A wallet will sign for whatever chain it happens to be on, and a signature
  // against the wrong one is a confusing failure rather than a loud error.
  if (signer.mode === 'wallet') {
    const ok = await ensureStudioChain();
    signer.chainId = await readChainId();
    renderNetwork();
    if (!ok) {
      throw new Error('Your wallet is not on GenLayer StudioNet (chain 61999). Switch network and try again.');
    }
  }
  const hash = await signer.client.writeContract({ address: contractAddress, functionName, args, value });
  await signer.client.waitForTransactionReceipt({
    hash, status: TransactionStatus.ACCEPTED, interval: 3000, retries: 60,
  });
  // ACCEPTED does not mean a read will see it yet: reading straight after a
  // successful bet returned the pre-transaction pools, so the success toast
  // appeared over unchanged numbers, which reads as a failure. Waiting a beat
  // before the caller re-reads costs a couple of seconds and removes that.
  await new Promise((r) => setTimeout(r, 4000));
  return hash;
}

// --- markets ---------------------------------------------------------

/** What a stake on this side would actually pay, quoted the way it will settle.
 *
 *  A one-sided market is not a 0.97x bet - it voids and refunds in full, so the
 *  honest number is 1.00x. Deriving a multiplier from the lone pool would
 *  advertise a figure below 1x that the contract can never pay, which is the
 *  most misleading thing this page could show. */
function impliedMultiplier(market, side) {
  const yes = BigInt(market.yes_pool || 0);
  const no = BigInt(market.no_pool || 0);
  const winner = side === 'YES' ? yes : no;
  if (winner === 0n) return null;
  if (yes === 0n || no === 0n) return { refund: true, value: 1 };
  const total = yes + no;
  const distributable = total - (total * BigInt(market.fee_bps) / 10000n);
  return { refund: false, value: Number(distributable * 1000n / winner) / 1000 };
}

/** A market can void for two quite different reasons, and saying the wrong one
 *  is worse than saying nothing: the resolver may have failed to decide, or it
 *  may have decided perfectly well on a market nobody took the other side of.
 *  Returns null when the market actually paid out. */
function voidReason(market) {
  if (!market || market.settlement !== 'VOID') return null;
  if (market.outcome === 'UNKNOWN') {
    return 'Voided - the evidence did not settle it, everyone refunded';
  }
  return `Voided - resolved ${market.outcome}, but nobody took the other side, so everyone is refunded`;
}

function statusOf(market) {
  const now = Math.floor(Date.now() / 1000);
  if (market.status === 'RESOLVED') {
    if (market.settlement !== 'VOID') return { key: 'resolved', label: `Settled ${market.outcome}` };
    return {
      key: 'resolved',
      label: market.outcome === 'UNKNOWN' ? 'Voided - undecidable' : `Voided - ${market.outcome}, unopposed`,
    };
  }
  if (market.status === 'CANCELLED') return { key: 'cancelled', label: 'Cancelled' };
  const left = Number(market.close_ts) - now;
  if (left <= 0) return { key: 'closed', label: 'Closed - awaiting resolution' };
  if (left <= CONSENSUS_BUFFER_SECONDS) {
    return { key: 'open', label: `Closes in ${countdown(left)} - too late to bet`, tooLate: true };
  }
  return { key: 'open', label: `Closes in ${countdown(left)}` };
}

/** Seconds appear inside the last five minutes and not before.
 *
 *  A market four hours out does not need a second hand, and one showing a
 *  frozen "4m" for a minute at a time looks broken rather than calm. The last
 *  few minutes are also the only ones anybody is watching, because that is
 *  when the decision to bet is actually made. */
function countdown(seconds) {
  if (seconds <= 0) return 'a moment';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (seconds >= 300) return `${m}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// A bet is a transaction, and a transaction needs about a minute to reach
// consensus. Inside that window a bet will very likely be rejected on arrival
// for a market that has already closed - so say so before someone spends the
// wait finding out.
const CONSENSUS_BUFFER_SECONDS = 75;
const TOO_LATE_HINT =
  'A bet needs about a minute to reach consensus, and this market closes sooner than that';

/** The contract already counts these; the page was ignoring them. Shown because
 *  a market list with no sense of scale reads like a mockup. */
async function loadStats() {
  try {
    const st = await read('get_stats');
    setText($('stat-markets'), String(st.total_markets ?? '-'));
    setText($('stat-bets'), String(st.total_bets_placed ?? '-'));
    setText($('stat-volume'), `${gen(BigInt(st.total_volume || 0), 2)} GEN`);
    setText($('stat-atrisk'), `${gen(BigInt(st.at_risk_in_markets || 0), 2)} GEN`);
  } catch { /* leave the dashes; this is decoration, not a blocker */ }
}

async function loadMarkets() {
  const raw = await read('get_all_markets');
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  markets = sortForDisplay(Object.values(parsed || {}));
  renderMarkets();
  await Promise.all([refreshClaimable(), loadStats()]);
}

// Live elements of each rendered card, so the ticking countdown and the polled
// pool figures can be written straight into the DOM. Re-rendering the list
// instead would blow away whatever the user was typing into a stake field, and
// on a chain where a bet takes a minute to land that is a real loss.
const cardIndex = new Map();

/** Live markets first, then the ones waiting to be resolved, then history.
 *  Newest-first alone buries an open market under a week of settled ones. */
function sortForDisplay(list) {
  const rank = (m) => ({ open: 0, closed: 1 }[statusOf(m).key] ?? 2);
  return list.sort((a, b) => rank(a) - rank(b) || Number(b.id) - Number(a.id));
}

function renderMarkets() {
  const host = $('markets');
  cardIndex.clear();
  if (!markets.length) {
    host.innerHTML = '<p class="empty">No markets yet. Open the first one.</p>';
    return;
  }
  host.innerHTML = '';
  for (const m of markets) {
    const state = statusOf(m);
    const yes = BigInt(m.yes_pool || 0);
    const no = BigInt(m.no_pool || 0);
    const card = document.createElement('article');
    card.className = `market ${state.key}`;
    const badgeClass = `badge ${state.key}${state.tooLate ? ' late' : ''}`;

    const yesMult = impliedMultiplier(m, 'YES');
    const noMult = impliedMultiplier(m, 'NO');
    const betCount = Number(m.yes_count || 0) + Number(m.no_count || 0);

    card.innerHTML = `
      <div class="market-head">
        <h3>${escapeHtml(m.question)}</h3>
        <span class="${badgeClass}">${state.label}</span>
      </div>
      <p class="criteria">${escapeHtml(m.criteria)}</p>
      <div class="book">
        <div class="odds-bar" title="Where the money sits right now">
          <div class="odds-yes" style="width:${impliedPct(m)}%"></div>
          <div class="odds-no" style="width:${100 - impliedPct(m)}%"></div>
        </div>
        <div class="book-rows">
          <div class="pool yes">
            <span class="side">YES</span>
            <span class="pct">${hasMoney(m) ? impliedPct(m) + '%' : '--'}</span>
            <span class="amount">${gen(yes)} GEN</span>
            <span class="mult">${formatMult(yesMult)}</span>
          </div>
          <div class="pool no">
            <span class="side">NO</span>
            <span class="pct">${hasMoney(m) ? (100 - impliedPct(m)) + '%' : '--'}</span>
            <span class="amount">${gen(no)} GEN</span>
            <span class="mult">${formatMult(noMult)}</span>
          </div>
        </div>
      </div>
      ${m.status === 'RESOLVED' && m.reasoning ? `
        <div class="verdict">
          <span class="label">GenLayer validators agreed</span>
          <p>${escapeHtml(m.reasoning)}</p>
        </div>` : ''}
      <div class="market-actions"></div>
      ${betCount ? `<div class="book-toggle">
        <button class="link" data-book="${escapeHtml(String(m.id))}">Show the book (${betCount})</button>
      </div>
      <div class="book-log" hidden></div>` : ''}
    `;

    const actions = card.querySelector('.market-actions');

    if (state.key === 'open') {
      const stake = document.createElement('input');
      stake.type = 'number';
      stake.step = '0.001';
      stake.min = gen(BigInt(m.min_bet), 3);
      stake.value = gen(BigInt(m.min_bet), 3);
      stake.className = 'stake';
      actions.appendChild(stake);

      for (const side of ['YES', 'NO']) {
        const b = document.createElement('button');
        b.className = side.toLowerCase();
        b.textContent = `Bet ${side}`;
        b.onclick = () => (isSignedIn()
          ? placeBet(m, side, stake.value)
          : requireSignIn('place a bet'));
        if (state.tooLate) {
          b.disabled = true;
          b.title = TOO_LATE_HINT;
        }
        actions.appendChild(b);
      }
    } else if (state.key === 'closed') {
      const b = document.createElement('button');
      b.textContent = 'Resolve now';
      b.title = 'Anyone can trigger resolution - no admin key involved';
      b.onclick = () => resolveMarket(m);
      actions.appendChild(b);
    }

    const bookBtn = card.querySelector('[data-book]');
    if (bookBtn) bookBtn.onclick = () => toggleBook(m, card, bookBtn);

    cardIndex.set(String(m.id), {
      card,
      badge: card.querySelector('.badge'),
      yesAmount: card.querySelector('.pool.yes .amount'),
      yesMult: card.querySelector('.pool.yes .mult'),
      yesPct: card.querySelector('.pool.yes .pct'),
      noAmount: card.querySelector('.pool.no .amount'),
      noMult: card.querySelector('.pool.no .mult'),
      noPct: card.querySelector('.pool.no .pct'),
      barYes: card.querySelector('.odds-yes'),
      barNo: card.querySelector('.odds-no'),
      betButtons: [...card.querySelectorAll('.market-actions button.yes, .market-actions button.no')],
      statusKey: state.key,
    });

    host.appendChild(card);
  }
}

/**
 * Opens one market's book: who is on which side, and for how much.
 *
 * Fetched on demand rather than with the list, because it is one extra call per
 * market and most people want the price, not the ledger. Once loaded it stays,
 * so a second click just hides it again.
 *
 * The rows come from the contract's own record via get_market_bets - this is
 * the book, not a log of what this browser happened to watch.
 */
async function toggleBook(market, card, button) {
  const host = card.querySelector('.book-log');
  if (!host) return;

  if (!host.hidden) {
    host.hidden = true;
    button.textContent = `Show the book (${Number(market.yes_count || 0) + Number(market.no_count || 0)})`;
    return;
  }

  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'Reading the contract...';
  try {
    const rows = JSON.parse(await read('get_market_bets', [Number(market.id)]) || '[]');
    host.innerHTML = rows.length ? '' : '<p class="book-empty">No bets recorded.</p>';
    // Biggest stake first: in a parimutuel pool that is also who has most of
    // the say in the price above.
    rows.sort((a, b) => (BigInt(b.amount || 0) > BigInt(a.amount || 0) ? 1 : -1));
    for (const r of rows) {
      const settled = Number(r.settled) === 1;
      const payout = BigInt(r.payout || 0);
      const row = document.createElement('div');
      row.className = `book-row ${r.side === 'YES' ? 'yes' : 'no'}`;
      row.innerHTML = `
        <code class="who">${escapeHtml(shorten(r.address))}</code>
        <span class="what">${escapeHtml(r.side)}</span>
        <span class="how-much">${gen(BigInt(r.amount || 0))} GEN</span>
        <span class="outcome">${
          !settled ? 'riding'
            : payout > 0n ? `returned ${gen(payout)}${Number(r.claimed) === 1 ? '' : ' - unclaimed'}`
            : 'lost'
        }</span>`;
      host.appendChild(row);
    }
    host.hidden = false;
    button.textContent = 'Hide the book';
  } catch (e) {
    console.error(e);
    toast(`Could not read the book: ${cleanError(e)}`, 'error');
    button.textContent = label;
  } finally {
    button.disabled = false;
  }
}

/** Ticks the countdowns. Pure text, no network, no rebuild. */
function tickCountdowns() {
  for (const m of markets) {
    const refs = cardIndex.get(String(m.id));
    if (!refs || refs.statusKey !== 'open') continue;
    const state = statusOf(m);
    if (state.label !== refs.badge.textContent) refs.badge.textContent = state.label;
    // Crossing into the consensus buffer takes the bet buttons away, but the
    // card keeps its shape, so this is a live toggle rather than a rebuild.
    // The explanation has to move with the disabling: a button that greys out
    // with no reason given is the version of this that annoys people.
    for (const b of refs.betButtons) {
      if (b.disabled !== !!state.tooLate) {
        b.disabled = !!state.tooLate;
        b.title = state.tooLate ? TOO_LATE_HINT : '';
      }
    }
    refs.badge.classList.toggle('late', !!state.tooLate);
    // A market that just crossed its close time needs the Resolve button, which
    // is a change of structure rather than of text - let the poll rebuild it.
    if (state.key !== 'open') refs.statusKey = 'stale';
  }
}

/**
 * Pulls fresh market state off-chain and folds it in.
 *
 * Pools change whenever anyone else bets, so a page left open should not sit
 * there showing yesterday's odds. Rebuilding is reserved for the cases that
 * actually change the shape of a card - a new market, or one that moved between
 * open, closed and resolved - because a rebuild costs the user their caret.
 */
async function pollChain() {
  if (busy || document.hidden) return;
  let fresh;
  try {
    const raw = await read('get_all_markets');
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    fresh = sortForDisplay(Object.values(parsed || {}));
  } catch {
    return; // transient RPC trouble: keep showing the last good figures
  }

  const structureChanged =
    fresh.length !== markets.length
    || fresh.some((m) => {
      const refs = cardIndex.get(String(m.id));
      return !refs || refs.statusKey !== statusOf(m).key;
    });

  markets = fresh;
  if (structureChanged) {
    renderMarkets();
    await refreshClaimable();
    return;
  }

  for (const m of markets) {
    const refs = cardIndex.get(String(m.id));
    if (!refs) continue;
    const yes = BigInt(m.yes_pool || 0);
    const no = BigInt(m.no_pool || 0);
    setText(refs.yesAmount, `${gen(yes)} GEN`);
    setText(refs.noAmount, `${gen(no)} GEN`);
    setText(refs.yesMult, formatMult(impliedMultiplier(m, 'YES')));
    setText(refs.noMult, formatMult(impliedMultiplier(m, 'NO')));
    const pct = impliedPct(m);
    setText(refs.yesPct, hasMoney(m) ? `${pct}%` : '--');
    setText(refs.noPct, hasMoney(m) ? `${100 - pct}%` : '--');
    if (refs.barYes) refs.barYes.style.width = `${pct}%`;
    if (refs.barNo) refs.barNo.style.width = `${100 - pct}%`;
  }
}

function setText(el, value) {
  if (el && el.textContent !== value) el.textContent = value;
}

function hasMoney(market) {
  return BigInt(market.yes_pool || 0) + BigInt(market.no_pool || 0) > 0n;
}

/** The market's own answer, before the validators give theirs.
 *
 *  In a parimutuel pool the share of money on a side is the crowd's implied
 *  probability of it, which is the single most useful number here and the one
 *  the page was not showing at all. An empty market is drawn at 50/50 - not a
 *  claim, just the honest absence of an opinion. */
function impliedPct(market) {
  const yes = BigInt(market.yes_pool || 0);
  const no = BigInt(market.no_pool || 0);
  const total = yes + no;
  if (total === 0n) return 50;
  return Number((yes * 100n) / total);
}

function formatMult(m) {
  if (!m) return '-';
  // Short, because it sits beside the percentage in a narrow cell. Still the
  // honest number: an unopposed market refunds, so it is 1.00x, never the
  // sub-1x figure a lone pool would imply.
  if (m.refund) return 'refund at 1.00x';
  return m.value.toFixed(2) + 'x';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- actions ---------------------------------------------------------

async function placeBet(market, side, stakeGen) {
  if (!requireSignIn('place a bet')) return;
  const stake = toWei(stakeGen);
  if (stake < BigInt(market.min_bet)) {
    toast(`Minimum bet is ${gen(BigInt(market.min_bet))} GEN`, 'error');
    return;
  }
  const deposited = BigInt(await read('get_balance', [signer.address]));
  if (deposited < stake) {
    toast(`You have ${gen(deposited)} GEN deposited - deposit more first`, 'error');
    return;
  }
  await withBusy(`Betting ${side}`, async () => {
    await write('bet', [Number(market.id), side, stake]);
    toast(`Bet ${side} placed`, 'success');
    await loadMarkets();
    await refreshWallet();
  });
}

async function resolveMarket(market) {
  if (!requireSignIn('resolve a market')) return;
  await withBusy('Resolving - validators are fetching your sources and running the prompt', async () => {
    await write('resolve_market', [Number(market.id)]);
    await loadMarkets();
    const fresh = markets.find((m) => m.id === market.id);
    toast(voidReason(fresh) || `Resolved ${fresh?.outcome}`, fresh?.settlement === 'VOID' ? 'info' : 'success');
    await refreshWallet();
  });
}

async function refreshClaimable() {
  if (!isSignedIn()) { $('claimable-panel').hidden = true; return; }
  try {
    const raw = await read('get_claimable', [signer.address]);
    const items = JSON.parse(typeof raw === 'string' ? raw : '[]');
    const panel = $('claimable-panel');
    const list = $('claimable-list');
    if (!items.length) { panel.hidden = true; return; }
    panel.hidden = false;
    list.innerHTML = '';
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'claim-row';
      const refund = item.settlement === 'VOID';
      row.innerHTML = `
        <span>${escapeHtml(item.question)}</span>
        <strong>${gen(BigInt(item.payout))} GEN ${refund ? '(refund)' : ''}</strong>
      `;
      const b = document.createElement('button');
      b.textContent = 'Collect';
      b.onclick = () => withBusy('Collecting', async () => {
        await write('claim', [Number(item.market_id)]);
        toast('Collected', 'success');
        await refreshWallet();
        await refreshClaimable();
      });
      row.appendChild(b);
      list.appendChild(row);
    }
  } catch (e) {
    console.error(e);
  }
}

async function createMarket(event) {
  event.preventDefault();
  if (!requireSignIn('create a market')) return;
  const question = $('f-question').value.trim();
  const criteria = $('f-criteria').value.trim();
  const sources = $('f-sources').value.trim();
  const minutes = Number($('f-window').value);
  const minBet = toWei($('f-minbet').value || '0.01');
  const feeBps = Math.round(Number($('f-fee').value || 3) * 100);
  const closeTs = Math.floor(Date.now() / 1000) + minutes * 60;

  await withBusy('Creating market', async () => {
    await write('create_market', [question, criteria, closeTs, sources, minBet, feeBps]);
    toast('Market created', 'success');
    $('create-form').reset();
    $('create-panel').hidden = true;
    await loadMarkets();
  });
}

async function fundSelf() {
  if (!requireSignIn('get test GEN')) return;
  await withBusy('Requesting test GEN', async () => {
    // StudioNet's faucet RPC. Verified working against chain 61999; this is why
    // a visitor needs no wallet extension and no real funds to try the demo.
    await rpc('sim_fundAccount', [signer.address, Number(10n * ONE_GEN)]);
    await new Promise((r) => setTimeout(r, 2000));
    await refreshWallet();
    toast('Funded with 10 test GEN', 'success');
  });
}

async function deposit() {
  if (!requireSignIn('deposit')) return;
  const amount = prompt('How much GEN to deposit into the contract?', '1');
  if (!amount) return;
  await withBusy('Depositing', async () => {
    await write('deposit', [], toWei(amount));
    toast('Deposited', 'success');
    await refreshWallet();
  });
}

async function withdrawAll() {
  if (!requireSignIn('withdraw')) return;
  await withBusy('Withdrawing', async () => {
    await write('withdraw_all', []);
    toast('Withdrawn to your wallet', 'success');
    await refreshWallet();
  });
}

// --- source warning --------------------------------------------------

function checkSources() {
  const value = $('f-sources').value;
  const el = $('source-warning');

  // A URL with a comma in it gets split by the separator, and the contract then
  // rejects the fragment as an invalid source - confusing unless it is named.
  const parts = value.split(',').map((u) => u.trim()).filter(Boolean);
  const broken = parts.find((u) => !/^https?:\/\//.test(u));
  if (broken) {
    el.textContent = `"${broken.slice(0, 40)}" is not a URL. Sources are separated by commas, so a URL containing a comma has to be written with %2C instead.`;
    el.hidden = false;
    return;
  }

  const blocked = BLOCKED_SOURCE_HOSTS.find((h) => value.includes(h));
  if (blocked) {
    el.textContent = `${blocked} blocks GenLayer's validators by region - it answers them with an error page, so this market would resolve UNKNOWN and refund. Try CoinGecko, Coinbase or Kraken.`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// --- boot ------------------------------------------------------------

async function main() {
  $('mark-slot').innerHTML = markSvg(32);
  $('favicon').href = faviconHref();

  readClient = createClient({ chain: studionet, endpoint: RPC });

  // A returning visitor is put back where they left off, but only where that
  // needs no permission: the wallet is reconnected silently or not at all, so
  // opening the page never raises a prompt.
  if (localStorage.getItem(MODE_STORAGE) === 'wallet') {
    // MetaMask can inject after this script runs, so give it a moment.
    for (let i = 0; i < 20 && !getProvider(); i++) await new Promise((r) => setTimeout(r, 100));
    if (getProvider()) await connectWallet({ silent: true });
  }
  applyAuthUI();

  $('btn-open-login').onclick = showLogin;
  $('btn-login-wallet').onclick = async () => {
    if (await connectWallet()) { applyAuthUI(); await refreshWallet(); }
  };
  $('btn-switch-chain').onclick = async () => {
    const ok = await ensureStudioChain();
    signer.chainId = await readChainId();
    renderNetwork();
    toast(ok ? 'Now on StudioNet' : 'Could not switch - approve the request in your wallet', ok ? 'success' : 'error');
    if (ok) await refreshWallet();
  };
  $('btn-signout').onclick = signOut;

  $('contract-address').textContent = contractAddress;
  $('explorer-link').href = `${EXPLORER}/address/${contractAddress}`;

  buildTemplateChips();
  $('create-form').addEventListener('submit', createMarket);
  $('f-sources').addEventListener('input', checkSources);
  $('btn-fund').onclick = fundSelf;
  $('btn-deposit').onclick = deposit;
  $('btn-withdraw').onclick = withdrawAll;
  $('btn-open-create').onclick = () => {
    $('create-panel').hidden = false;
    $('create-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('btn-close-create').onclick = () => { $('create-panel').hidden = true; };
  $('btn-check-sources').onclick = () => previewSources();
  $('btn-toggle-guide').onclick = () => {
    const steps = $('guide-steps');
    const hiding = !steps.hidden;
    steps.hidden = hiding;
    $('btn-toggle-guide').textContent = hiding ? 'Show' : 'Hide';
    try { localStorage.setItem(GUIDE_STORAGE, hiding ? 'hidden' : 'shown'); } catch { /* private mode */ }
  };
  if (localStorage.getItem(GUIDE_STORAGE) === 'hidden') {
    $('guide-steps').hidden = true;
    $('btn-toggle-guide').textContent = 'Show';
  }
  $('btn-refresh').onclick = () => loadMarkets().catch((e) => toast(cleanError(e), 'error'));

  await refreshWallet();
  try {
    await loadMarkets();
  } catch (e) {
    toast(`Could not load markets: ${cleanError(e)}`, 'error');
  }

  setInterval(tickCountdowns, 1000);
  setInterval(pollChain, 20000);
}

function buildTemplateChips() {
  const host = $('template-chips');
  let currentGroup = null;
  let row = null;

  for (const t of TEMPLATES) {
    if (t.group !== currentGroup) {
      currentGroup = t.group;
      const wrap = document.createElement('div');
      wrap.className = 'template-group';
      wrap.innerHTML = `<span class="group-name">${escapeHtml(t.group)}</span>`;
      row = document.createElement('div');
      row.className = 'group-chips';
      wrap.appendChild(row);
      host.appendChild(wrap);
    }

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = t.label;
    b.onclick = () => fillFromTemplate(t, b);
    row.appendChild(b);
  }
}

async function fillFromTemplate(t, button) {
  const original = button.textContent;
  button.textContent = 'Reading source...';
  button.disabled = true;
  try {
    const built = await t.build();
    if (!built) { toast('That source is not answering right now - try another example', 'error'); return; }
    $('f-question').value = built.question;
    $('f-criteria').value = built.criteria;
    $('f-sources').value = t.sources;
    $('f-window').value = String(t.minutes);
    checkSources();
    $('template-note').textContent = built.note;
    // Show what the sources say straight away: a market you can check before you
    // post it is a market other people can check before they bet on it.
    await previewSources();
    $('f-question').focus();
  } catch (e) {
    console.error(e);
    toast(`Could not read the source: ${cleanError(e)}`, 'error');
  } finally {
    button.textContent = original;
    button.disabled = false;
  }
}

/** Fetches whatever is in the sources box and shows it, so a question can be
 *  sanity-checked against real data before anyone stakes on it - and so a dead
 *  or geo-blocked URL is caught here rather than as an UNKNOWN at settlement. */
async function previewSources() {
  const urls = ($('f-sources').value || '')
    .split(',').map((u) => u.trim()).filter(Boolean).slice(0, 3);
  const host = $('source-preview');
  if (!urls.length) { host.hidden = true; host.innerHTML = ''; return; }

  host.hidden = false;
  host.innerHTML = '<div class="source-row"><span class="status">...</span><div class="body">Reading sources</div></div>';

  const rows = await Promise.all(urls.map(async (url) => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      const text = (await res.text()).slice(0, 400);
      return { url, ok: res.ok, status: res.ok ? 'ok' : `HTTP ${res.status}`, text };
    } catch (e) {
      // A browser CORS refusal says nothing about whether a validator can read
      // it - they fetch server-side - so this is reported as unknown, not bad.
      return { url, ok: null, status: 'no preview', text: 'The browser could not fetch this (often CORS). Validators fetch it themselves, so this may still work - probe_sources.py is the way to be sure.' };
    }
  }));

  host.innerHTML = '';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = `source-row ${r.ok === true ? 'ok' : r.ok === false ? 'bad' : ''}`;
    row.innerHTML = `
      <span class="status">${escapeHtml(r.status)}</span>
      <div class="body">
        <span class="url">${escapeHtml(r.url)}</span>
        <pre>${escapeHtml(r.text)}</pre>
      </div>`;
    host.appendChild(row);
  }
}

main();
