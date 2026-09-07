/**
 * Build a single-project tree for a submission repository.
 *
 * The two contracts share wallet.js, styles.css and brand.js, so a repository
 * holding only one of them cannot be a hand-picked copy: the moment one is
 * edited the other is wrong, which is exactly the drift that let app.js keep
 * its own stale copy of the wallet for weeks.
 *
 * So the split is mechanical instead. Files come from this repository as they
 * are, and the handful of places that mention the sibling project are wrapped
 * in `<sibling>:start` / `<sibling>:end` markers and cut out here. Anything
 * the export needs to say differently - the README, the Render service name -
 * lives in packaging/<project>/ and is copied over the top.
 *
 *   node scripts/export.mjs noclaim [outDir]    # ../noclaim-export by default
 *   node scripts/export.mjs anybet  [outDir]    # ../anybet-export
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not url.pathname: this project lives in a directory with a
// space in its name, and the raw pathname hands back a %20 that no filesystem
// call will resolve.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PROFILES = {
  noclaim: {
    // The word whose marked blocks get cut.
    sibling: 'anybet',
    // Carried over verbatim, minus any marked blocks. A [from, to] pair renames.
    keep: [
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
      'tests/integration/demo_cover.py',
      'pytest.ini',
      '.gitignore',
      '.github/workflows/pages.yml',
    ],
    rewrite: [],
    overlay: 'packaging/noclaim',
    // Nothing may mention the sibling once the markers are cut - not in a
    // link, not in a filename, not in a comment.
    leaks: [/anybet/i, /any_bet/i, /\bapp\.html/i],
    defaultOut: 'noclaim-export',
  },
  anybet: {
    sibling: 'noclaim',
    keep: [
      'contracts/any_bet.py',
      // The AnyBet overview takes the front door once it is alone.
      ['frontend/anybet.html', 'frontend/index.html'],
      'frontend/anybet-home.js',
      'frontend/app.html',
      'frontend/app.js',
      'frontend/templates.js',
      'frontend/wallet.js',
      'frontend/brand.js',
      'frontend/styles.css',
      'HUONG-DAN.md',
      'SUBMISSION.md',
      'render.yaml',
      'tests/direct/conftest.py',
      'tests/direct/test_any_bet.py',
      'tests/integration/test_deploy_studionet.py',
      'tests/integration/test_resolution_consensus.py',
      'tests/integration/test_book_studionet.py',
      'tests/integration/probe_sources.py',
      'tests/integration/demo_run.py',
      'tests/integration/demo_claim.py',
      'tests/integration/resolve_closed.py',
      'pytest.ini',
      '.gitignore',
      '.github/workflows/pages.yml',
    ],
    // Links follow the rename above.
    rewrite: [[/\banybet\.html/g, 'index.html']],
    overlay: 'packaging/anybet',
    leaks: [/noclaim/i, /no_claim/i, /cover-templates/i, /\banybet\.html/i],
    defaultOut: 'anybet-export',
  },
};

const name = process.argv[2];
const profile = PROFILES[name];
if (!profile) {
  console.error(`usage: node scripts/export.mjs <${Object.keys(PROFILES).join('|')}> [outDir]`);
  process.exit(2);
}
const OUT = resolve(process.argv[3] || join(ROOT, '..', profile.defaultOut));

/** Cut every marked block, in whichever comment syntax the file uses. */
function strip(text) {
  const s = profile.sibling;
  const before = text.length;
  const out = text
    .replace(new RegExp(`[ \\t]*<!--\\s*${s}:start\\s*-->[\\s\\S]*?<!--\\s*${s}:end\\s*-->[ \\t]*\\r?\\n?`, 'g'), '')
    .replace(new RegExp(`[ \\t]*//\\s*${s}:start[\\s\\S]*?//\\s*${s}:end[ \\t]*\\r?\\n?`, 'g'), '')
    .replace(new RegExp(`[ \\t]*#\\s*${s}:start[\\s\\S]*?#\\s*${s}:end[ \\t]*\\r?\\n?`, 'g'), '');
  return { out, cut: before - out.length };
}

function rewrite(text) {
  for (const [from, to] of profile.rewrite) text = text.replace(from, to);
  return text;
}

function copy(rel, dstRel = rel, from = ROOT) {
  const src = join(from, rel);
  if (!existsSync(src)) throw new Error(`missing: ${rel}`);
  const { out, cut } = strip(readFileSync(src, 'utf8'));
  const dst = join(OUT, dstRel);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, rewrite(out));
  return cut;
}

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), base)
      : [join(dir, e.name).slice(base.length + 1).replace(/\\/g, '/')]);
}

// --- run ---

// Everything except .git: the export directory is a working clone of the
// submission repository, and blowing the whole thing away took its history
// with it the first time this ran twice.
if (existsSync(OUT)) {
  for (const entry of readdirSync(OUT)) {
    if (entry === '.git') continue;
    rmSync(join(OUT, entry), { recursive: true, force: true });
  }
} else {
  mkdirSync(OUT, { recursive: true });
}

let cutTotal = 0;
for (const entry of profile.keep) {
  const [rel, dstRel] = Array.isArray(entry) ? entry : [entry, entry];
  const cut = copy(rel, dstRel);
  cutTotal += cut;
  console.log(`  ${rel}${dstRel !== rel ? ` -> ${dstRel}` : ''}${cut ? `  (-${cut} bytes)` : ''}`);
}

const overlayDir = join(ROOT, profile.overlay);
console.log('\noverlay:');
for (const rel of walk(overlayDir)) {
  copy(rel, rel, overlayDir);
  console.log(`  ${rel}`);
}

// The first version of this check looked only for two filenames and passed a
// tree whose stylesheet opened with the other project's name on line one,
// which is exactly the kind of thing a reviewer notices first. So it looks for
// the bare word now.
const leaks = [];
for (const rel of walk(OUT)) {
  if (rel.startsWith('.git/')) continue;
  const text = readFileSync(join(OUT, rel), 'utf8');
  for (const bad of profile.leaks) {
    if (bad.test(text)) leaks.push(`${rel}: ${bad}`);
  }
}

console.log(`\n${profile.keep.length} files, ${cutTotal} bytes of sibling-project markup removed`);
if (leaks.length) {
  console.error('\nLEAKED REFERENCES:');
  for (const l of leaks) console.error('  ' + l);
  process.exit(1);
}
console.log('no leaked references');
console.log(`\n-> ${OUT}`);
