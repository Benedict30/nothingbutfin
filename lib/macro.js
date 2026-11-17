/*
 * macro.js — the market backdrop: the S&P 500, the Fed's policy rate (top of its target range), the 10-year
 * Treasury yield, core PCE inflation (the Fed's measure, as a year-on-year %) and WTI crude oil, monthly for
 * the last 10 years, plus the latest values. (FRED carries only the last 10 years of the S&P 500.)
 * From FRED (Federal Reserve Bank of St. Louis), whose CSV downloads need no key. Kept 12 hours.
 * Also the dates of what's scheduled: the Fed's last and next rate decisions (its published meeting
 * calendar) and the next PCE inflation report (BEA's release schedule).
 * And the S&P 500's earnings yield (what it earns as a share of its price), with earnings from shiller.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { trailingEarnings } = require('./shiller');

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

/** Monthly averages of a daily series, by 'YYYY-MM'; a first month the data starts partway through is left out. */
function monthlyAverage(daily) {
  const sums = new Map();
  for (const [d, v] of daily) {
    const s = sums.get(d.slice(0, 7)) || sums.set(d.slice(0, 7), { sum: 0, n: 0 }).get(d.slice(0, 7));
    s.sum += v; s.n++;
  }
  if (daily.length && +daily[0][0].slice(8) > 7) sums.delete(daily[0][0].slice(0, 7));
  return new Map([...sums].map(([m, { sum, n }]) => [m, round(sum / n)]));
}

/**
 * The page's figures from the FRED downloads ([[date, value]] lists), apart from the fetching so it can be tested:
 * { months: ['2016-11', …], sp500, fed, yield10, inflation, oil: [value | null per month], latest: {…} }.
 * The S&P 500, the 10-year yield and oil are monthly averages (FRED's own monthly figure where it has one, else
 * the average of that month's days), and each of those lines ends at its latest day's value, in that day's month.
 * So the month under way is on the chart, and the end of a line is the same figure as `latest`.
 * With `earnings` ([['2026-06', 295.39], …], the S&P 500's earnings per share over the last four quarters) there is
 * also earningsYield: those earnings as a % of the month's S&P 500, which is its P/E upside down.
 */
function assemble({ gs10, pce, oilM, dgs10, oilD, fedD, spD, earnings }, now) {
  const byMonth = list => new Map(list.map(([d, v]) => [d.slice(0, 7), v])); // later days overwrite earlier ones
  const lastP = pce.at(-1), lastY = dgs10.at(-1), lastO = oilD.at(-1), lastF = fedD.at(-1), lastS = spD.at(-1);
  const endAtLatest = (monthly, last) => { // not when the daily series has fallen behind the monthly one
    if (last && ![...monthly.keys()].some(m => m > last[0].slice(0, 7))) monthly.set(last[0].slice(0, 7), last[1]);
    return monthly;
  };
  const y = endAtLatest(new Map([...monthlyAverage(dgs10), ...byMonth(gs10)]), lastY);
  const o = endAtLatest(new Map([...monthlyAverage(oilD), ...byMonth(oilM)]), lastO);
  const s = endAtLatest(monthlyAverage(spD), lastS);
  const p = byMonth(pce), f = byMonth(fedD);
  const yoy = m => {
    const prev = `${+m.slice(0, 4) - 1}${m.slice(4)}`;
    return p.has(m) && p.has(prev) ? round((p.get(m) / p.get(prev) - 1) * 100) : null;
  };
  const start = `${now.getUTCFullYear() - 10}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const months = [...new Set([...y.keys(), ...o.keys(), ...p.keys(), ...s.keys()])].filter(m => m >= start).sort();
  // Earnings trail the index by a few months, so later months use the latest earnings: for up to a year, after
  // which the source has stopped and the line stops with it.
  const e = new Map(earnings || []), lastE = earnings?.at(-1);
  const monthsApart = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5) - +a.slice(5));
  const eps = m => e.get(m) ?? (lastE && m > lastE[0] && monthsApart(lastE[0], m) <= 12 ? lastE[1] : null);
  const epsNow = lastS && eps(lastS[0].slice(0, 7));
  return {
    months,
    sp500: months.map(m => s.get(m) ?? null),
    ...(lastE && { earningsYield: months.map(m => (s.get(m) && eps(m) ? round(eps(m) / s.get(m) * 100) : null)) }),
    fed: months.map(m => f.get(m) ?? null),
    yield10: months.map(m => y.get(m) ?? null),
    inflation: months.map(yoy),
    oil: months.map(m => o.get(m) ?? null),
    latest: {
      sp500: lastS && { value: lastS[1], date: lastS[0] },
      fed: lastF && { value: lastF[1], date: lastF[0] },
      yield10: lastY && { value: lastY[1], date: lastY[0] },
      inflation: lastP && { value: yoy(lastP[0].slice(0, 7)), date: lastP[0] },
      oil: lastO && { value: lastO[1], date: lastO[0] },
      // pe: the price/earnings ratio; earningsTo: the month those four quarters of earnings end
      ...(epsNow && { earningsYield: { value: round(epsNow / lastS[1] * 100), date: lastS[0], pe: round(lastS[1] / epsNow, 1), earningsTo: lastE[0] } }),
    },
  };
}

/** assemble()'s figures, plus { schedule: {…}, source, earningsSource (when there are earnings), fetchedAt } */
async function build(cacheDir) {
  const now = new Date();
  const from = `${now.getUTCFullYear() - 11}-01-01`; // a year more than shown, for inflation's year-on-year
  const [gs10, pce, oilM, dgs10, oilD, fedD, spD, earnings] = await Promise.all([
    series('GS10', from), series('PCEPILFE', from), series('MCOILWTICO', from), series('DGS10', from.slice(0, 4) + '-12-01'), series('DCOILWTICO', from.slice(0, 4) + '-12-01'),
    series('DFEDTARU', from), // daily; a month's figure is its last day's (the rate only moves at Fed meetings)
    series('SP500', from), // daily closes
    trailingEarnings(cacheDir), // null when Shiller's spreadsheet has never been read: the page then has no earnings yield
  ]);
  return {
    ...assemble({ gs10, pce, oilM, dgs10, oilD, fedD, spD, earnings }, now),
    schedule: await schedule(),
    source: 'Federal Reserve Bank of St. Louis (FRED)',
    ...(earnings && { earningsSource: 'Robert Shiller (shillerdata.com)' }),
    fetchedAt: new Date().toISOString(),
  };
}

let inflight = null;
/** The backdrop, from the cache when it's under 12 hours old (an older copy if FRED can't be reached). */
async function marketBackdrop(cacheDir) {
  const file = path.join(cacheDir, 'macro-v6.json'); // v6: with the earnings yield
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < TTL) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* not cached yet */ }
  if (!inflight) inflight = build(cacheDir).then(d => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(d));
    return d;
  }).catch(e => {
    console.error(new Date().toISOString(), 'macro', e.message);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw e; }
  }).finally(() => { inflight = null; });
  return inflight;
}

module.exports = { marketBackdrop, assemble };
