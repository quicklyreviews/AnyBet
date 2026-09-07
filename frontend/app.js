/**
 * AnyBet - browser client.
 *
 * No build step: the import map in app.html pulls genlayer-js from esm.sh.
 *
 * The wallet, the network check, the request queue and the small formatting
 * helpers live in wallet.js, shared rather than owned here. They used to be copied
 * here, and the copy drifted: the rate-limit backoff added after StudioNet
 * started refusing bursts went into one file and not the other, so this page
 * kept hammering a node that had stopped answering and reported it as CORS.
 *
 * Signing is the user's own wallet and nothing else. An earlier version also
 * offered a throwaway key kept in localStorage, which made trying the app
 * easier but handed people an account they were never told they had: open the
 * site in a second browser and money left in the first one is unreachable. A
 * market whose accounts evaporate with the browser cache is not one anybody
 * should put money into, so that option is gone.
 */
import {
  $, signer, isSignedIn, initWallet, connectWallet, signOut, ensureStudioChain,
  readChainId, chainLabel, makeContract, toast, withBusy, cleanError,
  gen, toWei, shorten, escapeHtml, setText, rpc, isBusy, isRateLimited,
  EXPLORER, ONE_GEN,
} from './wallet.js';
import { TEMPLATES } from './templates.js';
import { markSvg, faviconHref } from './brand.js';

const CONTRACT = '0x99F7ECE24CdfFb9Eb5C7493Cb6bAC42DAc3B3774';
const BLOCKED_SOURCE_HOSTS = ['binance.com'];

const contractAddress = CONTRACT;
const contract = makeContract(CONTRACT);
const read = (fn, args = [], tries = 2) => contract.read(fn, args, tries);
const write = (fn, args = [], value = 0n) => contract.write(fn, args, value);

let markets = [];
let walletGen = 0n;
let deposited = 0n;
let claimableCount = 0;

// --- the network bar -------------------------------------------------

function renderNetbar() {
  const connected = isSignedIn();
  const chain = chainLabel();
  const wrong = connected && !chain.ok;

  $('netbar').className = `netbar${wrong ? ' wrong' : ''}`;
  $('net-dot').className = `dot${wrong ? ' bad' : ''}`;
  setText($('net-name'), wrong ? chain.name : 'GenLayer StudioNet');
  $('net-id').hidden = wrong;
  $('btn-switch-chain').hidden = !wrong;

  $('net-account').hidden = !connected;
  $('btn-connect').hidden = connected;
  setText($('wallet-address'), shorten(signer.address));
  $('wallet-address').title = signer.address || '';
}

// --- how to take part ------------------------------------------------

/** Step two is deposited GEN, not wallet GEN: gas alone cannot be staked, and
 *  a page that ticked the box on gas would be pointing at the wrong balance. */
function renderSteps() {
  const states = [
    ['step-connect', isSignedIn()],
    ['step-gen', deposited > 0n],
    ['step-act', markets.some((m) => m.status === 'OPEN') && deposited > 0n],
  ];
  let pending = true;
  let done = 0;
  for (const [id, isDone] of states) {
    const li = $(id);
    li.classList.toggle('done', isDone);
    li.classList.toggle('now', !isDone && pending);
    if (isDone) done++;
    else pending = false;
  }
  // Kept on the page when complete: it is the only place that explains what a
  // parimutuel pool is or why a bet takes a minute.
  setText($('start-progress'), done === 3 ? 'all set' : `step ${done + 1} of 3`);
  $('start').classList.toggle('complete', done === 3);
}

// --- tabs ------------------------------------------------------------

function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  }
  for (const p of document.querySelectorAll('.tabpanel')) {
    p.classList.toggle('active', p.id === `panel-${name}`);
  }
}

// --- auth ------------------------------------------------------------

function requireSignIn(action = 'do that') {
  if (isSignedIn()) return true;
  toast(`Connect a wallet to ${action}`, 'info');
  $('start').scrollIntoView({ behavior: 'smooth', block: 'center' });
  return false;
}

/** Redrawn on every auth change. The create form stays reachable signed out so
 *  the shape of the thing is visible before anyone commits; the submit is what
 *  asks for a wallet. */
function applyAuthUI() {
  renderNetbar();
  $('account-actions').style.display = isSignedIn() ? '' : 'none';
  setText($('signer-note'), isSignedIn()
    ? 'Every action asks your wallet to sign. Consensus takes about a minute, so approve promptly - a market can close while the prompt is open.'
    : '');
  setText($('create-hint'), isSignedIn() ? '' : 'Connect a wallet to open a market.');
  renderSteps();
  renderMarkets();
}

async function refreshWallet() {
  applyAuthUI();
  if (!signer.address) {
    walletGen = 0n; deposited = 0n;
    setText($('wallet-gas'), '-');
    setText($('wallet-balance'), '-');
    renderSteps();
    return;
  }
  // Logged rather than swallowed: a silent catch here is how a balance that
  // failed to read once looks identical to a balance that is genuinely zero.
  try {
    walletGen = BigInt(await rpc('eth_getBalance', [signer.address, 'latest']));
    setText($('wallet-gas'), gen(walletGen));
  } catch (e) { console.debug('wallet balance', e); }
  try {
    deposited = BigInt(await read('get_balance', [signer.address]));
    setText($('wallet-balance'), gen(deposited));
  } catch (e) { console.debug('get_balance', e); }
  renderSteps();
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
  // The tab counts what is still bettable, not the whole history - a "42" that
  // is mostly settled markets tells you nothing about whether to look.
  const open = markets.filter((m) => statusOf(m).key === 'open').length;
  setText($('tab-markets-count'), open ? String(open) : '');
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
  if (isBusy() || document.hidden || isRateLimited()) return;
  // The read path backs off on its own; this just avoids queueing behind it.
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
  if (!isSignedIn()) {
    $('claimable-panel').hidden = true;
    $('claimable-list').innerHTML = '';
    claimableCount = 0;
    setText($('tab-claim-count'), '');
    return;
  }
  try {
    const raw = await read('get_claimable', [signer.address]);
    const items = JSON.parse(typeof raw === 'string' ? raw : '[]');
    const panel = $('claimable-panel');
    const list = $('claimable-list');
    claimableCount = items.length;
    setText($('tab-claim-count'), items.length ? String(items.length) : '');
    list.innerHTML = '';
    if (!items.length) { panel.hidden = true; return; }
    panel.hidden = false;
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
    showTab('markets');
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

// --- boot ------------------------------------------------------------

let reloading = null;

/** Coalesced. Boot both initialises the wallet and loads; connecting fires an
 *  auth change *and* returns to whoever clicked. Left alone that is two full
 *  passes back to back, which is what trips the node's rate limit - and a
 *  rate-limited read fails quietly, so the page just looks wrong. */
function reloadAll({ force = false } = {}) {
  if (reloading && !force) return reloading;
  const previous = reloading;
  const run = (async () => {
    if (previous) await previous.catch(() => {});
    await loadMarkets();
    await refreshWallet();
  })();
  reloading = run;
  run.catch(() => {}).then(() => { if (reloading === run) reloading = null; });
  return run;
}

async function main() {
  $('mark-slot').innerHTML = markSvg(30);
  $('favicon').href = faviconHref();
  setText($('contract-address'), shorten(contractAddress));
  $('net-contract').href = `${EXPLORER}/address/${contractAddress}`;
  $('net-contract').title = contractAddress;
  $('explorer-link').href = `${EXPLORER}/address/${contractAddress}`;

  // Connecting changes what is claimable and what can be staked, so an auth
  // change re-reads rather than merely re-rendering.
  await initWallet({
    onAuthChange: () => {
      applyAuthUI();
      reloadAll().catch((e) => console.error('reload', e));
    },
  });

  // connectWallet fires the auth change, which reloads; reloading here as well
  // is how the burst that trips the rate limit gets built.
  const connect = () => connectWallet();
  $('btn-connect').onclick = connect;
  $('step-connect-btn').onclick = connect;
  $('btn-signout').onclick = signOut;
  $('btn-switch-chain').onclick = async () => {
    const ok = await ensureStudioChain();
    signer.chainId = await readChainId();
    renderNetbar();
    toast(ok ? 'Now on StudioNet' : 'Could not switch - approve it in your wallet', ok ? 'success' : 'error');
    if (ok) await reloadAll({ force: true });
  };

  $('btn-fund').onclick = fundSelf;
  $('btn-deposit').onclick = deposit;
  $('btn-withdraw').onclick = withdrawAll;
  $('step-gen-btn').onclick = fundSelf;
  $('step-deposit-btn').onclick = deposit;
  $('step-bet-btn').onclick = () => { showTab('markets'); $('panel-markets').scrollIntoView({ behavior: 'smooth' }); };
  $('step-create-btn').onclick = () => { showTab('create'); $('panel-create').scrollIntoView({ behavior: 'smooth' }); };

  $('create-form').addEventListener('submit', createMarket);
  $('f-sources').addEventListener('input', checkSources);
  $('btn-check-sources').onclick = () => previewSources();
  $('btn-refresh').onclick = () => reloadAll({ force: true }).catch((e) => toast(cleanError(e), 'error'));

  for (const t of document.querySelectorAll('.tab')) {
    t.onclick = () => showTab(t.dataset.tab);
  }

  buildTemplateChips();
  applyAuthUI();
  try {
    await reloadAll();
  } catch (e) {
    toast(`Could not load markets: ${cleanError(e)}`, 'error');
  }

  setInterval(tickCountdowns, 1000);
  // Once a minute, not every twenty seconds: the node rate-limits, and a page
  // left open was spending that budget on numbers nobody was reading.
  setInterval(pollChain, 60000);
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
main();
