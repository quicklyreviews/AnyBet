/**
 * Build a NoClaim-only tree for the submission repository.
 *
 * The two contracts share wallet.js, styles.css and brand.js, so a repository
 * holding only NoClaim cannot be a hand-picked copy: the moment one is edited
 * the other is wrong, which is exactly the drift that let app.js keep its own
 * stale copy of the wallet for weeks.
 *
 * So the split is mechanical instead. Files come from this repository as they
 * are, and the handful of places that mention the sibling project are wrapped
 * in `anybet:start` / `anybet:end` markers and cut out here. Anything the
 * export needs to say differently - the README, the Render service name -
 * lives in packaging/noclaim/ and is copied over the top.
 *
 *   node scripts/export-noclaim.mjs [outDir]
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not url.pathname: this project lives in a directory with a
// space in its name, and the raw pathname hands back a %20 that no filesystem
// call will resolve.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] || join(ROOT, '..', 'noclaim-export'));

// Carried over verbatim, minus any marked blocks.
const KEEP = [
  'contracts/no_claim.py',
  'frontend/index.html',
  'frontend/noclaim.html',
  'frontend/noclaim.js',
  'frontend/home.js',
  'frontend/cover-templates.js',
  'frontend/wallet.js',
  'frontend/brand.js',
  'frontend/styles.css',
  'tests/direct/conftest.py',
  'tests/direct/test_no_claim.py',
  'tests/integration/test_noclaim_studionet.py',
  'tests/integration/probe_sources.py',
  'pytest.ini',
  '.gitignore',
  '.github/workflows/pages.yml',
];

// Copied over the top of anything above, or added.
const OVERLAY = 'packaging/noclaim';

/** Cut every marked block, in whichever comment syntax the file uses. */
function strip(text) {
  const before = text.length;
  const out = text
    .replace(/[ \t]*<!--\s*anybet:start\s*-->[\s\S]*?<!--\s*anybet:end\s*-->[ \t]*\n?/g, '')
    .replace(/[ \t]*\/\/\s*anybet:start[\s\S]*?\/\/\s*anybet:end[ \t]*\n?/g, '')
    .replace(/[ \t]*#\s*anybet:start[\s\S]*?#\s*anybet:end[ \t]*\n?/g, '');
  return { out, cut: before - out.length };
}

function copy(rel, from = ROOT) {
  const src = join(from, rel);
  if (!existsSync(src)) throw new Error(`missing: ${rel}`);
  const { out, cut } = strip(readFileSync(src, 'utf8'));
  const dst = join(OUT, rel);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, out);
  return cut;
}

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), base)
      : [join(dir, e.name).slice(base.length + 1).replace(/\\/g, '/')]);
}

// --- run ---

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let cutTotal = 0;
for (const rel of KEEP) {
  const cut = copy(rel);
  cutTotal += cut;
  console.log(`  ${rel}${cut ? `  (-${cut} bytes)` : ''}`);
}

const overlayDir = join(ROOT, OVERLAY);
console.log('\noverlay:');
for (const rel of walk(overlayDir)) {
  copy(rel, overlayDir);
  console.log(`  ${rel}`);
}

// Nothing may reference the sibling project by name once the markers are cut.
// A stray link is the one thing a reviewer would notice immediately.
const leaks = [];
for (const rel of walk(OUT)) {
  const text = readFileSync(join(OUT, rel), 'utf8');
  for (const bad of [/anybet\.html/i, /\bapp\.html/i, /any_bet/i, /anybet-home/i]) {
    if (bad.test(text)) leaks.push(`${rel}: ${bad}`);
  }
}

console.log(`\n${KEEP.length} files, ${cutTotal} bytes of sibling-project markup removed`);
if (leaks.length) {
  console.error('\nLEAKED REFERENCES:');
  for (const l of leaks) console.error('  ' + l);
  process.exit(1);
}
console.log('no leaked references');
console.log(`\n-> ${OUT}`);
