// Checks the normalizer against a synthetic company whose filings mimic real EDGAR quirks:
//  - fiscal year ends Jan 31; company labels FY by the year it ends in (Walmart-style)
//  - 10-Qs report 3-month AND year-to-date income figures, but YTD-only cash flow
//  - 10-K reports 3 annual years and no Q4 figures
//  - every value repeats as a comparative in later filings
//  - a later 10-K restates an older year (latest filed must win)
// Run: node test/normalize.test.js
const assert = require('assert');
const { normalize } = require('../lib/edgar');
const { buildFixture, truth } = require('./fixture');
const { rev, cfo, eps, assets } = truth;

const out = normalize(buildFixture());
const Q = out.quarterly, A = out.annual;
const row = (blk, st, key) => blk.statements[st].rows.find(r => r.key === key);
// looked up by fiscal key (e.g. '2026Q2', 'FY2024'); labels are calendar periods
const at = (blk, st, key, pkey) => row(blk, st, key).vals[blk.periods.findIndex(p => p.key === pkey)];

// Calendar: fiscal keys follow the company (FY ending Jan 2025 = FY 2025);
// labels are the calendar period each one mostly covers.
assert.deepStrictEqual(Q.periods.slice(0, 3).map(p => p.key), ['2026Q2', '2026Q1', '2025Q4']);
assert.deepStrictEqual(Q.periods.slice(0, 3).map(p => p.label), ['Q2 2025', 'Q1 2025', 'Q4 2024']);
assert.strictEqual(Q.periods[0].end, '2025-07-31');
assert.deepStrictEqual(A.periods.slice(0, 4).map(p => p.key), ['PROJ', 'TTM', 'FY2025', 'FY2024']);
assert.deepStrictEqual(A.periods.slice(2, 5).map(p => p.label), ['2024', '2023', '2022']);
assert.strictEqual(A.periods[2].end, '2025-01-31');

// Projected year (FY2026 under way, 2 quarters in): Q1 + Q2 reported, then g = Q2 / Q1 − 1,
// Q3 = Q2 × (1 + g), Q4 = Q3 × (1 + g); balance sheet not projected
const q1 = rev(2026, 1), q2 = rev(2026, 2), g = q2 / q1, q3 = q2 * g, q4 = q3 * g;
assert.ok(Math.abs(at(A, 'income', 'revenue', 'PROJ') - (q1 + q2 + q3 + q4)) < 0.01);
assert.deepStrictEqual(A.periods[0].projected, { reported: ['Q1 2025', 'Q2 2025'], projected: ['Q3 2025', 'Q4 2025'], from: 'Q1 2025', to: 'Q2 2025' });
assert.strictEqual(at(A, 'balance', 'assets', 'PROJ'), null);

// TTM: last four quarters summed for flows, latest quarter for the balance sheet
assert.strictEqual(A.periods[1].end, Q.periods[0].end);
assert.strictEqual(at(A, 'income', 'revenue', 'TTM'), rev(2026, 2) + rev(2026, 1) + rev(2025, 4) + rev(2025, 3));
assert.strictEqual(at(A, 'cash', 'cfo', 'TTM'), cfo(2026, 2) + cfo(2026, 1) + cfo(2025, 4) + cfo(2025, 3));
assert.strictEqual(at(A, 'balance', 'assets', 'TTM'), assets(2026, 2));
assert.strictEqual(row(A, 'income', 'revenue').ttmYearAgo, rev(2025, 2) + rev(2025, 1) + rev(2024, 4) + rev(2024, 3));
assert.strictEqual(out.company.fiscalYearEnd, '01-31');

// Direct quarter, Q4 derived from FY − 9M, annual
assert.strictEqual(at(Q, 'income', 'revenue', '2026Q2'), rev(2026, 2));
assert.strictEqual(at(Q, 'income', 'revenue', '2024Q4'), rev(2024, 4));
assert.strictEqual(at(A, 'income', 'revenue', 'FY2024'), rev(2024, 1) + rev(2024, 2) + rev(2024, 3) + rev(2024, 4));
// Restatement: FY2023 restated in the FY2025 10-K → latest filed wins
assert.strictEqual(at(A, 'income', 'revenue', 'FY2023'), 9999);

// Cash flow: YTD-only in 10-Qs → Q2 = 6M − 3M, Q3 = 9M − 6M, Q4 = FY − 9M
for (const q of [1, 2, 3, 4]) assert.strictEqual(at(Q, 'cash', 'cfo', '2024Q' + q), cfo(2024, q), 'cfo Q' + q);
const src = row(Q, 'cash', 'cfo').src[Q.periods.findIndex(p => p.key === '2024Q3')];
assert.ok(/derived: 9M − 6M YTD/.test(src), src);

// Capex shown as an outflow; FCF = CFO − capex
const capex = at(Q, 'cash', 'capex', '2026Q2');
assert.ok(capex < 0);
assert.strictEqual(at(Q, 'cash', 'fcf', '2026Q2'), cfo(2026, 2) + capex);

// Balance sheet: instant at period end
assert.strictEqual(at(Q, 'balance', 'assets', '2026Q1'), assets(2026, 1));
assert.strictEqual(at(A, 'balance', 'assets', 'FY2025'), assets(2025, 4));

// EPS Q4 approximated as FY − 9M; shares Q4 left blank (not additive)
assert.ok(Math.abs(at(Q, 'income', 'epsDiluted', '2024Q4') - eps(2024, 4)) < 0.011);
assert.strictEqual(at(Q, 'income', 'sharesDiluted', '2024Q4'), null);

// EBITDA = operating income + D&A
const ebitda = at(A, 'income', 'ebitda', 'FY2024');
assert.ok(Math.abs(ebitda - (at(A, 'income', 'opIncome', 'FY2024') + at(A, 'cash', 'da', 'FY2024'))) < 1e-6);

// Accounting identities tie out in every period where all parts are present. The one
// exception is fiscal 2023, whose revenue the fixture restates without its other lines.
const { checkBlock } = require('./identities');
for (const [freq, blk] of [['annual', A], ['quarterly', Q]]) {
  const strict = checkBlock(blk).filter(r => r.kind === 'strict' && r.checked > 0); // fixture has no opex lines
  assert.ok(strict.length >= 2, freq + ': too few identities checked');
  for (const r of strict) {
    const unexpected = r.failedKeys.filter(k => k !== 'FY2023' && k !== '2023Q4');
    assert.deepStrictEqual(unexpected, [], freq + ': ' + r.name);
  }
}

// --- Regressions found on real EDGAR data -----------------------------------
// Walmart: calendar-year 12-month periods (consolidated subsidiaries) must not
// become extra fiscal years / duplicate quarter labels.
{
  const fx = buildFixture();
  const rows = fx.facts['us-gaap'].Revenues.units.USD;
  for (let y = 2020; y <= 2024; y++) rows.push({ accn: 'X' + y, fy: y + 1, fp: 'FY', form: '10-K', filed: (y + 1) + '-03-20', start: y + '-01-01', end: y + '-12-31', val: 1 });
  const o = normalize(fx);
  const labels = o.quarterly.periods.map(p => p.label);
  assert.strictEqual(new Set(labels).size, labels.length, 'duplicate quarter labels');
  assert.ok(o.annual.periods.filter(p => p.key !== 'TTM' && p.key !== 'PROJ').every(p => p.end.endsWith('-01-31')), 'calendar-year noise became a fiscal year');
}
// TSMC / Alibaba: annual-only (20-F) filers get no quarterly columns, and the
// reporting currency wins over a few USD convenience translations.
{
  const facts = { 'ifrs-full': { Revenue: { units: { TWD: [], USD: [] } }, Assets: { units: { TWD: [], USD: [] } } } };
  for (let y = 2020; y <= 2024; y++) {
    const base = { accn: 'F' + y, fy: y, fp: 'FY', form: '20-F', filed: (y + 1) + '-04-15' };
    for (const yy of [y, y - 1]) {
      facts['ifrs-full'].Revenue.units.TWD.push({ ...base, start: yy + '-01-01', end: yy + '-12-31', val: (1000 + yy) * 1e6 });
      facts['ifrs-full'].Assets.units.TWD.push({ ...base, end: yy + '-12-31', val: 5e9 });
    }
    facts['ifrs-full'].Revenue.units.USD.push({ ...base, start: y + '-01-01', end: y + '-12-31', val: 33e6 });
    facts['ifrs-full'].Assets.units.USD.push({ ...base, end: y + '-12-31', val: 1e8 });
  }
  const o = normalize({ cik: 9, entityName: 'Foreign Co', facts });
  assert.strictEqual(o.currency, 'TWD');
  assert.strictEqual(o.quarterly.periods.length, 0);
  assert.strictEqual(o.annual.statements.income.rows.find(r => r.key === 'revenue').vals[0], 1000 + 2024);
}

console.log('normalize: all assertions passed —', Q.periods.length, 'quarters,', A.periods.length, 'years');
