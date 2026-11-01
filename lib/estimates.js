/*
 * estimates.js — analysts' consensus revenue estimate per quarter, from Eulerpool's earnings
 * calendar (free plan: public display allowed with the credit "Data by Eulerpool" and a link).
 * Set EULERPOOL_API_KEY; without it there are simply no estimates. One request per company,
 * kept for 12 hours and shared by everyone.
 *
 * Quarters are matched to ours by the report date (the quarter that ended up to 100 days before);
 * Eulerpool's quarter label ("Jul/2026", or just "Q2", or none) only breaks ties.
 *
 * The same feed gives the next earnings date. A date with a time of day (before the open / after the
 * close) is one the company has announced; without one it is Eulerpool's guess, and ours is kept.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TTL = 12 * 3600e3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Jul/2026" for a quarter ending 2026-07-26 */
const monthKey = iso => MONTHS[+iso.slice(5, 7) - 1] + '/' + iso.slice(0, 4);

const inflight = new Map();
/** [{ quarter: 'Jul/2026' | null, revenue, eps, date, time }] for a ticker (revenue in USD), or null without a key. */
async function quarterEstimates(cacheDir, ticker) {
  const key = (process.env.EULERPOOL_API_KEY || '').trim();
  const t = String(ticker || '').toUpperCase();
  if (!key || !/^[A-Z0-9.-]{1,10}$/.test(t)) return null;
  const file = path.join(cacheDir, 'estimates', t + '.json');
  try {
    const st = await fs.promises.stat(file);
    if (Date.now() - st.mtimeMs < TTL) return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch { /* not cached yet */ }
  if (inflight.has(t)) return inflight.get(t);
  const p = (async () => {
    const day = d => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
    const url = `https://api.eulerpool.com/api/1/analytics/earnings-calendar?ticker=${encodeURIComponent(t)}&start_date=${day(-3650)}&end_date=${day(200)}&limit=200&token=${encodeURIComponent(key)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const out = [];
      for (const r of await res.json()) {
        const revenue = r.revenue_estimate != null ? +r.revenue_estimate : null;
        if (!r.fiscal_quarter && !r.report_date) continue;
        out.push({ quarter: r.fiscal_quarter || null, revenue: revenue > 0 ? revenue : null, eps: r.eps_estimate != null ? +r.eps_estimate : null, date: r.report_date || null, time: r.time_of_day || null });
      }
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(out));
      return out;
    } catch (e) {
      console.error(new Date().toISOString(), 'estimates', t, e.message);
      try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; } // an older copy, if any
    }
  })();
  inflight.set(t, p);
  try { return await p; } finally { inflight.delete(t); }
}

/**
 * Revenue estimates for the statement's quarters, in its money unit (millions):
 * { periodKey: millions }, plus `next` for the quarter after the latest one (matched by its end month).
 */
function forPeriods(est, periods) {
  if (!est) return null;
  if (!Array.isArray(est)) return null; // an older cached shape
  const days = (a, b) => (Date.parse(a) - Date.parse(b)) / 86400e3;
  /** the estimate for the quarter ending `end`: reported within 100 days after it */
  const find = end => {
    const near = est.filter(e => e.revenue && e.date && days(e.date, end) > 0 && days(e.date, end) <= 100);
    return near.find(e => e.quarter === monthKey(end)) || near.sort((a, b) => (a.date < b.date ? -1 : 1))[0];
  };
  const millions = e => Math.round(e.revenue / 1e3) / 1e3;
  const out = { byPeriod: {}, next: null };
  for (const p of periods) {
    const e = p.q && find(p.end);
    if (e) out.byPeriod[p.key] = millions(e);
  }
  const latest = periods[0];
  if (latest) {
    const e = find(new Date(Date.parse(latest.end) + 91 * 86400e3).toISOString().slice(0, 10));
    if (e) out.next = { revenue: millions(e), eps: e.eps, date: e.date };
  }
  return out;
}

// ------------------------------------------------------------ full-year estimates
/** [{ end: 'YYYY-MM-DD', revenue, analysts }] per fiscal year (past and future), or null without a key. */
async function annualEstimates(cacheDir, ticker) {
  const key = (process.env.EULERPOOL_API_KEY || '').trim();
  const t = String(ticker || '').toUpperCase();
  if (!key || !/^[A-Z0-9.-]{1,10}$/.test(t)) return null;
  const file = path.join(cacheDir, 'estimates', t + '-annual.json');
  try {
    const st = await fs.promises.stat(file);
    if (Date.now() - st.mtimeMs < TTL) return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch { /* not cached yet */ }
  try {
    const res = await fetch(`https://api.eulerpool.com/api/1/equity/estimates/${encodeURIComponent(t)}?token=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const out = (await res.json())
      .filter(r => !r.quarter && r.period && r.revenueEstimate > 0)
      .map(r => ({ end: r.period.slice(0, 10), revenue: r.revenueEstimate, analysts: r.revenueAnalysts ?? null }));
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(out));
    return out;
  } catch (e) {
    console.error(new Date().toISOString(), 'annual estimates', t, e.message);
    try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; }
  }
}

/** { periodKey: millions } for the statement's years (and the projected year), matched by year-end (±20 days). */
function forYears(est, periods) {
  if (!Array.isArray(est)) return null;
  const out = {};
  for (const p of periods) {
    if (p.key === 'TTM') continue;
    const e = est.find(x => Math.abs(Date.parse(x.end) - Date.parse(p.end)) <= 20 * 86400e3);
    if (e) out[p.key] = Math.round(e.revenue / 1e3) / 1e3;
  }
  return out;
}

const TIMING = { 'time-pre-market': 'before-open', 'time-after-hours': 'after-close' };
/**
 * The announced date of the earnings our estimate ({ date }) stands for: the upcoming report within
 * 45 days of it that has a time of day, as { date, timing }; or null.
 */
function announced(est, estimate) {
  if (!Array.isArray(est) || !estimate) return null;
  const today = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const gap = e => Math.abs(Date.parse(e.date) - Date.parse(estimate.date));
  const e = est.filter(e => e.date && e.date >= today && gap(e) <= 45 * 86400e3).sort((a, b) => gap(a) - gap(b))[0];
  return e && TIMING[e.time] ? { date: e.date, timing: TIMING[e.time] } : null;
}

module.exports = { quarterEstimates, annualEstimates, forPeriods, forYears, announced, monthKey };
