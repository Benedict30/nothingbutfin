// Checks personal earnings calendars: follows per private id, and the calendar feed.
// Run: node test/reminders.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildIcs, fold, follows, setFollow, touch, pruneInactive } = require('../lib/reminders');

// follows: per private id, de-duplicated, removable; ids must look random
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fsv-')), 'follows.json');
const me = 'k7QxA1b2C3d4E5f6G7h8', you = 'Zz9yX8wV7uT6sR5qP4oN';
setFollow(file, me, 'pltr', true);
setFollow(file, me, 'SNOW', true);
setFollow(file, you, 'AAPL', true);
assert.deepStrictEqual(setFollow(file, me, 'PLTR', true), ['PLTR', 'SNOW']);
assert.deepStrictEqual(follows(file, you), ['AAPL']); // each person sees only their own
assert.deepStrictEqual(setFollow(file, me, 'snow', false), ['PLTR']);
assert.deepStrictEqual(follows(file, 'short'), []);
assert.throws(() => setFollow(file, 'bad id!', 'PLTR', true));

// all-day event on the estimated date, alerts 30/14/7 days before and on the day
const ics = buildIcs([{ ticker: 'PLTR', name: 'Palantir Technologies Inc.', url: 'http://host/?ticker=PLTR',
  next: { date: '2026-11-02', basedOn: '2025-11-03', timing: 'after-close', time: '16:06' } }], { now: new Date('2026-10-31T00:00:00Z'), feed: true });
assert.ok(ics.includes('X-WR-CALNAME:Earnings') && ics.includes('REFRESH-INTERVAL;VALUE=DURATION:PT6H'));
assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
assert.ok(ics.includes('DTSTART;VALUE=DATE:20261102\r\nDTEND;VALUE=DATE:20261103'));
assert.ok(ics.includes('SUMMARY:PLTR earnings (est.)\\, after close'));
for (const t of ['TRIGGER:-P30D', 'TRIGGER:-P14D', 'TRIGGER:-P7D', 'TRIGGER:PT9H']) assert.ok(ics.includes(t), t);
// a date the company announced: no "(est.)"
const confirmedIcs = buildIcs([{ ticker: 'KO', name: 'Coca-Cola', url: 'http://host/?ticker=KO',
  next: { date: '2026-10-27', basedOn: '2025-10-21', timing: 'before-open', source: 'https://eulerpool.com' } }], { feed: true });
assert.ok(confirmedIcs.includes('SUMMARY:KO earnings\\, before open') && !confirmedIcs.includes('(est.)'));
assert.ok(confirmedIcs.replace(/\r\n /g, '').includes('as announced by the company (data by Eulerpool)'));
// same quarter, same event: adding it again updates rather than duplicates
assert.ok(ics.includes('UID:PLTR-earnings-2025-11-03@financial-statements-viewer'));
// long lines are folded at 75 octets
assert.ok(ics.split('\r\n').every(l => Buffer.byteLength(l) <= 75));
assert.strictEqual(fold('x'.repeat(80)), 'x'.repeat(75) + '\r\n ' + 'x'.repeat(5));

// abandoned calendars: unused for 60 days → removed; a used one stays; an untracked one starts its clock
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsv-'));
const fol = path.join(dir, 'follows.json'), act = path.join(dir, 'activity.json');
const used = 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7', gone = 'Hh8Ii9Jj0Kk1Ll2Mm3Nn4', fresh = 'Oo5Pp6Qq7Rr8Ss9Tt0Uu1';
setFollow(fol, used, 'PLTR', true); setFollow(fol, gone, 'KO', true); setFollow(fol, fresh, 'NVDA', true);
const t0 = Date.parse('2026-01-01T00:00:00Z'), day = 86400e3;
touch(act, used, t0); touch(act, gone, t0);
touch(act, used, t0 + 50 * day); // its phone kept fetching
assert.deepStrictEqual(pruneInactive(fol, act, { now: t0 + 61 * day }), [['KO']]);
assert.deepStrictEqual(follows(fol, used), ['PLTR']);
assert.deepStrictEqual(follows(fol, gone), []);
assert.deepStrictEqual(follows(fol, fresh), ['NVDA']); // first seen now: 60 days from here

console.log('reminders: all assertions passed');
