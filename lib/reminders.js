/*
 * reminders.js — personal earnings calendars.
 *
 * Each person follows companies under a private random ID (kept in their browser); there are no
 * accounts. Their calendar feed, /cal/<id>.ics, lists the next earnings of the companies they
 * follow: estimated ("(est.)") until the company announces the date, then that date (see
 * confirmed.js); each with alerts 1 month, 2 weeks and 1 week before and on the morning of the day.
 * They subscribe once; their calendar app re-reads the feed, so dates move as estimates change and
 * new companies appear by themselves. Calendars unused for 60 days are removed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { calKey } = require('./log');

// ------------------------------------------------------------ follows: { id: [tickers] }
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_FOLLOWS = 100;
const validId = id => ID.test(String(id || ''));
function loadAll(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
const follows = (file, id) => (validId(id) ? loadAll(file)[id] || [] : []);
/** Every company someone follows. */
function setFollow(file, id, ticker, on) {
  if (!validId(id)) throw Object.assign(new Error('Invalid calendar id'), { status: 400 });
  const t = String(ticker || '').trim().toUpperCase();
  const all = loadAll(file);
  const list = (all[id] || []).filter(x => x !== t);
  if (on && t) list.push(t);
  if (list.length > MAX_FOLLOWS) throw Object.assign(new Error('Too many companies followed'), { status: 400 });
  if (list.length) all[id] = list.sort(); else delete all[id];
  writeJson(file, all);
  return all[id] || [];
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------ abandoned calendars
// When each calendar was last used (its feed fetched by a calendar app, or a bell clicked), keyed by
// a hash of its id. One unused for INACTIVE_DAYS (deleted from the phone, or its browser forgot the
// id) is removed, so companies nobody receives stop being checked. Calendar apps fetch every few hours.
const INACTIVE_DAYS = 60;
const DAY = 86400e3;
// { [hash]: { used: iso, fetched?: iso } }: `fetched` is the calendar app's last refresh
function touch(file, id, now = Date.now(), fetched = false) {
  if (!validId(id)) return;
  const seen = loadAll(file), k = calKey(id), at = new Date(now).toISOString();
  seen[k] = { ...(typeof seen[k] === 'object' ? seen[k] : {}), used: at, ...(fetched ? { fetched: at } : {}) };
  writeJson(file, seen);
}
/** When this calendar's feed was last fetched by a calendar app, or null. */
const lastFetched = (file, id) => (validId(id) && loadAll(file)[calKey(id)]?.fetched) || null;
/** Removes calendars unused for `days`; one never seen before starts its clock now. Returns the removed follow lists. */
function pruneInactive(followsFile, activityFile, { now = Date.now(), days = INACTIVE_DAYS } = {}) {
  const all = loadAll(followsFile), seen = loadAll(activityFile);
  const removed = [];
  let started = false;
  for (const id of Object.keys(all)) {
    const k = calKey(id);
    if (!seen[k]) { seen[k] = { used: new Date(now).toISOString() }; started = true; continue; }
    if (now - Date.parse(seen[k].used || seen[k]) > days * DAY) { removed.push(all[id]); delete all[id]; delete seen[k]; }
  }
  if (removed.length) writeJson(followsFile, all);
  if (removed.length || started) writeJson(activityFile, seen);
  return removed;
}

// ------------------------------------------------------------ calendar file (RFC 5545)
const ALERTS = [
  ['-P30D', 'in 1 month'],
  ['-P14D', 'in 2 weeks'],
  ['-P7D', 'in 1 week'],
  ['PT9H', 'today'], // 9 am on the day
];
const TIMING = { 'before-open': 'before open', 'after-close': 'after close', during: 'during market hours' };

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// lines longer than 75 octets continue on the next line, indented by one space
function fold(line) {
  const out = [];
  let rest = Buffer.from(line, 'utf8');
  while (rest.length > 75) {
    let cut = 75;
    while (cut > 0 && (rest[cut] & 0xc0) === 0x80) cut--; // don't split a UTF-8 character
    out.push(rest.subarray(0, cut).toString('utf8'));
    rest = Buffer.concat([Buffer.from(' '), rest.subarray(cut)]);
  }
  out.push(rest.toString('utf8'));
  return out.join('\r\n');
}
const day = iso => iso.replace(/-/g, '');
const nextDay = iso => new Date(Date.parse(iso) + 86400e3).toISOString().slice(0, 10).replace(/-/g, '');
const longDate = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const clock = time => new Date(`2000-01-01T${time}:00`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/**
 * events: [{ ticker, name, next: { date, basedOn, timing?, time?, source? }, url }]
 * `source` marks a date the company has announced (via Eulerpool); without it the date is an estimate.
 * The UID is per company and quarter (basedOn = last year's results date for that quarter), so a
 * moved estimate moves the same event. With `feed`, the calendar is a subscription to re-read.
 */
function buildIcs(events, { now = new Date(), feed = false } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Nothing But Fin//Earnings reminders//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    ...(feed ? ['X-WR-CALNAME:Earnings · Nothing But Fin', 'X-PUBLISHED-TTL:PT6H', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H'] : []),
  ];
  for (const e of events) {
    const when = e.next.timing ? ', ' + TIMING[e.next.timing] : '';
    const est = e.next.source ? '' : ' (est.)';
    const title = `${e.ticker} earnings${est}${when}`;
    const about = e.next.source
      ? `${e.name}: earnings ${longDate(e.next.date)}${when}` + (e.next.time ? ` (around ${clock(e.next.time)} New York time)` : '') +
        `, as announced by the company (data by Eulerpool)\n${e.url}`
      : `${e.name}: estimated next earnings ${longDate(e.next.date)}${when}` +
        (e.next.time ? ` (usually around ${clock(e.next.time)} New York time)` : '') +
        `. Based on last year's results date for the same quarter (${longDate(e.next.basedOn)}); the exact date is announced on the company's investor-relations site.\n${e.url}`;
    lines.push(
      'BEGIN:VEVENT', `UID:${e.ticker}-earnings-${e.next.basedOn}@financial-statements-viewer`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day(e.next.date)}`, `DTEND;VALUE=DATE:${nextDay(e.next.date)}`,
      `SUMMARY:${esc(title)}`, `DESCRIPTION:${esc(about)}`, `URL:${e.url}`, 'TRANSP:TRANSPARENT',
    );
    for (const [trigger, label] of ALERTS) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(`${e.ticker} earnings ${label}${est}${when}`)}`, `TRIGGER:${trigger}`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildIcs, fold, follows, setFollow, validId, touch, lastFetched, pruneInactive, INACTIVE_DAYS };
