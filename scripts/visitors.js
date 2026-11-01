#!/usr/bin/env node
/*
 * visitors.js — one line per (anonymous) visitor, most recent first: country, companies viewed,
 * stories generated and read, companies followed, calendar subscription, the Claude cost of the
 * stories they generated, and when they were last here. From data/events.jsonl and data/usage.jsonl.
 *
 *   node scripts/visitors.js [count]      default 20; on the server: docker exec fsv node scripts/visitors.js
 * Times are GMT+8 (REPORT_TZ to change, e.g. REPORT_TZ=Europe/London).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { calKey } = require('../lib/log');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const limit = +process.argv[2] || 20;
const read = name => {
  try { return fs.readFileSync(path.join(DATA_DIR, name), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
};
const events = read('events.jsonl');
const usage = read('usage.jsonl');
const regions = new Intl.DisplayNames(['en'], { type: 'region' });
const app = ua => (/dataaccessd|iOS/i.test(ua) ? 'iPhone/iPad' : /Google/i.test(ua) ? 'Google Calendar' : /Macintosh|Mac OS X|CalendarAgent|macOS/i.test(ua) ? 'Mac Calendar' : /Outlook|Microsoft/i.test(ua) ? 'Outlook' : ua.split(/[ /]/)[0] || 'unknown');
const storyKey = e => `${e.ticker} ${e.label} ${e.lang}`; // matches the `about` of a story's usage entry

// calendar fetches by calendar (hashed id)
const fetches = {};
for (const e of events.filter(e => e.type === 'calendar_fetch')) (fetches[e.cal] = fetches[e.cal] || []).push(e);

// who asked first for each story pays for it
const firstAsker = {};
for (const e of events.filter(e => e.type === 'story_generate')) if (!firstAsker[storyKey(e)]) firstAsker[storyKey(e)] = e.v;
const costBy = {};
for (const u of usage.filter(u => u.feature === 'story')) {
  const v = firstAsker[u.about];
  if (v) costBy[v] = (costBy[v] || 0) + (u.cost || 0);
}

const visitors = {};
for (const e of events) {
  if (!e.v) continue;
  const x = (visitors[e.v] = visitors[e.v] || { first: e.t, last: e.t, country: '', companies: new Set(), made: new Set(), reads: 0, follows: {}, cals: new Set() });
  x.last = e.t > x.last ? e.t : x.last;
  if (e.country) x.country = e.country;
  if (e.type === 'view') x.companies.add(e.ticker);
  if (e.type === 'story_generate') x.made.add(storyKey(e));
  if (e.type === 'story_open') x.reads++;
  if (e.type === 'follow') { x.follows[e.ticker] = e.on; x.cals.add(e.cal); }
}

const list = Object.entries(visitors).sort((a, b) => (a[1].last < b[1].last ? 1 : -1));
const TZ = process.env.REPORT_TZ || 'Asia/Singapore';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });
const when = t => fmt.format(new Date(t)).replace(',', ''); // "2026-10-31 16:56 GMT+8"
console.log(`${list.length} visitors since ${events[0] ? events[0].t.slice(0, 10) : '—'} (anonymous browser ids)${list.length > limit ? `, latest ${limit} shown` : ''}\n`);
for (const [v, x] of list.slice(0, limit)) {
  const following = Object.keys(x.follows).filter(t => x.follows[t]);
  const subs = [...x.cals].flatMap(c => fetches[c] || []);
  const lastFetch = subs.sort((a, b) => (a.t < b.t ? 1 : -1))[0];
  console.log(`${v.slice(0, 8)}  ${x.country ? regions.of(x.country) : 'country unknown'} · last visit ${when(x.last)} (first ${when(x.first)})`);
  console.log(`  companies viewed: ${x.companies.size}${x.companies.size ? ' (' + [...x.companies].slice(0, 10).join(', ') + (x.companies.size > 10 ? ', …' : '') + ')' : ''}`);
  console.log(`  magazines generated: ${x.made.size}${x.made.size ? ' (' + [...x.made].join('; ') + ')' : ''} · read: ${x.reads}`);
  console.log(`  following: ${following.length}${following.length ? ' (' + following.join(', ') + ')' : ''} · calendar subscribed: ${lastFetch ? `yes, ${app(lastFetch.app)}, last refreshed ${when(lastFetch.t)}` : 'no'}`);
  console.log(`  Claude cost of their stories: $${(costBy[v] || 0).toFixed(2)}\n`);
}

// calendars followed before visitors were linked to them (or from a browser whose id was cleared)
let calendars = {};
try { calendars = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'follows.json'), 'utf8')); } catch { /* none */ }
const linked = new Set(Object.values(visitors).flatMap(x => [...x.cals]));
const unlinked = Object.entries(calendars).filter(([id]) => !linked.has(calKey(id)));
if (unlinked.length) {
  console.log(`Calendars not linked to a visitor above: ${unlinked.length}`);
  for (const [id, tickers] of unlinked) {
    const f = (fetches[calKey(id)] || []).sort((a, b) => (a.t < b.t ? 1 : -1))[0];
    console.log(`  following ${tickers.join(', ')} · subscribed: ${f ? `yes, ${app(f.app)}, last refreshed ${when(f.t)}` : 'no fetch logged yet'}`);
  }
}
const total = usage.reduce((a, u) => a + (u.cost || 0), 0);
if (usage.length) console.log(`\nAll Claude calls since ${usage[0].t.slice(0, 10)}: $${total.toFixed(2)} (stories are attributed above; earnings-date checks are shared by everyone who follows a company)`);
