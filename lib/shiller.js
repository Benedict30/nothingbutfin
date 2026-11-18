/*
 * shiller.js — the S&P 500's monthly price, from the spreadsheet Robert Shiller publishes at shillerdata.com
 * (ie_data.xls: US stock prices, earnings and dividends since 1871). FRED has only the index's last 12 months.
 * The download link changes with each upload, so it's read off the page.
 * Kept a day (the file changes about monthly); the last good copy is used while the site can't be read.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { sheetNumbers } = require('./xls');

const TTL = 24 * 3600e3;
const SITE = 'https://shillerdata.com/';
const UA = 'Mozilla/5.0 (compatible; NothingButFin/1.0; +https://nothingbutfin.com)';

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }); // the market page waits on this
  if (!res.ok) throw new Error(`${url.slice(0, 80)}: HTTP ${res.status}`);
  return res;
}

/** The spreadsheet's address, from the site's download link (//img1.wsimg.com/…/ie_data.xls?ver=…). */
function spreadsheetUrl(html) {
  const m = /href="([^"]*\/ie_data\.xls[^"]*)"/i.exec(html);
  if (!m) throw new Error('no ie_data.xls link on the page');
  const url = new URL(m[1].replace(/&amp;/g, '&'), SITE);
  if (url.protocol !== 'https:') throw new Error('the ie_data.xls link is not https');
  return url.href;
}

/**
 * [['1871-01', 4.44], …]: the S&P's price (the average of the month's daily closes) by month, oldest first, from
 * the spreadsheet's bytes. On its "Data" sheet column A is the month as a number (2026.1 is October 2026), B the
 * S&P's price and D its earnings. January 1871 is checked against its known figures and there must be ten years of
 * months (what the page shows), so a changed layout is caught, not charted.
 */
function pricesFromSpreadsheet(file) {
  const prices = [];
  let first = null;
  for (const row of sheetNumbers(file, 'Data')) {
    if (!row || !(row[0] > 1800 && row[0] < 2200)) continue;
    const year = Math.floor(row[0]), month = Math.round((row[0] - year) * 100);
    if (month < 1 || month > 12) continue;
    first ||= row;
    if (row[1] > 0) prices.push([`${year}-${String(month).padStart(2, '0')}`, Math.round(row[1] * 100) / 100]); // an average of days: many decimals
  }
  if (!first || first[0] !== 1871.01 || first[1] !== 4.44 || first[3] !== 0.4 || prices.length < 120) throw new Error('the spreadsheet is not laid out as expected');
  return prices.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

let inflight = null;
/** [['1871-01', 4.44], …] (see pricesFromSpreadsheet), or null when it has never been read. */
async function sp500History(cacheDir) {
  const file = path.join(cacheDir, 'shiller-prices-v3.json'); // v3: prices only
  const kept = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < TTL) return kept();
  } catch { /* not cached yet */ }
  if (!inflight) inflight = (async () => {
    const res = await get(spreadsheetUrl(await (await get(SITE)).text()));
    if (+res.headers.get('content-length') > 20e6) throw new Error('the spreadsheet is implausibly large'); // it is under 2 MB
    const prices = pricesFromSpreadsheet(Buffer.from(await res.arrayBuffer()));
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(prices));
    return prices;
  })().catch(e => {
    console.error(new Date().toISOString(), 'shiller', e.message);
    return kept();
  }).finally(() => { inflight = null; });
  return inflight;
}

module.exports = { sp500History, pricesFromSpreadsheet, spreadsheetUrl };
