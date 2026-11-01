// Checks earnings-day figures: spotting the release, parsing printed numbers, the word-for-word
// check, unit conversion and turning year-to-date figures into the quarter.
// Run: node test/preliminary.test.js
const assert = require('assert');
const { pendingRelease, toValues, parseNumber, estimateNextEarnings, estimateUpcoming } = require('../lib/preliminary');

// printed numbers
assert.strictEqual(parseNumber('1,546,793'), 1546793);
assert.strictEqual(parseNumber('$ (262,970 )'), -262970);
assert.strictEqual(parseNumber('(0.55)'), -0.55);
assert.strictEqual(parseNumber('—'), null);

// a quarterly block: fiscal Q1 and Q2 of FY2027 already in the XBRL data (USD millions)
const quarterly = {
  periods: [
    { key: '2027Q2', fy: 2027, q: 2, end: '2026-07-31' },
    { key: '2027Q1', fy: 2027, q: 1, end: '2026-04-30' },
    { key: '2026Q4', fy: 2026, q: 4, end: '2026-01-31' },
    { key: '2026Q3', fy: 2026, q: 3, end: '2025-10-31' },
  ],
  statements: { cash: { rows: [{ key: 'cfo', vals: [91.357, 243.223, 781.154, 137.519] }] } },
};

// the release: an Item 2.02 8-K filed after the next quarter (Q3, ~Oct 31) ended
const subs = {
  cik: '0001640147',
  filings: { recent: {
    accessionNumber: ['A-q2', 'A-other', 'A-q3'],
    form: ['8-K', '8-K', '8-K'],
    items: ['2.02,9.01', '5.07', '2.02,9.01'],
    filingDate: ['2026-09-02', '2026-11-10', '2026-12-02'],
  } },
};
const pending = pendingRelease(quarterly, subs);
assert.strictEqual(pending.key, '2027Q3');
assert.strictEqual(pending.end, '2026-10-30'); // a year after Q3 2025's end
assert.strictEqual(pending.release.accn, 'A-q3');
assert.strictEqual(pendingRelease(quarterly, { ...subs, filings: { recent: { ...subs.filings.recent, filingDate: ['2026-09-02', '2026-11-10', '2026-10-01'] } } }), null);

// figures: printed number + label must be in the release; units converted here
const release = `Condensed Consolidated Statements of Operations (in thousands, except per share data)
Revenue $ 1,588,400 $ 1,212,909
Net loss $ ( 210,500 ) $ ( 293,957 )
Diluted net loss per share $ (0.60 ) $ (0.87 )
Net cash provided by operating activities 512,300
Purchases of property and equipment ( 21,000 )`;
const items = [
  { key: 'revenue', rowLabel: 'Revenue', asReported: '1,588,400', scale: 'thousands', basis: 'quarter' },
  { key: 'netIncome', rowLabel: 'Net loss', asReported: '(210,500)', scale: 'thousands', basis: 'quarter' },
  { key: 'epsDiluted', rowLabel: 'Diluted net loss per share', asReported: '(0.60)', scale: 'thousands', basis: 'quarter' },
  { key: 'cfo', rowLabel: 'Net cash provided by operating activities', asReported: '512,300', scale: 'thousands', basis: 'year-to-date' },
  { key: 'capex', rowLabel: 'Purchases of property and equipment', asReported: '(21,000)', scale: 'thousands', basis: 'quarter' },
  { key: 'opIncome', rowLabel: 'Operating loss', asReported: '(999,999)', scale: 'thousands', basis: 'quarter' }, // not in the release
];
const { values, dropped } = toValues(items, release, pending, quarterly, 'Preliminary: test');
assert.strictEqual(values.revenue.value, 1588.4);
assert.strictEqual(values.netIncome.value, -210.5);
assert.strictEqual(values.epsDiluted.value, -0.6); // per share: not scaled
assert.strictEqual(values.cfo.value, Math.round((512.3 - 243.223 - 91.357) * 1000) / 1000); // 9M − Q1 − Q2
assert.ok(/year to date/.test(values.cfo.src));
assert.strictEqual(values.capex.value, -21);
assert.strictEqual(values.fcf.value, Math.round((values.cfo.value - 21) * 1000) / 1000);
assert.strictEqual(values.opIncome, undefined);
assert.strictEqual(dropped, 1);

// next earnings: same quarter last year + 52 weeks, after the latest release
// and the usual time of day, in New York time (EDGAR records UTC)
const history = { filings: { recent: {
  accessionNumber: ['a', 'b', 'c', 'd', 'e', 'f'],
  form: ['8-K', '8-K', '8-K', '8-K', '8-K', '10-Q'],
  items: ['2.02,9.01', '2.02,9.01', '2.02', '2.02,9.01', '5.07', ''],
  filingDate: ['2026-09-02', '2026-05-27', '2026-02-25', '2025-12-03', '2025-11-20', '2026-09-04'],
  acceptanceDateTime: ['2026-09-02T20:08:00.000Z', '2026-05-27T20:07:00.000Z', '2026-02-25T21:07:00.000Z', '2025-12-03T21:06:00.000Z', '2025-11-20T12:00:00.000Z', '2026-09-04T21:00:00.000Z'],
} } };
assert.deepStrictEqual(estimateNextEarnings(history), { date: '2026-12-02', basedOn: '2025-12-03', timing: 'after-close', time: '16:07' });
// the next four quarters, soonest first
assert.deepStrictEqual(estimateUpcoming(history).map(e => e.date), ['2026-12-02', '2027-02-24', '2027-05-26', '2027-09-01']);
const morning = JSON.parse(JSON.stringify(history));
morning.filings.recent.acceptanceDateTime = morning.filings.recent.acceptanceDateTime.map(() => '2026-07-14T10:30:00.000Z');
assert.strictEqual(estimateNextEarnings(morning).timing, 'before-open'); // 6:30 am ET
assert.strictEqual(estimateNextEarnings({ filings: { recent: { accessionNumber: ['a'], form: ['8-K'], items: ['2.02'], filingDate: ['2026-09-02'] } } }), null);

console.log('preliminary: all assertions passed');
