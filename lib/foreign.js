/*
 * foreign.js — quarterly figures for companies whose quarters aren't in SEC data: foreign companies
 * (Alibaba, TSMC…) file an annual 20-F with structured data, but their quarterly results only as
 * 6-K press releases. Eulerpool has those quarters; we use them only where SEC has none.
 *
 * Checked year by year against the company's SEC annual figures: a fiscal year's quarters are shown
 * only if they add up to SEC's year (for the balance sheet, if the year-end balance matches), within 1%.
 * Quarters after the latest annual report are shown if the year before them matched. Anything that
 * doesn't reconcile (a different definition, another currency) stays empty rather than wrong.
 * Kept 12 hours (cache/foreign/).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TTL = 12 * 3600e3;
const SRC = 'Eulerpool (quarterly results; not in SEC data)';

// our line → Eulerpool's field, per statement endpoint
const MAP = {
  'income-statement-quarterly': {
    revenue: 'revenue', cogs: 'costOfGoodsSold', grossProfit: 'grossIncome', rnd: 'researchDevelopment', sga: 'sgaExpense',
    opex: 'totalOperatingExpense', opIncome: 'ebit', pretax: 'pretaxIncome', tax: 'provisionforIncomeTaxes', netIncome: 'netIncome',
  },
  'balance-sheet-quarterly': {
    cash: 'cash', stInv: 'shortTermInvestments', receivables: 'totalReceivables', inventory: 'inventory', curAssets: 'currentAssets',
    ppe: 'propertyPlantEquipment', goodwill: 'goodwill', assets: 'totalAssets', payables: 'accountsPayable', stDebt: 'shortTermDebt',
    curLiab: 'currentLiabilities', ltDebt: 'longTermDebt', liabilities: 'totalLiabilities', equity: 'totalEquity', liabEquity: 'totalAssets',
  },
  'cashflow-statement-quarterly': {
    cfNetIncome: 'netIncomeStartingLine', da: 'amortization', cfo: 'netOperatingCashFlow', capex: 'capex', cfi: 'netInvestingCashFlow',
    dividends: 'cashDividendsPaid', cff: 'netCashFinancingActivities', fcf: 'fcf',
  },
};

/** { 'YYYY-MM-DD': { ourKey: value } } of reported quarters (Eulerpool's estimates, dated "…e", left out), or null. */
async function fetchQuarters(cacheDir, ticker) {
  const key = (process.env.EULERPOOL_API_KEY || '').trim();
  const t = String(ticker || '').toUpperCase();
  if (!key || !/^[A-Z0-9.-]{1,10}$/.test(t)) return null;
  const file = path.join(cacheDir, 'foreign', t + '.json');
  try {
    if (Date.now() - (await fs.promises.stat(file)).mtimeMs < TTL) return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch { /* not cached yet */ }
  try {
    const out = {};
    for (const [endpoint, fields] of Object.entries(MAP)) {
      const res = await fetch(`https://api.eulerpool.com/api/1/equity/${endpoint}/${encodeURIComponent(t)}?token=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(endpoint + ' HTTP ' + res.status);
      for (const r of await res.json()) {
        if (!/^\d{4}-\d\d-\d\d$/.test(r.period || '')) continue;
        const q = (out[r.period] = out[r.period] || {});
        for (const [ours, theirs] of Object.entries(fields)) if (typeof r[theirs] === 'number') q[ours] = r[theirs];
      }
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(out));
    return out;
  } catch (e) {
    console.error(new Date().toISOString(), 'foreign', t, e.message);
    try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; }
  }
}

const calDate = end => new Date(Date.parse(end) - 45 * 86400e3); // the calendar quarter a period mostly covers
const calQuarter = end => 'Q' + (Math.floor(calDate(end).getUTCMonth() / 3) + 1) + ' ' + calDate(end).getUTCFullYear();

/**
 * Fills an empty quarterly block (result.quarterly) from Eulerpool, for the lines that match the SEC
 * annual figures. Returns true if it added any quarters. The annual block is left as SEC has it.
 */
async function fillQuarters(result, cacheDir) {
  if (result.quarterly.periods.length || !result.company.fiscalYearEnd || !result.annual.periods.length) return false;
  const data = await fetchQuarters(cacheDir, result.company.ticker);
  if (!data) return false;
  const fyEnd = +result.company.fiscalYearEnd.slice(0, 2); // month the fiscal year ends
  const periods = Object.keys(data).sort().reverse().map(end => {
    const d = new Date(Date.parse(end) - 10 * 86400e3 * (+end.slice(8) < 10 ? 1 : 0)); // "2026-07-02" belongs to June
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    const ahead = (fyEnd - m + 12) % 12; // months to the fiscal year end
    const fy = m > fyEnd ? y + 1 : y, q = 4 - Math.round(ahead / 3);
    return { key: fy + 'Q' + q, label: calQuarter(end), fy, q, end, months: 3 };
  }).filter((p, i, a) => p.q >= 1 && p.q <= 4 && a.findIndex(x => x.key === p.key) === i);

  // per line: the fiscal years whose quarters reconcile with SEC's year
  const years = result.annual.periods.filter(p => /^FY\d+$/.test(p.key));
  const lastYear = Math.max(...years.map(y => y.fy));
  const matching = (stKind, row, vals) => {
    const ok = new Set();
    for (const y of years) {
      const a = row.vals[result.annual.periods.indexOf(y)];
      const qs = [1, 2, 3, 4].map(n => periods.findIndex(p => p.key === y.fy + 'Q' + n));
      if (a == null || qs.some(i => i < 0)) continue;
      const v = stKind === 'stock' ? vals[qs[3]] : qs.map(i => vals[i]).reduce((s, x) => (s == null || x == null ? null : s + x), 0);
      if (v != null && Math.abs(v - a) <= Math.max(Math.abs(a) * 0.01, row.unit === 'perShare' ? 0.05 : 1)) ok.add(y.fy);
    }
    if (ok.has(lastYear)) ok.add(lastYear + 1); // the quarters since the latest annual report
    return ok;
  };

  let kept = 0;
  for (const [stKey, st] of Object.entries(result.annual.statements)) {
    result.quarterly.statements[stKey] = {
      label: st.label,
      kind: st.kind,
      rows: st.rows.map(r => {
        const raw = periods.map(p => data[p.end][r.key] ?? null);
        const ok = matching(st.kind, r, raw);
        const vals = raw.map((v, i) => (ok.has(periods[i].fy) ? v : null));
        if (vals.some(v => v != null)) kept++;
        return { key: r.key, name: r.name, total: r.total, unit: r.unit, vals, src: vals.map(v => (v == null ? null : SRC)) };
      }),
    };
  }
  if (!kept) return false;
  // drop quarters left with no figures at all
  const used = periods.map((_, i) => Object.values(result.quarterly.statements).some(st => st.rows.some(r => r.vals[i] != null)));
  result.quarterly.periods = periods.filter((_, i) => used[i]);
  for (const st of Object.values(result.quarterly.statements)) for (const r of st.rows) {
    r.vals = r.vals.filter((_, i) => used[i]);
    r.src = r.src.filter((_, i) => used[i]);
  }
  result.quarterlySource = 'Eulerpool';
  return true;
}

module.exports = { fillQuarters };
