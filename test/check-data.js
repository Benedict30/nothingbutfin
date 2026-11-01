// Runs the accounting identities on every company in the EDGAR cache (real data).
// Strict identity failures exit 1; known gaps are reported for information.
// Run: npm run check:data   (fetch companies first by opening them in the app)
const fs = require('fs');
const path = require('path');
const { normalize } = require('../lib/edgar');
const { checkBlock } = require('./identities');

const dir = path.join(path.resolve(process.env.CACHE_DIR || path.join(__dirname, '..', 'cache')), 'companyfacts');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
if (!files.length) { console.log('No cached companies in', dir); process.exit(0); }

let strictFailures = 0;
for (const f of files) {
  const facts = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const out = normalize(facts);
  console.log(`\n${facts.entityName} (${f.replace('.json', '')})`);
  for (const [freq, block] of [['annual', out.annual], ['quarterly', out.quarterly]]) {
    for (const r of checkBlock(block)) {
      if (!r.checked) continue;
      const ok = r.checked - r.failed.length;
      const mark = !r.failed.length ? 'ok  ' : r.kind === 'strict' ? 'FAIL' : 'gap ';
      if (r.kind === 'strict') strictFailures += r.failed.length;
      const detail = r.failed.length ? `  ${r.kind === 'gap' ? '(' + r.note + ') ' : ''}${r.failed.slice(0, 4).join(', ')}${r.failed.length > 4 ? ', …' : ''}` : '';
      console.log(`  ${mark} ${freq.padEnd(9)} ${r.name}: ${ok}/${r.checked}${detail}`);
    }
  }
}
console.log(strictFailures ? `\n${strictFailures} strict identity failure(s)` : '\nAll strict identities hold.');
process.exit(strictFailures ? 1 : 0);
