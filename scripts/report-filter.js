/*
 * report-filter.js — which logged events the reports count: not automated traffic (marked `bot` when
 * logged, see lib/log.js), not the owner's own visitor ids, and nothing before tracking was cleaned up.
 * Both are kept in DATA_DIR/analytics-exclude.json: { "visitors": [ids], "since": iso }.
 */
'use strict';
const fs = require('fs');
const path = require('path');

function reportFilter(dataDir) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'analytics-exclude.json'), 'utf8')); } catch { /* none yet */ }
  const mine = new Set(cfg.visitors || []);
  const since = cfg.since || '';
  return { since, mine, counted: e => !e.bot && !mine.has(e.v) && e.t >= since, isBot: e => !!e.bot && e.t >= since };
}
/** Hashed calendar ids (see calKey in lib/log.js) that the owner's browsers used, from all logged events. */
function ownCalendars(events, mine) {
  return new Set(events.filter(e => e.cal && mine.has(e.v)).map(e => e.cal));
}
module.exports = { reportFilter, ownCalendars };
