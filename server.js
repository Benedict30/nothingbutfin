#!/usr/bin/env node
/*
 * Nothing But Fin — server
 *
 * Serves the web UI and a small JSON API backed by SEC EDGAR (free, no key).
 * Zero dependencies; needs Node 18+.
 *
 *   SEC_USER_AGENT="YourOrg Data Team you@yourorg.com" node server.js
 *
 * Env:
 *   SEC_USER_AGENT   required by the SEC: org name + contact email
 *   PORT             default 3000
 *   HOST             default 127.0.0.1 (set 0.0.0.0 to expose on your network)
 *   CACHE_DIR        default ./cache
 *   FACTS_TTL_HOURS  how long a company's EDGAR data is cached (default 12)
 *
 * API:
 *   GET /api/search?q=apple            ticker / company search (top 10)
 *   GET /api/statements?ticker=AAPL    income, balance sheet, cash flow (quarterly + annual)
 *   GET /api/statements.csv?ticker=AAPL  same data, long format, for SQL / notebooks
 *   (/api/statements also returns `preliminary`: earnings-day figures from a press release whose
 *    10-Q is not out yet)
 *   GET /api/preliminary?ticker=AAPL     just the preliminary figures (to poll while they are read)
 *   GET /api/magazine?ticker=AAPL&freq=q&period=2026Q3  filing links + saved magazine story or its state
 *   POST /api/magazine?…                         start writing the story in the background (Claude)
 *   GET /api/magazine/status?ticker=AAPL&freq=q  story state per period: none | generating | ready | error
 *   (the magazine endpoints take &lang=en|zh-Hans|zh-Hant|ja|ko; each language is its own story)
 *   GET /logo/AAPL.png                   company logo, 404 when there is none (a .png path, so a CDN caches it)
 *   GET /api/follows?id=…                companies a personal calendar follows; POST &ticker=PLTR&on=1|0 changes it
 *                                        (&details=1: each one's next earnings, and when a calendar app last read the feed)
 *   GET /cal/<id>.ics                    that personal calendar: next earnings (estimated until announced), with alerts
 *   GET /api/health
 */
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { normalize } = require('./lib/edgar');
const magazine = require('./lib/magazine');
const preliminary = require('./lib/preliminary');
const reminders = require('./lib/reminders');
const log = require('./lib/log');
const estimates = require('./lib/estimates');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const UA = (process.env.SEC_USER_AGENT || '').trim();
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(__dirname, 'cache'));
const FOLLOWS = path.join(path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')), 'follows.json'); // personal earnings calendars
const CAL_ACTIVITY = path.join(path.dirname(FOLLOWS), 'calendar-activity.json'); // when each calendar was last used
const FACTS_TTL = (+process.env.FACTS_TTL_HOURS || 12) * 3600e3;
const TICKERS_TTL = 24 * 3600e3;
const SEC_DATA = process.env.SEC_DATA_BASE || 'https://data.sec.gov';
const SEC_WWW = process.env.SEC_WWW_BASE || 'https://www.sec.gov';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIN_GAP_MS = 125; // stay well under the SEC's 10 requests/second
// Opening a company's page uses EDGAR data at most a few minutes old (shared by all visitors), so
// a reload shows new filings soon after the SEC publishes them without fetching on every visit;
// background calls (story and preliminary status) reuse that copy.
const FRESH_TTL = (+process.env.FRESH_MINUTES || 5) * 60e3;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ------------------------------------------------------------ SEC access
let lastCall = 0;
let queue = Promise.resolve();
function secFetch(url) {
  if (!UA || !/@/.test(UA)) {
    throw new HttpError(500, 'SEC_USER_AGENT is not set. Restart the server with SEC_USER_AGENT="Your Org your.email@yourorg.com" — the SEC requires a contact in every request.');
  }
  const slot = queue.then(async () => {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
  });
  queue = slot.catch(() => {});
  return slot.then(() => fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } }));
}

const inflight = new Map();
// Fetch JSON from the SEC with an on-disk cache. Serves stale data if the SEC is unreachable.
async function cachedJson(url, file, ttl) {
  const full = path.join(CACHE_DIR, file);
  let stat = null;
  try { stat = await fsp.stat(full); } catch {}
  if (stat && Date.now() - stat.mtimeMs < ttl) return { data: JSON.parse(await fsp.readFile(full, 'utf8')), fetchedAt: stat.mtime };
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    let res;
    try {
      res = await secFetch(url);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (stat) return { data: JSON.parse(await fsp.readFile(full, 'utf8')), fetchedAt: stat.mtime, stale: true };
      throw new HttpError(502, 'Could not reach SEC EDGAR (' + (e.cause && e.cause.code || e.message) + '). If you are behind a corporate proxy, see README.');
    }
    if (res.status === 404) throw new HttpError(404, 'not_found');
    if (!res.ok) {
      if (stat) return { data: JSON.parse(await fsp.readFile(full, 'utf8')), fetchedAt: stat.mtime, stale: true };
      if (res.status === 403) throw new HttpError(502, 'SEC EDGAR refused the request (403). Check that SEC_USER_AGENT has your organisation and a real contact email.');
      if (res.status === 429) throw new HttpError(503, 'SEC EDGAR rate limit hit — try again in a minute.');
      throw new HttpError(502, 'SEC EDGAR returned HTTP ' + res.status);
    }
    const text = await res.text();
    const data = JSON.parse(text);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const tmp = full + '.' + process.pid + '.tmp';
    await fsp.writeFile(tmp, text);
    await fsp.rename(tmp, full);
    return { data, fetchedAt: new Date() };
  })();
  inflight.set(url, p);
  try { return await p; } finally { inflight.delete(url); }
}

// ------------------------------------------------------------ tickers
let tickerIndex = null; // { at, list: [{ticker, name, cik, exchange}], byTicker: Map }
async function tickers() {
  if (tickerIndex && Date.now() - tickerIndex.at < TICKERS_TTL) return tickerIndex;
  const { data } = await cachedJson(SEC_WWW + '/files/company_tickers_exchange.json', 'company_tickers_exchange.json', TICKERS_TTL);
  const F = data.fields || ['cik', 'name', 'ticker', 'exchange'];
  const ix = k => F.indexOf(k);
  const list = (data.data || []).map(r => ({
    cik: r[ix('cik')], name: r[ix('name')], ticker: String(r[ix('ticker')] || '').toUpperCase(), exchange: r[ix('exchange')] || '',
  })).filter(r => r.ticker);
  const byTicker = new Map();
  for (const r of list) if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, r);
  tickerIndex = { at: Date.now(), list, byTicker };
  return tickerIndex;
}

async function search(q) {
  q = String(q || '').trim();
  if (!q) return [];
  const { list } = await tickers();
  const Q = q.toUpperCase();
  const scored = [];
  for (const r of list) {
    const name = r.name.toUpperCase();
    let s = -1;
    if (r.ticker === Q) s = 0;
    else if (r.ticker.startsWith(Q)) s = 1;
    else if (name.startsWith(Q)) s = 2;
    else if (Q.length >= 2 && (' ' + name).includes(' ' + Q)) s = 3;
    else if (Q.length >= 3 && name.includes(Q)) s = 4;
    else if (/^\d+$/.test(Q) && String(r.cik) === String(+Q)) s = 0;
    if (s >= 0) scored.push([s, r]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].ticker.length - b[1].ticker.length || a[1].ticker.localeCompare(b[1].ticker));
  return scored.slice(0, 10).map(([, r]) => r);
}

// ------------------------------------------------------------ magazine
const FIGURES = ['revenue', 'grossProfit', 'opIncome', 'netIncome', 'epsDiluted', 'cfo', 'capex', 'fcf', 'cash', 'ltDebt'];

async function submissionsFor(r, fresh = false) {
  const cik10 = String(r.company.cik).padStart(10, '0');
  return (await cachedJson(SEC_DATA + '/submissions/CIK' + cik10 + '.json', 'submissions/CIK' + cik10 + '.json', fresh ? FRESH_TTL : FACTS_TTL)).data;
}

// documents never change once published, so they are cached for good
async function getText(url, name) {
  const file = path.join(CACHE_DIR, 'filings', name);
  try { return await fsp.readFile(file, 'utf8'); } catch {}
  const res = await secFetch(url);
  if (!res.ok) throw new HttpError(502, 'Could not download a filing from SEC EDGAR (HTTP ' + res.status + ')');
  const text = await res.text();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
  return text;
}

/** A followed company's estimated next earnings: { ticker, name, estimate }. */
async function upcomingOf(t) {
  const info = await companyOf(t);
  const cik10 = String(info.cik).padStart(10, '0');
  const { data: subs } = await cachedJson(SEC_DATA + '/submissions/CIK' + cik10 + '.json', 'submissions/CIK' + cik10 + '.json', FACTS_TTL);
  return { ticker: info.ticker || t, name: info.name || t, estimate: preliminary.estimateNextEarnings(subs) };
}
/** The estimate, replaced by the company's announced date when Eulerpool has it (see lib/estimates.js). */
async function withConfirmed(ticker, estimate) {
  const a = estimates.announced(await estimates.quarterEstimates(CACHE_DIR, ticker).catch(() => null), estimate);
  return a ? { date: a.date, basedOn: estimate.basedOn, timing: a.timing, source: 'https://eulerpool.com' } : estimate;
}

/** A personal calendar feed: each followed company's next earnings, estimated until the company announces the date. */
async function earningsFeed(id, origin) {
  const events = [];
  for (const t of reminders.follows(FOLLOWS, id)) {
    try {
      const { ticker, name, estimate } = await upcomingOf(t);
      const next = estimate && await withConfirmed(ticker, estimate);
      // the link carries the calendar id: opening an event's link reconnects a browser to this calendar
      if (next) events.push({ ticker, name, next, url: `${origin}/?ticker=${encodeURIComponent(ticker)}&calendar=${encodeURIComponent(id)}` });
    } catch { /* skip a company that can't be looked up right now */ }
  }
  return reminders.buildIcs(events, { feed: true });
}

/** When each period's results came out: { periodKey: { release?: date, filing?: { form, filed } } }. */
function reportDates(blk, subs, annual) {
  const out = {};
  for (const p of blk.periods) {
    if (p.key === 'TTM' || p.key === 'PROJ') continue;
    const filing = magazine.findFiling(subs, p.end, annual || p.q === 4);
    const release = magazine.findEarningsRelease(subs, p.end, filing ? filing.filed : new Date(Date.parse(p.end) + 100 * 86400e3).toISOString().slice(0, 10));
    if (filing || release) out[p.key] = { release: release ? release.filed : undefined, filing: filing ? { form: filing.form, filed: filing.filed } : undefined };
  }
  return out;
}

/** Earnings-day figures from a press release whose 10-Q is not in the data yet (or null). */
async function preliminaryOf(r, fresh = false) {
  const subs = await submissionsFor(r, fresh);
  return preliminary.preliminaryFor({ cacheDir: CACHE_DIR, quarterly: r.quarterly, submissions: subs, company: r.company, getText, exhibitUrl: magazine.exhibitUrl, htmlToText: magazine.htmlToText });
}
const filingFor = (subs, freq, p) => magazine.findFiling(subs, p.end, freq === 'a' || p.q === 4);

/** Story state of every period: 'ready' | 'generating' | 'error' | 'none' (no filing: omitted). */
async function magazineStatus(ticker, freq, lang) {
  const r = await statements(ticker);
  const blk = freq === 'a' ? r.annual : r.quarterly;
  const subs = await submissionsFor(r);
  const states = {};
  const pending = freq === 'q' && preliminary.pendingRelease(blk, subs);
  if (pending) {
    const job = magazine.jobState(pending.release.accn, lang);
    states[pending.key] = magazine.hasStory(CACHE_DIR, pending.release.accn, lang) ? 'ready' : job ? job.state : 'none';
  }
  for (const p of blk.periods) {
    const filing = p.key !== 'TTM' && p.key !== 'PROJ' && filingFor(subs, freq, p);
    if (!filing) continue;
    const job = magazine.jobState(filing.accn, lang);
    states[p.key] = magazine.hasStory(CACHE_DIR, filing.accn, lang) ? 'ready' : job ? job.state : 'none';
  }
  return { states, hasKey: !!magazine.apiKey() };
}

/** The story for a quarter whose 10-Q is not out yet: written from the earnings press release. */
async function pressReleaseStory(r, pre, start, lang) {
  const subs = await submissionsFor(r);
  const pending = preliminary.pendingRelease(r.quarterly, subs);
  const url = magazine.exhibitUrl(await getText(pending.release.indexUrl, pending.release.accn + '-index.htm'));
  const filing = { accn: pending.release.accn, form: '8-K', filed: pending.release.filed, url };
  const release = { filed: filing.filed, url };
  const getSources = async () => [{ label: `earnings press release (8-K, filed ${filing.filed})`, text: magazine.htmlToText(await getText(url, filing.accn + '-ex99.htm')) }];
  const figures = {};
  for (const [k, v] of Object.entries(pre.values || {})) figures[k] = { value: v.value, preliminary: true };
  const saved = await magazine.readArticle(CACHE_DIR, filing.accn, lang);
  const job = magazine.jobState(filing.accn, lang);
  const ai = saved
    || (start ? magazine.startArticle({ cacheDir: CACHE_DIR, filing, getSources, company: r.company, period: pre.period, figures, lang })
      : job ? { status: job.state, message: job.message }
      : { status: magazine.apiKey() ? 'none' : 'no-key' });
  return { period: pre.period, filing: null, release, ai };
}

/** GET: the saved story or its state (never starts one). POST (start = true): starts writing it. */
async function magazineFor(ticker, freq, key, start, lang) {
  const r = await statements(ticker);
  const blk = freq === 'a' ? r.annual : r.quarterly;
  const i = blk.periods.findIndex(p => p.key === key);
  if (i < 0 && freq === 'q') {
    const pre = await preliminaryOf(r);
    if (pre && pre.period.key === key) return pressReleaseStory(r, pre, start, lang);
  }
  if (i < 0 || key === 'TTM' || key === 'PROJ') throw new HttpError(404, 'No single filing covers period ' + key);
  const p = blk.periods[i];
  const subs = await submissionsFor(r);
  const filing = filingFor(subs, freq, p);
  if (!filing) return { period: p, filing: null, ai: { status: 'error', message: 'No 10-Q or 10-K found for this period in the SEC filing index.' } };

  // verified figures for the prompt: value, previous period and year-ago period
  const ix = new Map(blk.periods.map((x, j) => [x.key, j]));
  const prevKey = freq === 'a' ? 'FY' + (p.fy - 1) : p.q > 1 ? p.fy + 'Q' + (p.q - 1) : (p.fy - 1) + 'Q4';
  const yoyKey = freq === 'a' ? prevKey : (p.fy - 1) + 'Q' + p.q;
  const rows = new Map(Object.values(blk.statements).flatMap(st => st.rows.map(row => [row.key, row])));
  const figures = {};
  for (const k of FIGURES) {
    const row = rows.get(k);
    if (!row || row.vals[i] == null) continue;
    const at = key2 => (ix.has(key2) ? row.vals[ix.get(key2)] : null);
    figures[row.name] = { value: row.vals[i], previousPeriod: freq === 'a' ? undefined : at(prevKey), yearAgo: at(yoyKey) };
  }

  const release = magazine.findEarningsRelease(subs, p.end, filing.filed);
  if (release) release.url = magazine.exhibitUrl(await getText(release.indexUrl, release.accn + '-index.htm'));
  const getSources = async () => {
    const sources = [];
    if (release && release.url) {
      const text = magazine.htmlToText(await getText(release.url, release.accn + '-ex99.htm'));
      sources.push({ label: `earnings press release (8-K, filed ${release.filed})`, text });
    }
    const mdna = magazine.extractMdna(magazine.htmlToText(await getText(filing.url, filing.accn + '.htm')));
    sources.push({ label: `${filing.form} filed ${filing.filed}: ${mdna.section === 'MD&A' ? "Management's Discussion & Analysis" : 'full document'}`, text: mdna.text });
    return sources;
  };
  const saved = await magazine.readArticle(CACHE_DIR, filing.accn, lang);
  const job = magazine.jobState(filing.accn, lang);
  const ai = saved
    || (start ? magazine.startArticle({ cacheDir: CACHE_DIR, filing, getSources, company: r.company, period: p, figures, lang })
      : job ? { status: job.state, message: job.message }
      : { status: magazine.apiKey() ? 'none' : 'no-key' });
  return { period: p, filing, release: release && release.url ? { filed: release.filed, url: release.url } : null, ai };
}

// ------------------------------------------------------------ company logos
// Fetched once from public logo services and kept on disk; a ticker without one is remembered
// for a week (an empty file) so it isn't looked up on every page.
// FMP has plain brand marks (clean at small sizes); parqet's are often wordmarks, so it is the fallback
const LOGO_SOURCES = [t => `https://financialmodelingprep.com/image-stock/${t}.png`, t => `https://assets.parqet.com/logos/symbol/${t}?format=png&size=200`];
async function logoOf(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(t)) return null;
  const file = path.join(CACHE_DIR, 'logos', t + '.png');
  try {
    const st = await fsp.stat(file);
    if (st.size) return fsp.readFile(file);
    if (Date.now() - st.mtimeMs < 7 * 86400e3) return null;
  } catch {}
  let png = null;
  for (const src of LOGO_SOURCES) {
    try {
      const res = await fetch(src(t), { signal: AbortSignal.timeout(5000) });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.ok && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) { png = buf; break; } // a real PNG
    } catch {}
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, png || '');
  return png;
}

// ------------------------------------------------------------ statements
const memo = new Map(); // cik -> { fetchedAt, result }
/** Ticker (or CIK) → { cik, ticker, name, exchange }. */
async function companyOf(tickerOrCik) {
  const key = String(tickerOrCik || '').trim().toUpperCase();
  if (!key) throw new HttpError(400, 'Missing ?ticker=');
  const { byTicker, list } = await tickers();
  let info = byTicker.get(key) || byTicker.get(key.replace(/\./g, '-'));
  if (!info && /^\d{1,10}$/.test(key)) info = list.find(r => String(r.cik) === String(+key)) || { cik: +key, ticker: '', name: '', exchange: '' };
  if (!info) throw new HttpError(404, 'Unknown ticker "' + key + '". Only companies registered with the SEC are covered.');
  return info;
}

async function statements(tickerOrCik, fresh = false) {
  const info = await companyOf(tickerOrCik);
  const { list } = await tickers();
  const cik10 = String(info.cik).padStart(10, '0');
  // the page also needs the filing list: fetch it alongside the financial data, not after it
  if (fresh) cachedJson(SEC_DATA + '/submissions/CIK' + cik10 + '.json', 'submissions/CIK' + cik10 + '.json', FRESH_TTL).catch(() => {});
  const { data, fetchedAt, stale } = await cachedJson(SEC_DATA + '/api/xbrl/companyfacts/CIK' + cik10 + '.json', 'companyfacts/CIK' + cik10 + '.json', fresh ? FRESH_TTL : FACTS_TTL)
    .catch(e => {
      if (e.status === 404) throw new HttpError(404, (info.ticker || 'CIK ' + cik10) + ' has no XBRL financial data on EDGAR (funds, ETFs and some foreign issuers do not file it).');
      throw e;
    });

  const m = memo.get(cik10);
  if (m && +m.fetchedAt === +fetchedAt) return m.result;
  const result = normalize(data);
  result.company.ticker = info.ticker;
  result.company.exchange = info.exchange;
  result.company.name = result.company.name || info.name;
  result.company.otherTickers = list.filter(r => r.cik === info.cik && r.ticker !== info.ticker).map(r => r.ticker);
  result.source = {
    name: 'SEC EDGAR',
    companyfacts: SEC_DATA + '/api/xbrl/companyfacts/CIK' + cik10 + '.json',
    filings: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=' + cik10 + '&type=10-&dateb=&owner=include&count=40',
    fetchedAt,
    stale: !!stale,
  };
  memo.set(cik10, { fetchedAt, result });
  if (memo.size > 40) memo.delete(memo.keys().next().value);
  return result;
}

function toCsv(r) {
  const esc = v => (v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  const lines = [['ticker', 'cik', 'statement', 'line_item_key', 'line_item', 'unit', 'frequency', 'period', 'fiscal_year', 'fiscal_quarter', 'period_end', 'value', 'source'].join(',')];
  for (const [freq, blk] of [['quarterly', r.quarterly], ['annual', r.annual]]) {
    for (const [stKey, st] of Object.entries(blk.statements)) {
      for (const row of st.rows) {
        blk.periods.forEach((p, i) => {
          if (row.vals[i] == null || p.key === 'PROJ') return; // reported figures only
          const unit = r.units[row.unit];
          lines.push([r.company.ticker, r.company.cik, stKey, row.key, row.name, unit, freq, p.label, p.fy, p.q || '', p.end, row.vals[i], row.src ? row.src[i] : ''].map(esc).join(','));
        });
      }
    }
  }
  return lines.join('\n') + '\n';
}

// ------------------------------------------------------------ HTTP
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };

function send(req, res, status, body, type, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...extra };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(status, headers);
    return res.end(zlib.gzipSync(buf));
  }
  res.writeHead(status, headers);
  res.end(buf);
}
const json = (req, res, status, obj) => send(req, res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(req, res, 403, 'Forbidden', 'text/plain');
  try {
    const body = await fsp.readFile(full);
    // Vite's /assets/ files have content hashes in their names, so they never change
    const cache = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    send(req, res, 200, body, TYPES[path.extname(full)] || 'application/octet-stream', { 'Cache-Control': cache });
  } catch {
    send(req, res, 404, 'Not found', 'text/plain');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const post = req.method === 'POST' && ['/api/magazine', '/api/follows'].includes(url.pathname); // the only writes
    if (req.method !== 'GET' && req.method !== 'HEAD' && !post) return send(req, res, 405, 'Method not allowed', 'text/plain');
    if (url.pathname.startsWith('/api/')) req.visitor = log.visitorId(req, res); // for the visitor log
    switch (url.pathname) {
      case '/api/follows': {
        const id = url.searchParams.get('id');
        const tickers = post ? reminders.setFollow(FOLLOWS, id, url.searchParams.get('ticker'), url.searchParams.get('on') === '1') : reminders.follows(FOLLOWS, id);
        if (post) reminders.touch(CAL_ACTIVITY, id);
        if (post) log.event('follow', req, { ticker: String(url.searchParams.get('ticker')).toUpperCase(), on: url.searchParams.get('on') === '1', cal: log.calKey(id) });
        if (url.searchParams.get('details') !== '1') return json(req, res, 200, { tickers });
        // for the "My calendar" panel: each company's next earnings, and whether a calendar app reads the feed
        const items = await Promise.all(tickers.map(async t => {
          try {
            const { ticker, name, estimate } = await upcomingOf(t);
            return { ticker, name, next: estimate ? await withConfirmed(ticker, estimate) : null };
          } catch { return { ticker: t, name: t, next: null }; }
        }));
        return json(req, res, 200, { tickers, items, calendar: { fetched: reminders.lastFetched(CAL_ACTIVITY, id) } });
      }
      case '/api/health':
        return json(req, res, 200, { ok: true, userAgentConfigured: !!UA && /@/.test(UA) });
      case '/api/search':
        return json(req, res, 200, { results: await search(url.searchParams.get('q')) });
      case '/api/statements': { // the page load: fresh from EDGAR
        const r = await statements(url.searchParams.get('ticker') || url.searchParams.get('cik'), true);
        log.event('view', req, { ticker: r.company.ticker || String(r.company.cik) });
        const pre = await preliminaryOf(r, true).catch(() => null); // also refreshes the filing list
        const subs = await submissionsFor(r).catch(() => null);
        const estimate = subs && preliminary.estimateNextEarnings(subs);
        const nextEarnings = estimate && await withConfirmed(r.company.ticker, estimate);
        const reported = subs && { quarterly: reportDates(r.quarterly, subs, false), annual: reportDates(r.annual, subs, true) };
        // analysts' revenue estimates per quarter (Eulerpool), in the statement's units; USD reporters only
        const usd = r.currency === 'USD';
        const [qEst, aEst] = usd ? await Promise.all([estimates.quarterEstimates(CACHE_DIR, r.company.ticker), estimates.annualEstimates(CACHE_DIR, r.company.ticker)].map(p => p.catch(() => null))) : [null, null];
        const est = qEst || aEst ? { ...(estimates.forPeriods(qEst, r.quarterly.periods) || { byPeriod: {}, next: null }), annual: estimates.forYears(aEst, r.annual.periods) } : null;
        return json(req, res, 200, { ...r, preliminary: pre, nextEarnings, reported, estimates: est });
      }
      case '/api/preliminary': {
        const r = await statements(url.searchParams.get('ticker'));
        return json(req, res, 200, { preliminary: await preliminaryOf(r) });
      }
      case '/api/magazine': {
        const q = url.searchParams, lang = magazine.langOf(q.get('lang'));
        const m = await magazineFor(q.get('ticker'), q.get('freq'), q.get('period'), post, lang);
        const story = { ticker: String(q.get('ticker')).toUpperCase(), freq: q.get('freq'), period: q.get('period'), label: m.period && m.period.label, lang };
        if (post && m.ai.status === 'generating') log.event('story_generate', req, story);
        if (!post && q.get('open') === '1' && m.ai.status === 'ok') log.event('story_open', req, story); // someone opened it to read
        return json(req, res, 200, m);
      }
      case '/api/magazine/status':
        return json(req, res, 200, await magazineStatus(url.searchParams.get('ticker'), url.searchParams.get('freq'), magazine.langOf(url.searchParams.get('lang'))));
      case '/api/statements.csv': {
        const r = await statements(url.searchParams.get('ticker') || url.searchParams.get('cik'));
        const name = (r.company.ticker || 'CIK' + r.company.cik) + '_financial_statements.csv';
        return send(req, res, 200, toCsv(r), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="' + name + '"' });
      }
      default: {
        const logo = /^\/logo\/([^/]+)\.png$/.exec(url.pathname);
        if (logo) {
          const png = await logoOf(decodeURIComponent(logo[1]));
          if (!png) return send(req, res, 404, 'No logo', 'text/plain', { 'Cache-Control': 'public, max-age=86400' });
          return send(req, res, 200, png, 'image/png', { 'Cache-Control': 'public, max-age=604800' });
        }
        const cal = /^\/cal\/([A-Za-z0-9_-]{16,64})\.ics$/.exec(url.pathname);
        if (cal) {
          // which calendar apps fetch the feeds, and when (the id is shortened; it is private)
          console.log(new Date().toISOString(), 'calendar fetch', cal[1].slice(0, 6) + '…', req.headers['user-agent'] || '');
          log.feedFetch(cal[1], req.headers['user-agent']);
          reminders.touch(CAL_ACTIVITY, cal[1], Date.now(), true);
          const proto = req.headers['x-forwarded-proto'] || 'http';
          return send(req, res, 200, await earningsFeed(cal[1], proto + '://' + (req.headers.host || 'localhost:' + PORT)), 'text/calendar; charset=utf-8', { 'Cache-Control': 'no-cache' });
        }
        if (url.pathname.startsWith('/api/')) return json(req, res, 404, { error: 'Unknown endpoint' });
        return serveStatic(req, res, url.pathname);
      }
    }
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(new Date().toISOString(), req.url, e.stack || e.message);
    json(req, res, status, { error: e.message || 'Server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('Nothing But Fin → http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
    if (!UA || !/@/.test(UA)) console.warn('⚠  SEC_USER_AGENT is not set (needs an org name and contact email). EDGAR requests will fail until it is.');
  });
  // shortly after start, then every 6 hours: clear abandoned calendars
  const housekeeping = () => {
    try {
      const removed = reminders.pruneInactive(FOLLOWS, CAL_ACTIVITY);
      if (removed.length) console.log(new Date().toISOString(), `removed ${removed.length} calendar(s) unused for ${reminders.INACTIVE_DAYS} days:`, removed.map(l => l.join(',')).join(' | '));
    } catch (e) { console.error(new Date().toISOString(), 'calendar clean-up', e.message); }
  };
  setTimeout(housekeeping, 60e3);
  setInterval(housekeeping, 6 * 3600e3);
}
module.exports = { server, statements, search, toCsv };
