#!/usr/bin/env node
/*
 * visitors.js — visitors grouped by country (visitors, page views, top companies, story reads, follows),
 * then one entry per visitor who did something (read or generated a story, followed a company): country,
 * companies viewed, stories, follows, calendar subscription, the Claude cost of their stories, last visit.
 * Leaves out automated traffic and the owner's own browsers (scripts/report-filter.js).
 *
 *   node scripts/visitors.js [count] [--all]   count of active visitors shown (default 20); --all also
 *                                              counts events from before tracking was cleaned up
 *   on the server: docker exec fsv node scripts/visitors.js
 * Times are GMT+8 (REPORT_TZ to change, e.g. REPORT_TZ=Europe/London).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { calKey } = require('../lib/log');
const { reportFilter, ownCalendars } = require('./report-filter');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const limit = +process.argv.find(a => /^\d+$/.test(a)) || 20;
const all = process.argv.includes('--all');
const read = name => {
  try { return fs.readFileSync(path.join(DATA_DIR, name), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
};
const allEvents = read('events.jsonl');
const filter = reportFilter(DATA_DIR);
const counted = all ? e => !e.bot && !filter.mine.has(e.v) : filter.counted;
const events = allEvents.filter(e => e.type === 'calendar_fetch' || counted(e));
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
  if (!e.v || e.type === 'calendar_fetch') continue;
  const x = (visitors[e.v] = visitors[e.v] || { first: e.t, last: e.t, country: '', companies: new Set(), views: 0, made: new Set(), reads: 0, follows: {}, cals: new Set() });
  x.last = e.t > x.last ? e.t : x.last;
  if (e.country) x.country = e.country;
  if (e.type === 'view') { x.companies.add(e.ticker); x.views++; }
  if (e.type === 'story_generate') x.made.add(storyKey(e));
  if (e.type === 'story_open') x.reads++;
  if (e.type === 'follow') { x.follows[e.ticker] = e.on; x.cals.add(e.cal); }
}

const list = Object.entries(visitors).sort((a, b) => (a[1].last < b[1].last ? 1 : -1));
const TZ = process.env.REPORT_TZ || 'Asia/Singapore';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });
const when = t => fmt.format(new Date(t)).replace(',', ''); // "2026-10-31 16:56 GMT+8"
const following = x => Object.keys(x.follows).filter(t => x.follows[t]);
const start = all ? (allEvents[0] ? allEvents[0].t : '') : filter.since;
const skipped = allEvents.filter(e => e.type !== 'calendar_fetch' && (e.bot || filter.mine.has(e.v)) && (all || e.t >= filter.since));
console.log(`${list.length} visitors since ${start ? when(start) : 'the start'} · left out: ${new Set(skipped.filter(e => e.bot).map(e => e.v)).size} automated, ${new Set(skipped.filter(e => !e.bot).map(e => e.v)).size} of your own browsers\n`);

// by country
const pad = (x, n) => String(x).padEnd(n);
const byCountry = {};
for (const [, x] of list) {
  const c = (byCountry[x.country || '??'] = byCountry[x.country || '??'] || { visitors: 0, views: 0, companies: {}, reads: 0, follows: 0, last: '' });
  c.visitors++; c.reads += x.reads; c.views += x.views; if (following(x).length) c.follows++;
  for (const t of x.companies) c.companies[t] = (c.companies[t] || 0) + 1;
  if (x.last > c.last) c.last = x.last;
}
console.log(pad('Country', 18) + pad('Visitors', 10) + pad('Views', 8) + pad('Reads', 8) + pad('Following', 11) + pad('Last visit', 24) + 'Top companies (visitors)');
for (const [k, c] of Object.entries(byCountry).sort((a, b) => b[1].visitors - a[1].visitors)) {
  const top = Object.entries(c.companies).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} ${n}`).join(', ');
  console.log(pad(k === '??' ? 'Unknown' : regions.of(k), 18) + pad(c.visitors, 10) + pad(c.views, 8) + pad(c.reads, 8) + pad(c.follows, 11) + pad(when(c.last), 24) + top);
}

// visitors who did more than look
const active = list.filter(([, x]) => x.reads || x.made.size || following(x).length);
console.log(`\nActive visitors (read or generated a story, or follow a company): ${active.length}${active.length > limit ? `, latest ${limit} shown` : ''}\n`);
for (const [v, x] of active.slice(0, limit)) {
  const subs = [...x.cals].flatMap(c => fetches[c] || []);
  const lastFetch = subs.sort((a, b) => (a.t < b.t ? 1 : -1))[0];
  console.log(`${v.slice(0, 8)}  ${x.country ? regions.of(x.country) : 'country unknown'} · last visit ${when(x.last)} (first ${when(x.first)})`);
  console.log(`  companies viewed: ${x.companies.size}${x.companies.size ? ' (' + [...x.companies].slice(0, 10).join(', ') + (x.companies.size > 10 ? ', …' : '') + ')' : ''}`);
  console.log(`  magazines generated: ${x.made.size}${x.made.size ? ' (' + [...x.made].join('; ') + ')' : ''} · read: ${x.reads}`);
  console.log(`  following: ${following(x).length}${following(x).length ? ' (' + following(x).join(', ') + ')' : ''} · calendar subscribed: ${lastFetch ? `yes, ${app(lastFetch.app)}, last refreshed ${when(lastFetch.t)}` : 'no'}`);
  console.log(`  Claude cost of their stories: $${(costBy[v] || 0).toFixed(2)}\n`);
}

// calendars followed before visitors were linked to them (or from a browser whose id was cleared)
let calendars = {};
try { calendars = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'follows.json'), 'utf8')); } catch { /* none */ }
const linked = new Set(Object.values(visitors).flatMap(x => [...x.cals]));
const own = ownCalendars(allEvents, filter.mine);
const unlinked = Object.entries(calendars).filter(([id]) => !linked.has(calKey(id)) && !own.has(calKey(id)));
if (unlinked.length) {
  console.log(`Calendars not linked to a visitor above: ${unlinked.length}`);
  for (const [id, tickers] of unlinked) {
    const f = (fetches[calKey(id)] || []).sort((a, b) => (a.t < b.t ? 1 : -1))[0];
    console.log(`  following ${tickers.join(', ')} · subscribed: ${f ? `yes, ${app(f.app)}, last refreshed ${when(f.t)}` : 'no fetch logged yet'}`);
  }
}
const total = usage.reduce((a, u) => a + (u.cost || 0), 0);
if (usage.length) console.log(`\nAll Claude calls since ${usage[0].t.slice(0, 10)}: $${total.toFixed(2)} (stories are attributed above; earnings-date checks are shared by everyone who follows a company)`);
