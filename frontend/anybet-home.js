/**
 * The home page.
 *
 * Read-only and wallet-free by design: nothing here needs an account, so
 * nothing here asks for one. A landing page that opens a wallet prompt before
 * saying what the product is has the order backwards.
 *
 * The figures and the market cards come off the chain on load rather than being
 * written into the HTML. A landing page quoting numbers that were true the day
 * someone wrote them is a brochure; this one is either current or honestly
 * blank.
 */
import { createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { markSvg, faviconHref } from './brand.js';

const RPC = 'https://studio.genlayer.com/api';
const EXPLORER = 'https://explorer-studio.genlayer.com';
const CONTRACT = '0x99F7ECE24CdfFb9Eb5C7493Cb6bAC42DAc3B3774';
// noclaim:start
const COVER_CONTRACT = '0xBF326FA29B839cF95d3c9d0895b7A852031C3822';
// noclaim:end
const ONE_GEN = 10n ** 18n;

const $ = (id) => document.getElementById(id);
const client = createClient({ chain: studionet, endpoint: RPC });

const shorten = (addr) => (addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '-');

function gen(wei, dp = 2) {
  return (Number(typeof wei === 'bigint' ? wei : BigInt(wei || 0)) / Number(ONE_GEN)).toFixed(dp);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Reads retry, because DNS to studio.genlayer.com is intermittently flaky and
 *  a dropped lookup would otherwise leave the page looking dead. */
async function read(functionName, args = [], tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await client.readContract({ address: CONTRACT, functionName, args });
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw last;
}

function countdown(seconds) {
  if (seconds <= 0) return 'closing';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m || 1}m`;
}

/** The crowd's implied probability: in a parimutuel pool the share of money on
 *  a side is what the market thinks of it. An empty market sits at 50, which is
 *  the absence of an opinion rather than a claim of one. */
function impliedPct(m) {
  const yes = BigInt(m.yes_pool || 0);
  const no = BigInt(m.no_pool || 0);
  const total = yes + no;
  if (total === 0n) return 50;
  return Number((yes * 100n) / total);
}

async function loadStats() {
  const st = await read('get_stats');
  $('stat-markets').textContent = String(st.total_markets ?? '-');
  $('stat-bets').textContent = String(st.total_bets_placed ?? '-');
  $('stat-volume').textContent = `${gen(BigInt(st.total_volume || 0))} GEN`;
}

async function loadMarkets() {
  const raw = await read('get_all_markets');
  const all = Object.values(typeof raw === 'string' ? JSON.parse(raw) : (raw || {}));
  const now = Math.floor(Date.now() / 1000);

  // Open markets are the point of the page. Only when there are none does it
  // fall back to recently settled ones - showing an empty shell when the
  // contract has plenty of history would undersell it.
  const open = all
    .filter((m) => m.status === 'OPEN' && Number(m.close_ts) > now)
    .sort((a, b) => Number(a.close_ts) - Number(b.close_ts));
  const settled = all
    .filter((m) => m.status === 'RESOLVED')
    .sort((a, b) => Number(b.id) - Number(a.id));

  // The heading has to describe what is actually below it. Falling back to
  // settled markets while still promising "open right now" would be the page
  // telling a small lie about itself, which is the one thing a product built
  // on refusing to guess cannot do.
  const live = open.length > 0;
  const showing = (live ? open : settled).slice(0, 3);
  $('markets-heading').textContent = live ? 'Open right now' : 'Recently settled';
  const host = $('home-markets');

  if (!showing.length) {
    host.innerHTML = '<p class="empty">No markets yet. Be the first to open one.</p>';
    return;
  }

  host.innerHTML = '';
  for (const m of showing) {
    const isOpen = m.status === 'OPEN' && Number(m.close_ts) > now;
    const pct = impliedPct(m);
    const total = BigInt(m.yes_pool || 0) + BigInt(m.no_pool || 0);

    const card = document.createElement('a');
    card.className = `home-market ${isOpen ? 'open' : 'resolved'}`;
    card.href = 'app.html';
    card.innerHTML = `
      <div class="hm-head">
        <h3>${escapeHtml(m.question)}</h3>
        <span class="badge ${isOpen ? 'open' : ''}">${
          isOpen ? `closes in ${countdown(Number(m.close_ts) - now)}`
               : (m.settlement === 'VOID' ? 'voided - refunded' : `settled ${escapeHtml(m.outcome)}`)
        }</span>
      </div>
      <div class="odds-bar">
        <div class="odds-yes" style="width:${pct}%"></div>
        <div class="odds-no" style="width:${100 - pct}%"></div>
      </div>
      <div class="hm-foot">
        <span class="hm-yes">YES ${total > 0n ? pct + '%' : '--'}</span>
        <span class="hm-no">NO ${total > 0n ? (100 - pct) + '%' : '--'}</span>
        <span class="hm-pool">${gen(total)} GEN in the pool</span>
      </div>
    `;
    host.appendChild(card);
  }
}

async function main() {
  $('mark-slot').innerHTML = markSvg(28);
  $('favicon').href = faviconHref();
  $('contract-address').textContent = shorten(CONTRACT);
  $('net-contract-bet').href = `${EXPLORER}/address/${CONTRACT}`;
  $('net-contract-bet').title = CONTRACT;
  // noclaim:start
  $('cover-address').textContent = shorten(COVER_CONTRACT);
  $('net-contract-cover').href = `${EXPLORER}/address/${COVER_CONTRACT}`;
  $('net-contract-cover').title = COVER_CONTRACT;
  // noclaim:end
  $('explorer-link').href = `${EXPLORER}/address/${CONTRACT}`;

  // Independently, so a stumble on one does not blank the other.
  loadStats().catch((e) => console.error('stats', e));
  loadMarkets().catch((e) => {
    console.error('markets', e);
    $('home-markets').innerHTML =
      '<p class="empty">Could not reach the contract just now. The app still works.</p>';
  });
}

main();
