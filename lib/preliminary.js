/*
 * preliminary.js — earnings-day figures from the press release, before the 10-Q / 10-K.
 *
 * A company announces results in a press release (8-K, Item 2.02, exhibit 99.1); the
 * structured XBRL data only arrives with the 10-Q or 10-K, often days later. Until then:
 *  1. spot the release: a results 8-K filed after the next quarter ended, with that quarter
 *     not yet in the XBRL data
 *  2. ask Claude to read the release's GAAP tables: for each line, the number exactly as
 *     printed, the table's scale and whether it is the quarter or year to date
 *  3. keep a figure only if the number and its row label appear word for word in the release;
 *     convert units here (not by Claude), and turn year-to-date figures into the quarter
 *     using the earlier quarters already in the data
 * Results are cached per press release; the 10-Q's data replaces them when it arrives.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { askClaude, apiKey, costOf } = require('./magazine');

// statement lines read from a press release: key -> [unit, what to look for]
const LINES = {
  revenue: ['money', 'Total revenue'],
  cogs: ['money', 'Total cost of revenue'],
  grossProfit: ['money', 'Gross profit'],
  rnd: ['money', 'Research and development expense'],
  sga: ['money', 'Selling, general and administrative expense (only if shown as one combined line)'],
  opex: ['money', 'Total operating expenses'],
  opIncome: ['money', 'Operating income (loss)'],
  interestExp: ['money', 'Interest expense'],
  pretax: ['money', 'Income (loss) before income taxes'],
  tax: ['money', 'Provision for (benefit from) income taxes'],
  netIncome: ['money', 'Net income (loss) attributable to the company'],
  epsBasic: ['perShare', 'Basic net income (loss) per share'],
  epsDiluted: ['perShare', 'Diluted net income (loss) per share'],
  sharesBasic: ['shares', 'Weighted-average shares, basic'],
  sharesDiluted: ['shares', 'Weighted-average shares, diluted'],
  cash: ['money', 'Cash and cash equivalents'],
  stInv: ['money', 'Short-term investments'],
  receivables: ['money', 'Accounts receivable, net'],
  inventory: ['money', 'Inventories'],
  curAssets: ['money', 'Total current assets'],
  assets: ['money', 'Total assets'],
  payables: ['money', 'Accounts payable'],
  curLiab: ['money', 'Total current liabilities'],
  liabilities: ['money', 'Total liabilities'],
  equity: ['money', 'Total stockholders’ equity'],
  liabEquity: ['money', 'Total liabilities and stockholders’ equity'],
  da: ['money', 'Depreciation and amortization (cash flow statement)'],
  sbc: ['money', 'Stock-based compensation (cash flow statement)'],
  cfo: ['money', 'Net cash provided by (used in) operating activities'],
  capex: ['money', 'Purchases of property and equipment / capital expenditures'],
  cfi: ['money', 'Net cash provided by (used in) investing activities'],
  cff: ['money', 'Net cash provided by (used in) financing activities'],
};
const STOCK = new Set(['cash', 'stInv', 'receivables', 'inventory', 'curAssets', 'assets', 'payables', 'curLiab', 'liabilities', 'equity', 'liabEquity']);
const SCALE = { ones: 1e-6, thousands: 1e-3, millions: 1, billions: 1e3 }; // to millions

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['periodEnd', 'items'],
  properties: {
    periodEnd: { type: 'string', description: 'Last day of the quarter the release reports, YYYY-MM-DD' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'rowLabel', 'asReported', 'scale', 'basis'],
        properties: {
          key: { type: 'string', enum: Object.keys(LINES) },
          rowLabel: { type: 'string', description: 'The row label exactly as printed in the table' },
          asReported: { type: 'string', description: 'The number exactly as printed, e.g. "1,546,793" or "(262,970)" or "(0.55)"' },
          scale: { type: 'string', enum: ['ones', 'thousands', 'millions', 'billions'], description: 'From the table heading, e.g. "in thousands, except per share data" = thousands' },
          basis: { type: 'string', enum: ['quarter', 'year-to-date', 'point-in-time'] },
        },
      },
    },
  },
};

const SYSTEM = `You read a company's earnings press release and copy figures out of its GAAP financial tables for the most recent quarter.

Lines to look for (key: description):
${Object.entries(LINES).map(([k, [, d]]) => `- ${k}: ${d}`).join('\n')}

Rules:
- Use the GAAP tables (statements of operations, balance sheets, cash flows), not non-GAAP reconciliations or highlights.
- Income statement and cash flow lines: take the three-month column for the most recent quarter (basis "quarter"). If a line is only given year to date, take the year-to-date column for the most recent period (basis "year-to-date").
- Balance sheet lines: the most recent date (basis "point-in-time").
- asReported is the number exactly as printed, including parentheses for negatives. Do not convert, round or calculate anything.
- scale comes from the table heading. Per-share amounts are in ones.
- Skip a line that is not in the tables. Never estimate.`;

// ------------------------------------------------------------ the pending release
const DAY = 86400e3;
const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);
const calLabel = end => { const d = new Date(Date.parse(end) - 45 * DAY); return 'Q' + (Math.floor(d.getUTCMonth() / 3) + 1) + ' ' + d.getUTCFullYear(); };

/** The next quarter after the data's latest one, if a results 8-K for it is already filed. */
function pendingRelease(quarterly, submissions) {
  const ps = quarterly.periods;
  const r = submissions.filings && submissions.filings.recent;
  if (ps.length < 4 || !r) return null;
  const last = ps[0];
  const fy = last.q === 4 ? last.fy + 1 : last.fy, q = last.q === 4 ? 1 : last.q + 1;
  const yearAgo = ps.find(p => p.fy === fy - 1 && p.q === q);
  const end = yearAgo ? addDays(yearAgo.end, 364) : addDays(last.end, 91); // ±7 days for 52/53-week years
  let best = null;
  for (let i = 0; i < r.accessionNumber.length; i++) {
    if (r.form[i] !== '8-K' || !String(r.items[i] || '').split(',').includes('2.02')) continue;
    if (r.filingDate[i] < addDays(end, -7)) continue; // announces an earlier quarter
    if (!best || r.filingDate[i] < best.filed) best = { accn: r.accessionNumber[i], filed: r.filingDate[i] };
  }
  if (!best) return null;
  const folder = `https://www.sec.gov/Archives/edgar/data/${+submissions.cik}/${best.accn.replace(/-/g, '')}`;
  return {
    key: fy + 'Q' + q, fy, q, end,
    release: { ...best, indexUrl: `${folder}/${best.accn}-index.htm` },
  };
}

// New York time of an EDGAR acceptance timestamp (recorded in UTC), as minutes after midnight.
const nyMinutes = iso => {
  const [h, m] = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).split(':').map(Number);
  return h * 60 + m;
};

/**
 * Estimated upcoming earnings dates: companies report on a steady cycle, so each results 8-K of
 * the past year, plus 52 weeks (same weekday), estimates the same quarter's next report, usually
 * within a few days. The time of day comes from the last four releases (when EDGAR accepted
 * them), in New York time. Returns up to `count` of [{ date, basedOn, timing?, time? }], soonest
 * first ([] for annual-only filers or too little history).
 *   timing: 'before-open' (before 9:30) | 'after-close' (4:00 pm or later) | 'during'; time: "HH:MM" ET
 */
function estimateUpcoming(submissions, count = 4) {
  const r = submissions.filings && submissions.filings.recent;
  if (!r) return [];
  const releases = [];
  for (let i = 0; i < r.accessionNumber.length; i++) {
    if (r.form[i] === '8-K' && String(r.items[i] || '').split(',').includes('2.02')) releases.push({ date: r.filingDate[i], at: r.acceptanceDateTime && r.acceptanceDateTime[i] });
  }
  if (releases.length < 4) return [];
  const latest = releases.reduce((a, b) => (a > b.date ? a : b.date), '');
  const seen = new Set();
  const upcoming = releases
    .map(({ date }) => ({ date: addDays(date, 364), basedOn: date }))
    .filter(e => e.date > addDays(latest, 45) && !seen.has(e.date) && seen.add(e.date))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(0, count);
  // usual time of day: the median of the last four releases
  const mins = releases.filter(x => x.at).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 4).map(x => nyMinutes(x.at)).sort((a, b) => a - b);
  if (mins.length) {
    const m = mins[Math.floor(mins.length / 2)];
    const timing = m < 9 * 60 + 30 ? 'before-open' : m >= 16 * 60 ? 'after-close' : 'during';
    const time = String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    for (const e of upcoming) Object.assign(e, { timing, time });
  }
  return upcoming;
}
/** The soonest of estimateUpcoming, or null. */
const estimateNextEarnings = submissions => estimateUpcoming(submissions, 1)[0] || null;

// ------------------------------------------------------------ checking and converting
const squash = s => String(s).replace(/[\s$ ]/g, ''); // tables split "$", "(" and ")" across cells
const words = s => String(s).toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();
function parseNumber(s) {
  const t = squash(s).replace(/,/g, '');
  if (!/\d/.test(t)) return null;
  const neg = /^\(.*\)$/.test(t) || /^[-−–]/.test(t);
  const n = parseFloat(t.replace(/[()\-−–]/g, ''));
  return isFinite(n) ? (neg ? -n : n) : null;
}

/**
 * Turns Claude's items into values (millions; per-share in units; shares in millions).
 * quarterly: the XBRL quarterly block, to turn year-to-date figures into the quarter.
 */
function toValues(items, text, pending, quarterly, src) {
  const hayNum = squash(text), hayWords = words(text);
  const rows = new Map(Object.values(quarterly.statements).flatMap(st => st.rows.map(r => [r.key, r])));
  const ix = new Map(quarterly.periods.map((p, i) => [p.key, i]));
  const values = {};
  let dropped = 0;
  for (const it of items) {
    if (values[it.key] || !LINES[it.key]) continue;
    // the number and its label must be printed in the release
    if (!hayNum.includes(squash(it.asReported)) || !hayWords.includes(words(it.rowLabel))) { dropped++; continue; }
    const n = parseNumber(it.asReported);
    if (n == null) { dropped++; continue; }
    const unit = LINES[it.key][0];
    let v = unit === 'perShare' ? n : n * SCALE[it.scale];
    if (it.key === 'capex') v = -Math.abs(v); // outflow, as in the statements
    let note = '';
    if (it.basis === 'year-to-date' && !STOCK.has(it.key) && pending.q > 1) {
      if (unit !== 'money') { dropped++; continue; } // per-share and share counts do not subtract
      const prior = [];
      for (let k = 1; k < pending.q; k++) prior.push(rows.get(it.key)?.vals[ix.get(pending.fy + 'Q' + k)]);
      if (prior.some(x => x == null)) { dropped++; continue; }
      v -= prior.reduce((a, b) => a + b, 0);
      note = ' · calculated from year to date';
    }
    values[it.key] = { value: Math.round(v * 1000) / 1000, src: src + note };
  }
  // the simple totals the statements also derive
  const val = k => values[k]?.value;
  const calc = (k, v, how) => { if (values[k] == null && v != null && isFinite(v)) values[k] = { value: Math.round(v * 1000) / 1000, src: 'derived: ' + how }; };
  calc('grossProfit', val('revenue') != null && val('cogs') != null ? val('revenue') - val('cogs') : null, 'Revenue − Cost of Revenue');
  calc('fcf', val('cfo') != null && val('capex') != null ? val('cfo') + val('capex') : null, 'Cash From Operations − Capital Expenditures');
  calc('ebitda', val('opIncome') != null && val('da') != null ? val('opIncome') + val('da') : null, 'Operating Income + D&A');
  if (values.netIncome) values.cfNetIncome = values.netIncome;
  return { values, dropped };
}

// ------------------------------------------------------------ jobs
const jobs = new Map(); // release accn -> { state: 'generating' | 'error', message }
const file = (cacheDir, accn) => path.join(cacheDir, 'preliminary', accn + '.json');

/**
 * Preliminary column for a company, or null when no release is waiting for its 10-Q.
 * Starts reading the release in the background the first time it is asked for.
 */
async function preliminaryFor({ cacheDir, quarterly, submissions, company, getText, exhibitUrl, htmlToText }) {
  const pending = pendingRelease(quarterly, submissions);
  if (!pending) return null;
  const { accn } = pending.release;
  const base = { key: pending.key, label: calLabel(pending.end), fy: pending.fy, q: pending.q, end: pending.end, months: 3, preliminary: true };
  try {
    const saved = JSON.parse(await fs.promises.readFile(file(cacheDir, accn), 'utf8'));
    return { status: 'ready', period: { ...base, ...saved.period }, release: saved.release, values: saved.values, cost: costOf(saved.model, saved.usage) };
  } catch {}
  const job = jobs.get(accn);
  if (job && !(job.state === 'error' && Date.now() - job.at > 5 * 60e3)) return { status: job.state, message: job.message, period: base };
  const key = apiKey();
  if (!key) return { status: 'no-key', period: base };

  jobs.set(accn, { state: 'generating' });
  (async () => {
    const url = exhibitUrl(await getText(pending.release.indexUrl, accn + '-index.htm'));
    if (!url) throw new Error('The press release was not found in the 8-K.');
    const text = htmlToText(await getText(url, accn + '-ex99.htm'));
    const r = await askClaude({
      key, system: SYSTEM, schema: SCHEMA, what: 'figures', about: `${company.ticker || company.name} ${pending.key}`,
      user: `Company: ${company.name}\nThe quarter expected to end around ${pending.end}.\n\n<press_release>\n${text}\n</press_release>`,
    });
    if (r.status !== 'ok') throw new Error(r.message);
    // the reported quarter must be the one expected (52/53-week years move by a few days)
    const end = /^\d{4}-\d{2}-\d{2}$/.test(r.json.periodEnd) && Math.abs(Date.parse(r.json.periodEnd) - Date.parse(pending.end)) <= 10 * DAY ? r.json.periodEnd : pending.end;
    const release = { accn, filed: pending.release.filed, url };
    const { values, dropped } = toValues(r.json.items, text, { ...pending, end }, quarterly, `Preliminary: earnings press release (8-K filed ${release.filed})`);
    const saved = { period: { end, label: calLabel(end) }, release, values, dropped, model: r.msg.model, usage: r.msg.usage, createdAt: new Date().toISOString() };
    await fs.promises.mkdir(path.dirname(file(cacheDir, accn)), { recursive: true });
    await fs.promises.writeFile(file(cacheDir, accn), JSON.stringify(saved));
  })().then(
    () => jobs.delete(accn),
    e => jobs.set(accn, { state: 'error', at: Date.now(), message: e.message || 'The press release could not be read.' }), // retried after 5 min
  );
  return { status: 'generating', period: base };
}

module.exports = { pendingRelease, preliminaryFor, estimateNextEarnings, estimateUpcoming, toValues, parseNumber, LINES };
