// Checks reading the S&P 500's earnings from a spreadsheet laid out like Robert Shiller's ie_data.xls
// (the two .xls files here are made by test/make-shiller-fixture.py, with made-up figures).
// Run: node test/shiller.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sheetNumbers } = require('../lib/xls');
const { pricesFromSpreadsheet, spreadsheetUrl } = require('../lib/shiller');

const file = fs.readFileSync(path.join(__dirname, 'shiller-fixture.xls'));

// the old Excel format: only numbers are read, at their row and column (both from 0)
const rows = sheetNumbers(file, 'Data');
assert.strictEqual(rows[7], undefined); // the header row is text
assert.deepStrictEqual([rows[8][0], rows[8][1], rows[8][2], rows[8][3], rows[8][5]], [1871.01, 4.44, 0.26, 0.4, 12.46406116]);
assert.ok(!(8 in rows[8])); // "NA" is text: nothing there
assert.strictEqual(rows[10][1], 2086); // a whole number
assert.strictEqual(rows[10][3], 103.1234567); // a number with many decimals
assert.strictEqual(rows[10][8], 30.5);
const last = rows.at(-1); // October 2026: a price but no earnings yet
assert.deepStrictEqual([last[0], last[1], 3 in last], [2026.1, 7633, false]);
assert.throws(() => sheetNumbers(file, 'Prices'), /no sheet named/);
assert.throws(() => sheetNumbers(Buffer.from('<html>not a spreadsheet</html>'.repeat(50)), 'Data'), /not an Excel/);
assert.throws(() => sheetNumbers(file.subarray(0, 9000), 'Data'), /\.xls/); // cut short: an error, not half the numbers

// prices by month (2026.1 is October), including the months that have no earnings yet
const prices = pricesFromSpreadsheet(file);
assert.deepStrictEqual(prices[0], ['1871-01', 4.44]);
assert.deepStrictEqual(prices.at(-1), ['2026-10', 7633]);
const months = prices.map(p => p[0]);
assert.ok(months.includes('2025-01') && months.includes('2026-07'));
assert.deepStrictEqual(months, [...months].sort());

// the earnings moved to another column: refused, not charted
assert.throws(() => pricesFromSpreadsheet(fs.readFileSync(path.join(__dirname, 'shiller-shifted.xls'))), /not laid out as expected/);

// the download link on the site's page (it changes with each upload)
assert.strictEqual(
  spreadsheetUrl('<a href="/about">x</a> <a href="//img1.wsimg.com/blobby/go/abc/downloads/def/ie_data.xls?ver=17&amp;x=1" target="_blank">Download</a>'),
  'https://img1.wsimg.com/blobby/go/abc/downloads/def/ie_data.xls?ver=17&x=1');
assert.throws(() => spreadsheetUrl('<a href="/other.xls">x</a>'), /no ie_data\.xls link/);
assert.throws(() => spreadsheetUrl('<a href="http://example.com/ie_data.xls">x</a>'), /not https/);

console.log('shiller: all assertions passed');
