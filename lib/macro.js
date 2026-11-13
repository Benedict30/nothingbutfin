/*
 * macro.js — the market backdrop: the Fed's policy rate (top of its target range), the 10-year Treasury
 * yield, core PCE inflation (the Fed's measure, as a year-on-year %) and WTI crude oil, monthly for the
 * last 10 years, plus the latest values.
 * From FRED (Federal Reserve Bank of St. Louis), whose CSV downloads need no key. Kept 12 hours.
 * Also the dates of what's scheduled: the Fed's last and next rate decisions (its published meeting
 * calendar) and the next PCE inflation report (BEA's release schedule).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TTL = 12 * 3600e3;
const FRED = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

/** [[date, value]] for a FRED series from `from` on (missing values, shown as ".", skipped). */
async function series(id, from) {
  const res = await fetch(`${FRED}?id=${id}&cosd=${from}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`FRED ${id}: HTTP ${res.status}`);
  return (await res.text()).trim().split('\n').slice(1)
    .map(l => l.split(','))
    .filter(([, v]) => v && v !== '.' && isFinite(+v))
    .map(([d, v]) => [d, +v]);
}

const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

async function page(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NothingButFin/1.0; +https://nothingbutfin.com)' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** The Fed's rate decisions: the last day of each FOMC meeting, from its calendar page ("October 27-28", "Apr/May 30-1"). */
async function fedDecisions() {
  const html = await page('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm');
  const out = [];
  for (const year of html.matchAll(/(\d{4}) FOMC Meetings/g)) {
    const seg = html.slice(year.index, html.indexOf('FOMC Meetings', year.index + 20) >>> 0);
    const months = [...seg.matchAll(/fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>/g)].map(m => m[1].trim());
    const days = [...seg.matchAll(/fomc-meeting__date[^>]*>([^<]+)</g)].map(m => m[1].trim());
    months.forEach((mo, i) => {
      const last = mo.split('/').pop().toLowerCase(), day = /(\d+)\D*$/.exec(days[i] || '');
      const m = MONTHS.findIndex(x => x.startsWith(last.slice(0, 3)));
      if (m >= 0 && day) out.push(iso(+year[1], m + 1, +day[1]));
    });
  }
  return [...new Set(out)].sort();
}

/** The next "Personal Income and Outlays" release (core PCE inflation), from BEA's schedule (dates there have no year). */
async function nextPce(today) {
  const html = await page('https://www.bea.gov/news/schedule');
  const y = +today.slice(0, 4);
  for (const row of html.split(/<tr/i)) {
    const d = /release-date">\s*([A-Za-z]+) (\d{1,2})\s*</.exec(row);
    if (!d || !/Personal Income and Outlays/.test(row)) continue;
    const m = MONTHS.indexOf(d[1].toLowerCase()) + 1;
    if (!m) continue;
    for (const yr of [y, y + 1]) if (iso(yr, m, +d[2]) >= today) return iso(yr, m, +d[2]);
  }
  return null;
}

/** { fedLast, fedNext, pceNext } as dates, each null when its page can't be read. */
async function schedule() {
  const today = new Date().toISOString().slice(0, 10);
  const [fed, pce] = await Promise.all([
    fedDecisions().catch(e => { console.error(new Date().toISOString(), 'macro fed calendar', e.message); return []; }),
    nextPce(today).catch(e => { console.error(new Date().toISOString(), 'macro bea schedule', e.message); return null; }),
  ]);
  return { fedLast: fed.filter(d => d < today).pop() || null, fedNext: fed.find(d => d >= today) || null, pceNext: pce };
}

/** { months: ['2016-11', …], fed, yield10, inflation, oil: [value | null per month], latest: {…}, schedule: {…}, source } */
async function build() {
  const now = new Date();
  const from = `${now.getUTCFullYear() - 11}-01-01`; // a year more than shown, for inflation's year-on-year
  const [gs10, pce, oilM, dgs10, oilD, fedD] = await Promise.all([
    series('GS10', from), series('PCEPILFE', from), series('MCOILWTICO', from), series('DGS10', from.slice(0, 4) + '-12-01'), series('DCOILWTICO', from.slice(0, 4) + '-12-01'),
    series('DFEDTARU', from), // daily; a month's figure is its last day's (the rate only moves at Fed meetings)
  ]);
  const dates = await schedule();
  const byMonth = list => new Map(list.map(([d, v]) => [d.slice(0, 7), v])); // later days overwrite earlier ones
  const y = byMonth(gs10), p = byMonth(pce), o = byMonth(oilM), f = byMonth(fedD);
  const yoy = m => {
    const prev = `${+m.slice(0, 4) - 1}${m.slice(4)}`;
    return p.has(m) && p.has(prev) ? round((p.get(m) / p.get(prev) - 1) * 100) : null;
  };
  const start = `${now.getUTCFullYear() - 10}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const months = [...new Set([...y.keys(), ...o.keys(), ...p.keys()])].filter(m => m >= start).sort();
  const lastP = pce.at(-1), lastY = dgs10.at(-1), lastO = oilD.at(-1), lastF = fedD.at(-1);
  return {
    months,
    fed: months.map(m => f.get(m) ?? null),
    yield10: months.map(m => y.get(m) ?? null),
    inflation: months.map(yoy),
    oil: months.map(m => o.get(m) ?? null),
    latest: {
      fed: lastF && { value: lastF[1], date: lastF[0] },
      yield10: lastY && { value: lastY[1], date: lastY[0] },
      inflation: lastP && { value: yoy(lastP[0].slice(0, 7)), date: lastP[0] },
      oil: lastO && { value: lastO[1], date: lastO[0] },
    },
    schedule: dates,
    source: 'Federal Reserve Bank of St. Louis (FRED)',
    fetchedAt: new Date().toISOString(),
  };
}

let inflight = null;
/** The backdrop, from the cache when it's under 12 hours old (an older copy if FRED can't be reached). */
async function marketBackdrop(cacheDir) {
  const file = path.join(cacheDir, 'macro-v3.json'); // v3: with the schedule
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < TTL) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* not cached yet */ }
  if (!inflight) inflight = build().then(d => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(d));
    return d;
  }).catch(e => {
    console.error(new Date().toISOString(), 'macro', e.message);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw e; }
  }).finally(() => { inflight = null; });
  return inflight;
}

module.exports = { marketBackdrop };
