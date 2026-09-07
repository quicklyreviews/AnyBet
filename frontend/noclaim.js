/**
 * NoClaim - the cover desk.
 *
 * Two people use this page and they want opposite things: a buyer wants the
 * trigger not to fire, an underwriter wants exactly that too but is paid for
 * the risk it might. So the page shows both sides of the same pool rather than
 * hiding the underwriting behind the product, and the number it leads with is
 * `free` - how much cover the contract can still honestly sell.
 */
import {
  $, signer, isSignedIn, initWallet, connectWallet, signOut, ensureStudioChain,
  readChainId, chainLabel, makeContract, toast, withBusy, cleanError,
  gen, toWei, shorten, escapeHtml, setText, rpc, isBusy, isRateLimited, EXPLORER, ONE_GEN,
} from './wallet.js';
import { markSvg, faviconHref } from './brand.js';
import { COVER_TEMPLATES } from './cover-templates.js';

// Deployed and verified by tests/integration/test_noclaim_studionet.py: cover
// refused when unbacked, a policy settled from real price evidence, and an
// unknowable trigger refunded in full.
const CONTRACT = '0xBF326FA29B839cF95d3c9d0895b7A852031C3822';
const GUIDE_STORAGE = 'noclaim_guide';
const BLOCKED_SOURCE_HOSTS = ['binance.com'];

const contract = makeContract(CONTRACT);

let pool = null;
let policies = [];
let mine = [];

// --- account ---------------------------------------------------------

function renderAccount() {
  const inFlag = isSignedIn();
  $('login-panel').hidden = inFlag;
  $('wallet').hidden = !inFlag;
  $('btn-open-login').hidden = inFlag;
  if (!inFlag) { $('buy-panel').hidden = true; $('mine-section').hidden = true; }
  $('uw-actions').style.display = inFlag ? '' : 'none';

  const chain = chainLabel();
  setText($('network-name'), chain.name);
  $('network-name').className = chain.ok ? 'net-ok' : 'net-bad';
  $('btn-switch-chain').hidden = chain.ok;
  $('chain-dot').className = `dot ${chain.ok || !inFlag ? 'ok' : 'bad'}`;
  setText($('chain-label'), chain.ok || !inFlag ? 'StudioNet 61999' : 'wrong network');

  setText($('wallet-address'), shorten(signer.address));
  $('wallet-address').title = signer.address || '';
  setText($('signer-note'),
    'Every action asks your wallet to sign. Consensus takes about a minute, so approve promptly.');

  renderPolicies();
}

async function refreshAccount() {
  renderAccount();
  if (!signer.address) return;
  try {
    setText($('wallet-gas'), gen(BigInt(await rpc('eth_getBalance', [signer.address, 'latest']))));
  } catch { /* keep the last figure */ }
  try {
    const owed = BigInt(await contract.read('get_balance', [signer.address]));
    setText($('wallet-balance'), gen(owed));
    $('collect-panel').hidden = owed === 0n;
    setText($('collect-line'),
      owed > 0n ? `${gen(owed)} GEN is yours to take - a paid claim, a refunded premium, or both.` : '');
  } catch { /* contract may be unreachable for a moment */ }
  try {
    setText($('uw-stake'), gen(BigInt(await contract.read('get_underwriter', [signer.address]))));
  } catch { /* as above */ }
}

/** Skips the whole cycle while the node is refusing us, so a rate limit does
 *  not become a queue of requests that arrive after it lifts. */
function shouldPoll() {
  return !isBusy() && !document.hidden && !isRateLimited();
}

// --- the pool --------------------------------------------------------

async function loadPool() {
  pool = await contract.read('get_pool');
  setText($('stat-total'), `${gen(BigInt(pool.total), 2)} GEN`);
  setText($('stat-reserved'), `${gen(BigInt(pool.reserved), 2)} GEN`);
  setText($('stat-free'), `${gen(BigInt(pool.free), 2)} GEN`);
  setText($('stat-paid'), `${gen(BigInt(pool.payouts_made), 2)} GEN`);
  setText($('uw-earned'), gen(BigInt(pool.premiums_earned)));
  setText($('uw-free'), gen(BigInt(pool.free)));
  setText($('uw-count'), String(pool.underwriters ?? '-'));
  renderQuote();
}

// --- policies --------------------------------------------------------

/** Live cover first, then anything waiting on a verdict, then history. */
function sortForDisplay(list) {
  const rank = (p) => {
    if (p.status !== 'ACTIVE') return 2;
    return Number(p.expires_ts) > Math.floor(Date.now() / 1000) ? 0 : 1;
  };
  return list.sort((a, b) => rank(a) - rank(b) || Number(b.id) - Number(a.id));
}

function policyState(p) {
  const now = Math.floor(Date.now() / 1000);
  if (p.status === 'ACTIVE') {
    const left = Number(p.expires_ts) - now;
    if (left > 0) return { key: 'live', label: `cover ends in ${countdown(left)}` };
    return { key: 'due', label: 'expired - awaiting adjudication' };
  }
  if (p.settlement === 'PAID') return { key: 'paid', label: 'fired - paid out' };
  if (p.settlement === 'REFUNDED') return { key: 'refunded', label: 'unknowable - premium refunded' };
  return { key: 'expired', label: 'did not fire - premium earned' };
}

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

async function loadPolicies() {
  const raw = await contract.read('get_all_policies');
  policies = sortForDisplay(Object.values(typeof raw === 'string' ? JSON.parse(raw) : (raw || {})));

  // Derived from the list already in hand rather than asked separately.
  // get_policies_of is the more principled source - it is the contract's own
  // answer to "which are mine" - but it costs an extra request every cycle for
  // a value the reply above already contains, and the node's rate limit is the
  // binding constraint here. `holder` is the same field the view filters on.
  const me = signer.address ? signer.address.toLowerCase() : null;
  mine = me ? policies.filter((p) => p.holder === me) : [];
  renderPolicies();
}

/** One policy, rendered the same whether it is yours or somebody else's - the
 *  only difference is which list it lands in. */
function policyCard(p) {
  const state = policyState(p);
  const payout = BigInt(p.payout || 0);
  const premium = BigInt(p.premium || 0);
  const isMine = signer.address && p.holder === signer.address.toLowerCase();

  const card = document.createElement('article');
  card.className = `policy ${state.key}`;
  card.innerHTML = `
    <div class="policy-head">
      <h3>${escapeHtml(p.trigger)}</h3>
      <span class="badge ${state.key}">${escapeHtml(state.label)}</span>
    </div>
    <p class="criteria">${escapeHtml(p.criteria)}</p>
    <div class="terms">
      <div class="term">
        <span class="term-label">Sum insured</span>
        <span class="term-value">${gen(payout)} <span class="unit">GEN</span></span>
      </div>
      <div class="term">
        <span class="term-label">Premium paid</span>
        <span class="term-value">${gen(premium)} <span class="unit">GEN</span></span>
      </div>
      <div class="term">
        <span class="term-label">Held by</span>
        <span class="term-value mono">${escapeHtml(shorten(p.holder))}${isMine ? ' <span class="you">you</span>' : ''}</span>
      </div>
    </div>
    ${p.reasoning ? `
      <div class="verdict ${state.key}">
        <span class="label">GenLayer validators adjudicated</span>
        <p>${escapeHtml(p.reasoning)}</p>
      </div>` : ''}
    <div class="policy-actions"></div>
  `;

  if (state.key === 'due') {
    const b = document.createElement('button');
    b.textContent = 'Settle now';
    b.title = 'Anyone can trigger settlement - there is no adjuster to appoint';
    b.onclick = () => settle(p);
    card.querySelector('.policy-actions').appendChild(b);
  }
  return card;
}

/** What you personally are covered for, and what your cover has done so far. */
function renderMine() {
  const section = $('mine-section');
  if (!isSignedIn() || !mine.length) {
    section.hidden = true;
    $('btn-open-buy-alt').hidden = !isSignedIn();
    return;
  }
  section.hidden = false;
  $('btn-open-buy-alt').hidden = true;

  const now = Math.floor(Date.now() / 1000);
  let active = 0n, premiums = 0n, paid = 0n, refunded = 0n;
  for (const p of mine) {
    premiums += BigInt(p.premium || 0);
    if (p.status === 'ACTIVE' && Number(p.expires_ts) > now) active += BigInt(p.payout || 0);
    if (p.settlement === 'PAID') paid += BigInt(p.payout || 0);
    if (p.settlement === 'REFUNDED') refunded += BigInt(p.premium || 0);
  }
  setText($('mine-active'), gen(active, 2));
  setText($('mine-premiums'), gen(premiums, 3));
  setText($('mine-paid'), gen(paid, 2));
  setText($('mine-refunded'), gen(refunded, 3));

  const host = $('mine-policies');
  host.innerHTML = '';
  for (const p of sortForDisplay([...mine])) host.appendChild(policyCard(p));
}

function renderPolicies() {
  renderMine();
  const host = $('policies');
  if (!host) return;
  if (!policies.length) {
    host.innerHTML = '<p class="empty">No cover written yet. Be the first to buy some.</p>';
    return;
  }

  host.innerHTML = '';
  for (const p of policies) host.appendChild(policyCard(p));
}

// --- quoting ---------------------------------------------------------

/** What the cover costs and whether the pool can back it, shown while the
 *  numbers are still being typed rather than after a refusal. */
function renderQuote() {
  const host = $('quote');
  if (!host || !pool) return;

  const payout = toWei($('f-payout').value || '0');
  const premium = toWei($('f-premium').value || '0');
  const free = BigInt(pool.free);
  const rate = BigInt(pool.min_rate_bps);
  const minPremium = (payout * rate) / 10000n;

  const backed = payout > 0n && payout <= free;
  const priced = premium >= minPremium && premium > 0n;

  host.innerHTML = `
    <div class="quote-row ${backed ? 'ok' : 'bad'}">
      <span class="q-label">Pool can back it</span>
      <span class="q-value">${backed
        ? `yes - ${gen(free, 2)} GEN free`
        : `no - only ${gen(free, 2)} GEN is unreserved`}</span>
    </div>
    <div class="quote-row ${priced ? 'ok' : 'bad'}">
      <span class="q-label">Minimum premium</span>
      <span class="q-value">${gen(minPremium)} GEN
        <span class="q-note">(${Number(rate) / 100}% of the sum insured)</span></span>
    </div>
    <div class="quote-row">
      <span class="q-label">If it fires you receive</span>
      <span class="q-value">${gen(payout)} GEN</span>
    </div>
    <div class="quote-row">
      <span class="q-label">If it cannot be judged</span>
      <span class="q-value">${gen(premium)} GEN back - the pool earns nothing</span>
    </div>
  `;
  $('btn-buy').disabled = !(backed && priced);
}

// --- actions ---------------------------------------------------------

function requireSignIn(what = 'do that') {
  if (isSignedIn()) return true;
  toast(`Connect a wallet to ${what}`, 'info');
  $('login-panel').hidden = false;
  $('login-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  return false;
}

async function buyCover(event) {
  event.preventDefault();
  if (!requireSignIn('buy cover')) return;

  const payout = toWei($('f-payout').value);
  const premium = toWei($('f-premium').value);
  const expires = Math.floor(Date.now() / 1000) + Number($('f-window').value) * 60;

  await withBusy('Writing the policy', async () => {
    await contract.write('buy_policy', [
      $('f-trigger').value.trim(),
      $('f-criteria').value.trim(),
      $('f-sources').value.trim(),
      payout,
      expires,
    ], premium);
    toast('Cover is live', 'success');
    $('buy-form').reset();
    $('buy-panel').hidden = true;
    await reloadAll();
  });
}

async function settle(policy) {
  if (!requireSignIn('settle a policy')) return;
  await withBusy('Adjudicating - validators are fetching the evidence', async () => {
    await contract.write('settle_policy', [Number(policy.id)]);
    await reloadAll();
    const fresh = policies.find((p) => p.id === policy.id);
    const said = {
      PAID: 'Trigger fired - the sum insured is yours to collect',
      REFUNDED: 'Could not be judged - your premium has been refunded',
      EXPIRED: 'Trigger did not fire - the pool keeps the premium',
    }[fresh?.settlement] || 'Settled';
    toast(said, fresh?.settlement === 'EXPIRED' ? 'info' : 'success');
  });
}

async function collect() {
  if (!requireSignIn('collect')) return;
  await withBusy('Collecting', async () => {
    await contract.write('withdraw_all', []);
    toast('Paid out to your wallet', 'success');
    await refreshAccount();
  });
}

async function fundPool() {
  if (!requireSignIn('underwrite')) return;
  const amount = prompt('How much GEN to put behind this pool?', '10');
  if (!amount) return;
  await withBusy('Adding capital', async () => {
    await contract.write('fund_pool', [], toWei(amount));
    toast('Capital added - you are now underwriting', 'success');
    await reloadAll();
  });
}

async function withdrawPool() {
  if (!requireSignIn('withdraw')) return;
  const free = pool ? gen(BigInt(pool.free)) : '0';
  const amount = prompt(`How much to withdraw? Only unreserved capital can leave; ${free} GEN is free.`, free);
  if (!amount) return;
  await withBusy('Withdrawing', async () => {
    await contract.write('withdraw_pool', [toWei(amount)]);
    toast('Withdrawn', 'success');
    await reloadAll();
  });
}

async function getTestGen() {
  if (!requireSignIn('get test GEN')) return;
  await withBusy('Requesting test GEN', async () => {
    await rpc('sim_fundAccount', [signer.address, Number(20n * ONE_GEN)]);
    await new Promise((r) => setTimeout(r, 2000));
    await refreshAccount();
    toast('Funded with 20 test GEN', 'success');
  });
}

// --- sources ---------------------------------------------------------

function checkSources() {
  const value = $('f-sources').value;
  const el = $('source-warning');
  const parts = value.split(',').map((u) => u.trim()).filter(Boolean);
  const broken = parts.find((u) => !/^https?:\/\//.test(u));
  if (broken) {
    el.textContent = `"${broken.slice(0, 40)}" is not a URL. Sources are comma separated, so a URL containing a comma must use %2C instead.`;
    el.hidden = false;
    return;
  }
  const blocked = BLOCKED_SOURCE_HOSTS.find((h) => value.includes(h));
  if (blocked) {
    el.textContent = `${blocked} blocks GenLayer's validators by region and answers them with an error page, so a policy sourced from it can only ever settle UNKNOWN.`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

/** Fetches whatever is in the sources box so a trigger can be sanity-checked
 *  against real evidence before any money is committed to it. */
async function previewSources() {
  const urls = ($('f-sources').value || '').split(',').map((u) => u.trim()).filter(Boolean).slice(0, 3);
  const host = $('source-preview');
  if (!urls.length) { host.hidden = true; host.innerHTML = ''; return; }

  host.hidden = false;
  host.innerHTML = '<div class="source-row"><span class="status">...</span><div class="body">Reading sources</div></div>';

  const rows = await Promise.all(urls.map(async (url) => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      return { url, ok: res.ok, status: res.ok ? 'ok' : `HTTP ${res.status}`, text: (await res.text()).slice(0, 400) };
    } catch {
      // A browser CORS refusal says nothing about whether a validator can read
      // it - they fetch server-side - so this is unknown, not bad.
      return { url, ok: null, status: 'no preview', text: 'The browser could not fetch this, often CORS. Validators fetch it themselves, so it may still work.' };
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

function buildTemplates() {
  const host = $('template-chips');
  for (const t of COVER_TEMPLATES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = t.label;
    b.onclick = async () => {
      const original = b.textContent;
      b.textContent = 'Reading source...';
      b.disabled = true;
      try {
        const built = await t.build();
        if (!built) { toast('That source is not answering right now', 'error'); return; }
        $('f-trigger').value = built.trigger;
        $('f-criteria').value = built.criteria;
        $('f-sources').value = t.sources;
        $('f-window').value = String(t.minutes);
        if (built.payout) $('f-payout').value = built.payout;
        if (built.premium) $('f-premium').value = built.premium;
        setText($('template-note'), built.note);
        checkSources();
        renderQuote();
        await previewSources();
        $('f-trigger').focus();
      } catch (e) {
        console.error(e);
        toast(`Could not read the source: ${cleanError(e)}`, 'error');
      } finally {
        b.textContent = original;
        b.disabled = false;
      }
    };
    host.appendChild(b);
  }
}

// --- boot ------------------------------------------------------------

async function reloadAll() {
  await Promise.all([
    loadPool().catch((e) => console.error('pool', e)),
    loadPolicies().catch((e) => console.error('policies', e)),
  ]);
  await refreshAccount();
}

async function main() {
  $('mark-slot').innerHTML = markSvg(32);
  $('favicon').href = faviconHref();
  $('contract-address').textContent = CONTRACT;
  $('explorer-link').href = `${EXPLORER}/address/${CONTRACT}`;

  // Connecting changes the answer to "which of these are mine", and that
  // answer comes from the contract rather than from a filter here - so an auth
  // change has to re-read the policies, not merely re-render them.
  await initWallet({
    onAuthChange: () => {
      renderAccount();
      loadPolicies().catch((e) => console.error('policies', e));
    },
  });

  $('btn-open-login').onclick = () => requireSignIn('use this');
  $('btn-login-wallet').onclick = async () => { if (await connectWallet()) await reloadAll(); };
  $('btn-signout').onclick = signOut;
  $('btn-switch-chain').onclick = async () => {
    const ok = await ensureStudioChain();
    signer.chainId = await readChainId();
    renderAccount();
    toast(ok ? 'Now on StudioNet' : 'Could not switch - approve it in your wallet', ok ? 'success' : 'error');
  };

  $('btn-fund').onclick = getTestGen;
  $('btn-collect').onclick = collect;
  $('btn-collect-all').onclick = collect;
  $('btn-fund-pool').onclick = fundPool;
  $('btn-withdraw-pool').onclick = withdrawPool;

  const openBuy = () => {
    $('buy-panel').hidden = false;
    $('buy-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('btn-open-buy').onclick = openBuy;
  $('btn-open-buy-alt').onclick = openBuy;
  $('buy-form').addEventListener('submit', buyCover);
  $('btn-check-sources').onclick = () => previewSources();
  $('f-sources').addEventListener('input', checkSources);
  for (const id of ['f-payout', 'f-premium']) {
    $(id).addEventListener('input', renderQuote);
  }
  $('btn-refresh').onclick = () => reloadAll().catch((e) => toast(cleanError(e), 'error'));

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

  buildTemplates();
  await reloadAll();

  // Countdowns are local; the chain is re-read only occasionally.
  // Countdowns are local and free. The chain is asked once a minute, and not
  // at all while the tab is hidden or the node is refusing.
  setInterval(() => { if (!isBusy()) renderPolicies(); }, 1000);
  setInterval(() => { if (shouldPoll()) reloadAll().catch(() => {}); }, 60000);
}

main();
