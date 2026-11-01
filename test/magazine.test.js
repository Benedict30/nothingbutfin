// Checks the magazine helpers: filing lookup, filing text, MD&A extraction, quote verification.
// Run: node test/magazine.test.js
const assert = require('assert');
const { findFiling, findEarningsRelease, exhibitUrl, htmlToText, extractMdna, verifyQuotes } = require('../lib/magazine');

// Filing lookup: the original filing for the report date and form, not an amendment or a later one
const subs = {
  cik: '0001640147',
  filings: { recent: {
    accessionNumber: ['0001-26-000040', '0001-26-000037', '0001-26-000039', '0001-26-000008'],
    form: ['8-K', '10-Q', '10-Q/A', '10-K'],
    reportDate: ['2026-07-31', '2026-07-31', '2026-07-31', '2026-01-31'],
    filingDate: ['2026-08-27', '2026-09-04', '2026-09-20', '2026-03-20'],
    primaryDocument: ['x.htm', 'snow-20260731.htm', 'a.htm', 'snow-20260131.htm'],
  } },
};
const q = findFiling(subs, '2026-07-31', false);
assert.strictEqual(q.form, '10-Q');
assert.strictEqual(q.url, 'https://www.sec.gov/Archives/edgar/data/1640147/000126000037/snow-20260731.htm');
assert.strictEqual(findFiling(subs, '2026-01-31', true).form, '10-K'); // Q4 and annual periods use the 10-K
assert.strictEqual(findFiling(subs, '2026-01-31', false), null);

// Filing text: hidden XBRL header and markup removed, entities decoded, paragraphs kept
const html = '<html><head><title>t</title></head><body><div style="display:none"><ix:header>hidden facts</ix:header></div>' +
  '<p>Revenue grew&#160;35%&nbsp;&mdash; driven by product revenue.</p><p>Second&#8217;s paragraph</p></body></html>';
const text = htmlToText(html);
assert.ok(!text.includes('hidden facts'));
assert.strictEqual(text, 'Revenue grew 35% — driven by product revenue.\nSecond’s paragraph');

// MD&A: the real section (longest), not the table-of-contents entry
const body = 'x '.repeat(3000);
const doc = 'Table of contents\nManagement’s Discussion and Analysis 25\nQuantitative and Qualitative Disclosures About Market Risk 40\n' +
  'Item 2. Management’s Discussion and Analysis of Financial Condition\n' + body + '\nItem 3. Quantitative and Qualitative Disclosures About Market Risk\nrest';
const m = extractMdna(doc);
assert.strictEqual(m.section, 'MD&A');
assert.ok(m.text.startsWith('Management’s Discussion and Analysis of Financial Condition'));
assert.ok(!m.text.includes('Item 3. Quantitative'));
assert.strictEqual(extractMdna('short document').section, 'full document');

// Quotes: kept only when they appear word for word (ignoring curly quotes and spacing)
const src = 'We continue to see strong demand for our platform.  Product revenue was driven by consumption.';
const kept = verifyQuotes([
  { text: 'We continue to see strong demand for our platform.', context: 'demand' },
  { text: '"Product revenue was  driven by consumption."', context: 'drivers' },
  { text: 'We expect revenue to double next year.', context: 'invented' },
], src);
assert.deepStrictEqual(kept.map(k => k.context), ['demand', 'drivers']);

// Earnings release: the Item 2.02 8-K after the period end, not other 8-Ks or last quarter's
const subs8k = {
  cik: '0001640147',
  filings: { recent: {
    accessionNumber: ['A-old', 'A-502', 'A-801', 'A-202'],
    form: ['8-K', '8-K', '8-K', '8-K'],
    items: ['2.02,9.01', '5.02', '8.01', '2.02,9.01'],
    reportDate: ['', '', '', ''],
    filingDate: ['2026-05-27', '2026-08-10', '2026-08-20', '2026-09-02'],
    primaryDocument: ['', '', '', ''],
  } },
};
assert.strictEqual(findEarningsRelease(subs8k, '2026-07-31', '2026-09-04').accn, 'A-202');
assert.strictEqual(findEarningsRelease(subs8k, '2026-07-31', '2026-08-15'), null);

// Press release URL from the filing index page: the EX-99.1 row
const indexHtml = `<table><tr><td>1</td><td>8-K</td><td><a href="/ix?doc=/Archives/edgar/data/1/x/snow-8k.htm">snow-8k.htm</a></td><td>8-K</td><td>1</td></tr>
<tr class="evenRow"><td scope="row">2</td><td scope="row">EX-99.1</td><td scope="row"><a href="/Archives/edgar/data/1/x/fy2027q2earnings.htm">fy2027q2earnings.htm</a></td><td scope="row">EX-99.1</td><td>2</td></tr></table>`;
assert.strictEqual(exhibitUrl(indexHtml), 'https://www.sec.gov/Archives/edgar/data/1/x/fy2027q2earnings.htm');
assert.strictEqual(exhibitUrl('<table></table>'), null);

// Verbatim check on another field (executive quotes, metric evidence)
assert.deepStrictEqual(verifyQuotes([{ quote: '“We continue to see strong demand for our platform.”' }, { quote: 'Made up.' }], src, 'quote').length, 1);

console.log('magazine: all assertions passed');
