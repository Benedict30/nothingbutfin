#!/usr/bin/env node
/*
 * costs.js — what the Claude API has cost, per month and feature, from the usage each feature records:
 *   stories (cache/magazine), preliminary figures (cache/preliminary), earnings-date checks (data/confirmed.json; retired November 2026).
 * Estimates at list prices; the Anthropic Console has the exact bill.
 *
 *   node scripts/costs.js            (on the server: docker exec fsv node scripts/costs.js)
 *   CACHE_DIR / DATA_DIR as for server.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { costOf } = require('../lib/magazine');

const root = path.join(__dirname, '..');
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(root, 'cache'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));

const months = {}; // { 'YYYY-MM': { stories: { n, usd }, preliminary: { n, usd }, dates: usd } }
const month = m => (months[m] = months[m] || { stories: { n: 0, usd: 0 }, preliminary: { n: 0, usd: 0 }, dates: 0 });
const priciest = [];

function each(dir, fn) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    try { fn(f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* unreadable file: skip */ }
  }
}
each(path.join(CACHE_DIR, 'magazine'), (f, s) => {
  const usd = costOf(s.model, s.usage) || 0;
  const m = month((s.createdAt || '').slice(0, 7) || 'unknown').stories;
  m.n++; m.usd += usd;
  const lang = /-v2-([\w-]+)\.json$/.exec(f)?.[1]; // English stories have no language suffix
  priciest.push({ usd, what: f.replace(/-claude-.*$/, '') + (lang ? ` (${lang})` : ''), when: (s.createdAt || '').slice(0, 10) });
});
each(path.join(CACHE_DIR, 'preliminary'), (f, s) => {
  if (!s.usage) return;
  const m = month((s.createdAt || '').slice(0, 7) || 'unknown').preliminary;
  m.n++; m.usd += costOf(s.model, s.usage) || 0;
});
try {
  const c = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'confirmed.json'), 'utf8'));
  const spent = c.spent || (c.spend ? { [c.spend.month]: c.spend.usd } : {});
  for (const [m, usd] of Object.entries(spent)) month(m).dates += usd;
} catch { /* no checks yet */ }

const $ = n => '$' + n.toFixed(2);
const pad = (s, n) => String(s).padEnd(n);
console.log('Claude API spend, estimated from recorded usage at list prices (exact bill: Anthropic Console)\n');
console.log(pad('Month', 10) + pad('Stories', 16) + pad('Preliminary', 16) + pad('Earnings dates', 16) + 'Total');
let total = 0;
for (const m of Object.keys(months).sort()) {
  const x = months[m], sum = x.stories.usd + x.preliminary.usd + x.dates;
  total += sum;
  console.log(pad(m, 10) + pad(`${x.stories.n} · ${$(x.stories.usd)}`, 16) + pad(`${x.preliminary.n} · ${$(x.preliminary.usd)}`, 16) + pad($(x.dates), 16) + $(sum));
}
console.log(pad('All time', 58) + $(total));

// every call since the usage log began (data/usage.jsonl), failed ones included
let calls = [];
try { calls = fs.readFileSync(path.join(DATA_DIR, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { /* not started yet */ }
if (calls.length) {
  console.log(`\nEvery call since ${calls[0].t.slice(0, 10)} (data/usage.jsonl):`);
  console.log(pad('Month', 10) + pad('Feature', 16) + pad('Calls', 8) + pad('Failed', 8) + pad('Tokens in/out', 18) + 'Cost');
  const groups = {};
  for (const c of calls) {
    const g = (groups[c.t.slice(0, 7) + '|' + c.feature] = groups[c.t.slice(0, 7) + '|' + c.feature] || { n: 0, failed: 0, input: 0, output: 0, usd: 0 });
    g.n++; g.failed += c.outcome === 'refusal' || c.outcome === 'max_tokens' ? 1 : 0;
    g.input += c.input + c.cacheRead + c.cacheWrite; g.output += c.output; g.usd += c.cost || 0;
  }
  const k = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'K');
  for (const key of Object.keys(groups).sort()) {
    const [m, f] = key.split('|'), g = groups[key];
    console.log(pad(m, 10) + pad(f, 16) + pad(g.n, 8) + pad(g.failed, 8) + pad(`${k(g.input)} / ${k(g.output)}`, 18) + $(g.usd));
  }
}

if (priciest.length) {
  console.log('\nMost expensive stories:');
  for (const p of priciest.sort((a, b) => b.usd - a.usd).slice(0, 5)) console.log(`  ${$(p.usd)}  ${p.what}  ${p.when}`);
}
