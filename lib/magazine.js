/*
 * magazine.js — a readable, magazine-style write-up of one period's 10-Q / 10-K.
 *
 *  1. find the filing for the period (SEC submissions API: report date + form)
 *  2. gather what the statements don't show: the results-day press release (8-K, EX-99.1)
 *     with management's own words and operating metrics, plus the filing's MD&A
 *  3. ask Claude for a structured feature story about those details
 *  4. keep only quotes and evidence that appear word for word in the sources
 *
 * The API key comes from ANTHROPIC_API_KEY or a local .anthropic-api-key file (gitignored),
 * read on each request so it can be added without restarting the server.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const log = require('./log');

const MODEL = 'claude-opus-5-5';
// USD per million tokens (Anthropic API list prices), for showing what a story cost to write
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 }, // possible refusal fallback
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};
function costOf(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  const usd = ((usage.input_tokens || 0) * p.input + (usage.cache_creation_input_tokens || 0) * p.input * 1.25
    + (usage.cache_read_input_tokens || 0) * p.cacheRead + (usage.output_tokens || 0) * p.output) / 1e6;
  return Math.round(usd * 10000) / 10000;
}
const KEY_FILE = path.join(__dirname, '..', '.anthropic-api-key');

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim() || null; } catch { return null; }
}

// ------------------------------------------------------------ filing lookup
const QUARTER_FORMS = ['10-Q'];
const ANNUAL_FORMS = ['10-K', '20-F', '40-F'];

/** The original (non-amended) filing that reports the period ending on `end`. */
function findFiling(submissions, end, annual) {
  const r = submissions.filings && submissions.filings.recent;
  if (!r) return null;
  const forms = annual ? ANNUAL_FORMS : QUARTER_FORMS;
  let best = null;
  for (let i = 0; i < r.accessionNumber.length; i++) {
    if (r.reportDate[i] !== end || !forms.includes(r.form[i])) continue;
    if (!best || r.filingDate[i] < best.filed) {
      best = { accn: r.accessionNumber[i], form: r.form[i], filed: r.filingDate[i], doc: r.primaryDocument[i] };
    }
  }
  if (!best) return null;
  const folder = `https://www.sec.gov/Archives/edgar/data/${+submissions.cik}/${best.accn.replace(/-/g, '')}`;
  return { ...best, url: `${folder}/${best.doc}`, indexUrl: `${folder}/${best.accn}-index.htm` };
}

// ------------------------------------------------------------ document text
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…', bull: '•' };

/** Plain text of an (inline XBRL) HTML filing, keeping paragraph breaks. */
function htmlToText(html) {
  return html
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, '') // hidden XBRL facts
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<div[^>]*display:\s*none[\s\S]*?<\/div>/gi, '')
    .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li|\/table)[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' \t ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Management's Discussion & Analysis: the longest stretch from an "MD&A" heading (at the
 * start of a line, so not a mention inside a sentence) to the next market-risk /
 * financial-statements heading. Table-of-contents entries give short stretches and lose.
 * Falls back to the whole document when no section is found.
 */
function extractMdna(text) {
  const start = /(?:^|\n)[ \t]*(?:item[ \t]+[27]\.?[ \t]*)?(management[’'`s]{0,2}\s+discussion\s+and\s+analysis)/gi;
  const stop = /quantitative\s+and\s+qualitative\s+disclosures?\s+about\s+market\s+risk|financial\s+statements\s+and\s+supplementary\s+data|controls\s+and\s+procedures/gi;
  let best = null;
  for (let m; (m = start.exec(text)); ) {
    const from = m.index + m[0].length - m[1].length; // the heading text itself
    stop.lastIndex = m.index + m[0].length;
    const s = stop.exec(text);
    if (!s) continue; // a heading with no section end after it is not the section
    if (!best || s.index - from > best.length) best = { from, length: s.index - from };
  }
  if (best && best.length > 4000) return { section: 'MD&A', text: text.slice(best.from, best.from + best.length) };
  return { section: 'full document', text };
}

// ------------------------------------------------------------ earnings release
/** The results-day 8-K (Item 2.02) filed between the period end and shortly after the 10-Q / 10-K. */
function findEarningsRelease(submissions, end, reportFiled) {
  const r = submissions.filings && submissions.filings.recent;
  if (!r) return null;
  const latest = new Date(Date.parse(reportFiled) + 7 * 86400e3).toISOString().slice(0, 10);
  let best = null;
  for (let i = 0; i < r.accessionNumber.length; i++) {
    if (r.form[i] !== '8-K' || !String(r.items[i] || '').split(',').includes('2.02')) continue;
    if (r.filingDate[i] <= end || r.filingDate[i] > latest) continue;
    if (!best || r.filingDate[i] < best.filed) best = { accn: r.accessionNumber[i], filed: r.filingDate[i] };
  }
  if (!best) return null;
  const folder = `https://www.sec.gov/Archives/edgar/data/${+submissions.cik}/${best.accn.replace(/-/g, '')}`;
  return { ...best, indexUrl: `${folder}/${best.accn}-index.htm` };
}

/** URL of the EX-99.1 exhibit (the press release) listed on an EDGAR filing index page. */
function exhibitUrl(indexHtml) {
  for (const row of indexHtml.split(/<tr/i)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (cells.length < 4 || !/^EX-99(\.1|\.01)?$/i.test(cells[3].replace(/<[^>]+>/g, '').trim())) continue;
    const href = /href="([^"]+)"/i.exec(cells[2]);
    if (href) return new URL(href[1].replace(/^\/ix\?doc=/, ''), 'https://www.sec.gov').href;
  }
  return null;
}

// ------------------------------------------------------------ verbatim check
const norm = s => s.toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”]/g, '"').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
/** Keeps items whose `field` occurs word for word in the source text (ignoring quote style and spacing). */
function verifyQuotes(items, source, field = 'text') {
  const hay = norm(source);
  return items.filter(q => q[field] && hay.includes(norm(q[field]).replace(/^["']+|["']+$/g, '')));
}

// ------------------------------------------------------------ the article
const obj = (props, req = Object.keys(props)) => ({ type: 'object', additionalProperties: false, required: req, properties: props });
const str = description => (description ? { type: 'string', description } : { type: 'string' });
const SCHEMA = obj({
  headline: str('Punchy magazine headline about the most interesting development, max ~12 words'),
  dek: str('One-sentence standfirst under the headline'),
  mood: { type: 'string', enum: ['strong', 'steady', 'mixed', 'tough'] },
  lede: str('Opening paragraph, 2–4 sentences, sets the scene and the main story'),
  voices: {
    type: 'array', description: '2–4 things executives said, copied word for word, attributed to the named speaker',
    items: obj({ speaker: str('Full name as given in the source'), role: str('e.g. "CEO"'), quote: str('Exact words in the source language, 1–3 sentences'), translation: str('The quote translated into the story language; empty string when the story is in English'), context: str('What it is about, 3–6 words') }),
  },
  beyond: {
    type: 'array', description: '3–6 operating details the financial statements do not show: customers, retention, backlog, users, segments, products, deals, headcount',
    items: obj({ label: str('e.g. "Net revenue retention"'), value: str('Short, e.g. "126%" or "828"'), detail: str('One sentence on why it matters'), evidence: str('The exact source sentence or phrase that states it, word for word') }),
  },
  takeaways: { type: 'array', items: str(), description: '3 one-line key takeaways' },
  sections: {
    type: 'array', description: '2–3 short story sections explaining what drove the period',
    items: obj({ kicker: str('One or two word label'), heading: str(), body: str('1–3 short paragraphs separated by blank lines') }),
  },
  outlook: obj({
    summary: str('What management expects next, or that no guidance was given'),
    items: { type: 'array', items: obj({ label: str(), value: str(), evidence: str('Exact source text, word for word') }) },
  }),
  watchlist: { type: 'array', description: '2–4 risks or open questions', items: obj({ title: str(), detail: str() }) },
});

const SYSTEM = `You write the feature story for a financial magazine aimed at curious, informed readers who are not accountants. Each story covers one company's reporting period.

Readers see this story next to a table that already shows the income statement, balance sheet and cash flow numbers. Don't recap those. Your job is what the table can't show:
- what management said, in their own words, and how they explain the results
- operating details outside the financial statements: customers, retention, backlog, users, units, segments, geographies, products and launches, deals, acquisitions, headcount, one-off items
- guidance and what management expects next
- risks, open questions and anything surprising

Write with energy and clarity: a hook in the headline, concrete explanations, plain English for jargon. Stay accurate and even-handed: no hype, no investment advice, no share-price predictions.

Facts come only from the sources you are given. Quotes and evidence must be copied exactly, word for word, from a source, because they are checked automatically and anything that doesn't match is removed. Never estimate or invent a number; if the sources don't explain something, say less rather than guess.`;

// languages a story can be written in (the site's languages)
const LANGS = { en: 'English', 'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese (Taiwan usage)', ja: 'Japanese', ko: 'Korean' };
const langOf = l => (LANGS[l] ? l : 'en');
// one story per filing and language; English keeps its original file name
const storyFile = (cacheDir, accn, lang = 'en') => path.join(cacheDir, 'magazine', `${accn}-${MODEL}-v2${lang === 'en' ? '' : '-' + lang}.json`);
const hasStory = (cacheDir, accn, lang) => fs.existsSync(storyFile(cacheDir, accn, lang));

/** The saved story for a filing, or null. */
async function readArticle(cacheDir, accn, lang) {
  try {
    const saved = JSON.parse(await fs.promises.readFile(storyFile(cacheDir, accn, lang), 'utf8'));
    return { status: 'ok', cached: true, cost: costOf(saved.model, saved.usage), ...saved };
  } catch { return null; }
}

// Background generations by accession number. A finished story lives on disk; a failed one
// stays here as { state: 'error' } until it is retried. Closing the page does not stop a job.
const jobs = new Map();
const jobState = (accn, lang = 'en') => jobs.get(accn + '|' + lang) || null;

/** Starts writing the story in the background (once per filing and language); returns { status }. */
function startArticle(args) {
  const id = args.filing.accn + '|' + (args.lang || 'en');
  if (jobs.get(id)?.state === 'generating') return { status: 'generating' };
  const key = apiKey();
  if (!key) return { status: 'no-key' };
  jobs.set(id, { state: 'generating', startedAt: Date.now() });
  generate({ ...args, key }).then(
    r => (r.status === 'ok' ? jobs.delete(id) : jobs.set(id, { state: 'error', message: r.message })),
    e => jobs.set(id, { state: 'error', message: e.message || 'The story could not be written.' }),
  );
  return { status: 'generating' };
}

/**
 * Writes and saves the story for one filing.
 * getSources() returns [{ label, text }] (earnings release, MD&A).
 * Returns { status: 'ok', ... } | { status: 'error', message }.
 */
/**
 * One structured request to Claude (streamed, with server-side refusal fallback).
 * Returns { status: 'ok', json, msg } | { status: 'error', message }.
 */
async function askClaude({ key, system, user, schema, what, about }) {
  const client = new Anthropic({ apiKey: key });
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // a declined request is re-run on Anthropic's recommended fallback model
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: user }],
    });
    const msg = await stream.finalMessage();
    log.usage(what, msg, costOf(msg.model, msg.usage), about); // every call, including declined and cut-off ones
    if (msg.stop_reason === 'refusal') return { status: 'error', message: `Claude declined to write ${what}.` };
    if (msg.stop_reason === 'max_tokens') return { status: 'error', message: `The ${what} was cut off; try again.` };
    return { status: 'ok', json: JSON.parse(msg.content.filter(b => b.type === 'text').map(b => b.text).join('')), msg };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { status: 'error', message: 'The Anthropic API key was rejected.' };
    if (e instanceof Anthropic.RateLimitError) return { status: 'error', message: 'Anthropic rate limit hit — try again in a minute.' };
    if (e instanceof Anthropic.APIError) return { status: 'error', message: `Anthropic API error ${e.status ?? ''}: ${e.message}` };
    if (e instanceof SyntaxError) return { status: 'error', message: `Claude returned an unreadable ${what}; try again.` };
    throw e;
  }
}

async function generate({ cacheDir, filing, getSources, company, period, figures, key, lang = 'en' }) {
  const file = storyFile(cacheDir, filing.accn, lang);
  const sources = await getSources();
  const all = sources.map(s => s.text).join('\n\n');
  const user = `Company: ${company.name} (${company.ticker || 'CIK ' + company.cik})
Period: ${period.label} (${period.months} months ending ${period.end}), reported in the ${filing.form} filed ${filing.filed}${period.q === 4 ? '\nThere is no separate Q4 report: the sources cover the full fiscal year, and Q4 = full year minus the first nine months.' : ''}${period.preliminary ? '\nThe formal 10-Q / 10-K is not out yet: write from the earnings press release.' : ''}

For reference only, the statement figures the reader already sees (USD millions unless noted):
${JSON.stringify(figures)}

${sources.map(s => `<source name="${s.label}">\n${s.text}\n</source>`).join('\n\n')}

Write the magazine story for this period${lang === 'en' ? '.' : ` in ${LANGS[lang]}. Everything you write is in ${LANGS[lang]}, except quotes and evidence: copy those word for word in the source's language (English), and give each quote's ${LANGS[lang]} translation in "translation". Keep company and product names, tickers and units as they are commonly written for ${LANGS[lang]} readers.`}`;
  const r = await askClaude({ key, system: SYSTEM, user, schema: SCHEMA, what: 'story', about: `${company.ticker || company.cik} ${period.label} ${lang}` });
  if (r.status !== 'ok') return r;
  const { json: article, msg } = r;
  // drop anything presented as the company's own words that isn't in the sources
  const counts = [article.voices.length, article.beyond.length, article.outlook.items.length];
  article.voices = verifyQuotes(article.voices, all, 'quote');
  article.beyond = verifyQuotes(article.beyond, all, 'evidence');
  article.outlook.items = verifyQuotes(article.outlook.items, all, 'evidence');
  const dropped = counts[0] - article.voices.length + counts[1] - article.beyond.length + counts[2] - article.outlook.items.length;
  const result = { article, sources: sources.map(s => s.label), model: msg.model, dropped, usage: msg.usage, createdAt: new Date().toISOString() };
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(result));
  return { status: 'ok', cached: false, cost: costOf(result.model, result.usage), ...result };
}

module.exports = { LANGS, langOf, findFiling, findEarningsRelease, exhibitUrl, htmlToText, extractMdna, verifyQuotes, readArticle, startArticle, jobState, hasStory, apiKey, askClaude, costOf, MODEL };
