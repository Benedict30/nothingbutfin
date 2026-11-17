// Checks the market page's figures: monthly averages, each daily line ending at its latest day's value.
// Run: node test/macro.test.js
const assert = require('assert');
const { assemble } = require('../lib/macro');

const days = (month, values) => values.map((v, i) => [`${month}-${String(i + 2).padStart(2, '0')}`, v]);
const at = (r, key, month) => r[key][r.months.indexOf(month)];
const feeds = {
  gs10: [['2026-09-01', 4.99], ['2026-10-01', 5.13]], // FRED's monthly 10-year yield: nothing for November yet
  dgs10: [...days('2026-09', [5, 5]), ...days('2026-10', [5, 5.2]), ...days('2026-11', [4.9, 4.98])],
  oilM: [['2026-09-01', 97.31]], // FRED's monthly oil price: October not published yet
  oilD: [...days('2026-09', [97, 98]), ...days('2026-10', [100, 104]), ...days('2026-11', [100.06, 89.62])],
  spD: [...days('2026-09', [7600, 7700]), ...days('2026-10', [7700, 7750]), ...days('2026-11', [7568.92, 7592.4])],
  fedD: [['2026-09-30', 4], ['2026-10-31', 4], ['2026-11-12', 4], ['2026-11-13', 4.25]],
  pce: [['2025-09-01', 100], ['2026-09-01', 103.12]],
};

// mid-November: the month under way is on the chart, and each daily line ends at its latest day's value
const r = assemble(feeds, new Date('2026-11-13T12:00:00Z'));
assert.strictEqual(r.months.at(-1), '2026-11');
assert.strictEqual(at(r, 'yield10', '2026-10'), 5.13); // FRED's monthly figure, not our average of the days (5.1)
assert.strictEqual(at(r, 'yield10', '2026-11'), 4.98);
assert.strictEqual(at(r, 'oil', '2026-09'), 97.31);
assert.strictEqual(at(r, 'oil', '2026-10'), 102); // no monthly figure yet: the average of October's days
assert.strictEqual(at(r, 'oil', '2026-11'), 89.62);
assert.strictEqual(at(r, 'sp500', '2026-10'), 7725);
assert.strictEqual(at(r, 'sp500', '2026-11'), 7592.4); // the latest close, not the month-to-date average (7580.66)
assert.strictEqual(at(r, 'fed', '2026-11'), 4.25); // a month's Fed rate is its last day's
assert.strictEqual(at(r, 'inflation', '2026-09'), 3.12);
assert.strictEqual(at(r, 'inflation', '2026-11'), null); // not reported yet
for (const key of ['sp500', 'yield10', 'oil']) { // the end of each daily line is the figure in `latest`
  assert.strictEqual(r.latest[key].date.slice(0, 7), '2026-11');
  assert.strictEqual(at(r, key, '2026-11'), r.latest[key].value);
}

// a daily series that has fallen behind the monthly one doesn't overwrite a finished month
const stale = assemble({ ...feeds, oilM: [['2026-09-01', 97.31], ['2026-10-01', 102.07]], oilD: days('2026-09', [97, 98]) }, new Date('2026-11-13T12:00:00Z'));
assert.strictEqual(at(stale, 'oil', '2026-09'), 97.31);
assert.strictEqual(at(stale, 'oil', '2026-10'), 102.07);
assert.strictEqual(at(stale, 'oil', '2026-11'), null);

// the earnings yield: the last four quarters' earnings per share as a % of the month's S&P 500
const valued = assemble({ ...feeds, earnings: [['2026-09', 300], ['2026-10', 309]] }, new Date('2026-11-13T12:00:00Z'));
assert.strictEqual(at(valued, 'earningsYield', '2026-09'), 3.92); // 300 / 7650
assert.strictEqual(at(valued, 'earningsYield', '2026-10'), 4); // 309 / 7725
assert.strictEqual(at(valued, 'earningsYield', '2026-11'), 4.07); // no November earnings yet: October's, over the latest close
assert.deepStrictEqual(valued.latest.earningsYield, { value: 4.07, date: '2026-11-03', pe: 24.6, earningsTo: '2026-10' });
assert.ok(!('earningsYield' in r) && !r.latest.earningsYield); // without earnings the page simply has no such line
// earnings that stopped over a year ago aren't carried on: the line ends and there is no latest figure
const stopped = assemble({ ...feeds, earnings: [['2025-09', 250], ['2025-10', 255]] }, new Date('2026-11-13T12:00:00Z'));
assert.strictEqual(at(stopped, 'earningsYield', '2026-10'), 3.3); // 12 months on: still October 2025's
assert.strictEqual(at(stopped, 'earningsYield', '2026-11'), null);
assert.strictEqual(stopped.latest.earningsYield, undefined);

console.log('macro: all assertions passed');
