/*
 * news.js — "Latest from the company": the company's own announcements, from its SEC filings.
 * Each 8-K is labelled by what it reports (Item 2.02 → earnings results, 5.02 → leadership change, …)
 * and, when it carries a press release (EX-99.1), titled with that release's headline; 10-Qs, 10-Ks
 * and proxy statements are listed as reports. Official and free; filings are cached for good.
 */
'use strict';

// what an 8-K item means, most newsworthy first (an 8-K often lists several)
const ITEMS = [
  ['2.02', 'Earnings'],
  ['5.02', 'Leadership change'],
  ['2.01', 'Acquisition or sale'],
  ['1.01', 'Major agreement'],
  ['1.02', 'Agreement ended'],
  ['2.05', 'Restructuring'],
  ['2.03', 'New debt'],
  ['3.02', 'Share sale'],
  ['5.07', 'Shareholder vote'],
  ['5.03', 'Bylaws changed'],
  ['7.01', 'Announcement'],
  ['8.01', 'Announcement'],
];
const REPORTS = { '10-Q': 'Quarterly report', '10-K': 'Annual report', '20-F': 'Annual report', '40-F': 'Annual report', 'DEF 14A': 'Annual meeting' };

/** The filings worth showing, newest first: [{ accn, filed, form, label, items, period, url }] (period: a report's period end). */
function companyFilings(submissions, limit = 8) {
  const r = submissions.filings && submissions.filings.recent;
  if (!r) return [];
  const folder = accn => `https://www.sec.gov/Archives/edgar/data/${+submissions.cik}/${accn.replace(/-/g, '')}`;
  const out = [];
  for (let i = 0; i < r.accessionNumber.length && out.length < limit; i++) {
    const form = r.form[i], accn = r.accessionNumber[i];
    let label = REPORTS[form];
    let items = [];
    if (form === '8-K') {
      items = String(r.items[i] || '').split(',').map(s => s.trim());
      const hit = ITEMS.find(([code]) => items.includes(code));
      if (!hit) continue; // only exhibits or routine items
      label = hit[1];
    }
    if (!label) continue; // insider trades, ownership forms, registrations…
    out.push({ accn, filed: r.filingDate[i], form, label, items, period: REPORTS[form] && form !== 'DEF 14A' ? r.reportDate[i] || null : null, url: `${folder(accn)}/${r.primaryDocument[i]}`, index: `${folder(accn)}/${accn}-index.htm` });
  }
  return out;
}

// lines at the top of a press release that aren't its headline
const SKIP = /^(ex-?99|exhibit|news release|press release|for (immediate )?release|media|investors?\b|contacts?\b|page \d|\d+$|.*\.htm$|for more information|source:|\(?(nasdaq|nyse)\b|forward-looking|(president|chief|chairman|senior vice|executive vice|ceo|cfo)\b|.*@.*|.*\+?\d[\d\s().-]{7,}\d.*)/i;
const NOT_TITLE = /^\d+\s|^see\b|^\(?in (millions|thousands|billions)\b|\bQ[1-4]'\d\d\b.*\bQ[1-4]'\d\d\b|\b(are|is) (below|attached)\b|non-gaap|^(dear|to our) /i; // footnotes, letter openings, pointers
const MONTH = /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},\s+\d{4}$/i;
const WIRE = /^.{2,60}?[—–-]+\s*\(?(business wire|globe newswire|pr newswire|accesswire)\)?\s*[—–-]+\s*/i;
const smallCaps = s => (s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s(-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : s);

/** The headline of a press release (its text), or null. */
function headline(text) {
  const lines = text.split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30);
  for (let l of lines) {
    if (/^[•·◦▪*-]/.test(l) || MONTH.test(l)) continue;
    const wire = WIRE.exec(l);
    if (wire) l = l.slice(wire[0].length); // "MIAMI — (BUSINESS WIRE) — Palantir … today announced …"
    if (l.length < 20 || l.length > 180 || l.split(' ').length < 4 || SKIP.test(l) || NOT_TITLE.test(l)) continue;
    if ((l.match(/[\d$%]/g) || []).length > l.length * 0.25) continue; // a row of figures
    if (l.split(' ').filter(w => w.length === 1).length > l.split(' ').length / 2) continue; // "P H O T O S & C H A R T S"
    // "Palantir Technologies Inc. (NASDAQ:PLTR) today announced …" → "Palantir Technologies Inc. announced …"
    return smallCaps(l.replace(/\s*\((nasdaq|nyse)[^)]*\)/i, '').replace(/\btoday (announced|reported)\b/i, '$1').replace(/\s*[.;:]$/, ''));
  }
  return null;
}

/**
 * What an 8-K says, when it has no press release: the first sentence of its first item, without the
 * date and the defined-term asides ("On June 28, 2026, Ajay K. Puri, … notified the Company …").
 */
const ABBREV = /\b(inc|corp|co|ltd|llc|plc|mr|ms|mrs|dr|no|u\.s|n\.a|st|jr|sr|[a-z])$/i;
function firstSentence(text) {
  const t = text.replace(/\s+/g, ' ');
  const item = /Item\s+[1-8]\.\d\d\.?\s/.exec(t);
  if (!item) return null;
  const body = /\b(?:\([a-z]\)\s*)?(On|Effective|As of|As previously)\b/.exec(t.slice(item.index, item.index + 2000));
  if (!body) return null;
  let rest = t.slice(item.index + body.index).replace(/^\([a-z]\)\s*/, '');
  rest = rest.replace(/\s*\((?:the |collectively[^)]*|together[^)]*)?[“"][^”"]{1,40}[”"]\)/g, '').replace(/,? or the (Company|Corporation|Registrant),/g, ',');
  let end = -1;
  for (const m of rest.matchAll(/\.\s+(?=[A-Z])/g)) if (!ABBREV.test(rest.slice(0, m.index))) { end = m.index; break; }
  let s = (end > 0 ? rest.slice(0, end) : rest.slice(0, 220)).trim();
  s = s.replace(/^(On|Effective|As of)\s+[A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4},?\s+/, ''); // the date is shown beside it
  if (s.length < 25) return null;
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.length > 200 ? s.slice(0, 197).replace(/\s+\S*$/, '') + '…' : s;
}

/**
 * The latest announcements, titled from their press releases where there is one, else from the filing's text.
 * deps: { getText(url, cacheName), htmlToText, exhibitUrl } (documents are cached on disk).
 */
async function companyNews(submissions, deps, limit = 8) {
  const list = companyFilings(submissions, limit);
  // { filed, label, form, title: the press release's headline or null, period: a report's period end or null, url }
  return Promise.all(list.map(async f => {
    const base = { filed: f.filed, label: f.label, form: f.form, title: null, period: f.period, url: f.url };
    if (f.form !== '8-K') return base;
    try {
      const ex = deps.exhibitUrl(await deps.getText(f.index, f.accn + '-index.htm'));
      if (ex) {
        const title = headline(deps.htmlToText(await deps.getText(ex, f.accn + '-ex99.htm')));
        if (title) return { ...base, title, url: ex };
      }
      const said = firstSentence(deps.htmlToText(await deps.getText(f.url, f.accn + '-8k.htm')));
      if (said) return { ...base, title: said };
    } catch { /* fall back to the label */ }
    return base;
  }));
}

module.exports = { companyNews, companyFilings, headline, firstSentence };
