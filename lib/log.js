/*
 * log.js — append-only logs in DATA_DIR, one JSON object per line, for reviewing later:
 *   usage.jsonl   every Claude API call: feature, model, tokens, web searches, estimated cost, outcome
 *   events.jsonl  page views, story generations / opens and follows, by an anonymous random visitor
 *                 id (a first-party cookie, see visitorId; no IP addresses) and country (from Cloudflare);
 *                 calendar feed fetches, by a hash of the private calendar id (never the id itself)
 * scripts/costs.js and scripts/analytics.js read them.
 */
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

function append(name, entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, name), JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.error(new Date().toISOString(), 'log', name, e.message); // logging must never break a request
  }
}

/** One Claude call. `msg` is the API response; `cost` in USD; `about` e.g. "PLTR Q3 2026 zh-Hans". */
function usage(feature, msg, cost, about) {
  const u = msg.usage || {};
  append('usage.jsonl', {
    feature, about, model: msg.model, outcome: msg.stop_reason,
    input: u.input_tokens || 0, output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
    searches: u.server_tool_use?.web_search_requests || 0, cost,
  });
}

const VISITOR = /^[A-Za-z0-9_-]{16,64}$/;
/**
 * A page view or story event; skipped without a valid visitor id (e.g. a crawler that doesn't run
 * the page). `req` gives the visitor id and the country Cloudflare looked up ("SG"; its CF-IPCountry header).
 */
function event(type, req, fields) {
  const visitor = req.visitor || req.headers['x-visitor'], country = String(req.headers['cf-ipcountry'] || '');
  if (VISITOR.test(String(visitor || ''))) append('events.jsonl', { type, v: visitor, ...(/^[A-Z]{2}$/.test(country) ? { country } : {}), ...fields });
}

/** A stand-in for a private calendar id: links follows to feed fetches without storing the id. */
const calKey = id => crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12);

/** A calendar app fetched a personal feed. `app` from its User-Agent, e.g. "iOS/18.6.2 dataaccessd/1.0". */
function feedFetch(calendarId, app) {
  append('events.jsonl', { type: 'calendar_fetch', cal: calKey(calendarId), app: String(app || '').slice(0, 80) });
}

/**
 * The visitor's id, kept in a first-party cookie set by the server: it lasts a year (browsers
 * shorten the life of cookies set by page scripts, Safari to 7 days), so returning visitors keep
 * their id. The first time, it adopts the id the page sent (X-Visitor), else makes one.
 */
function visitorId(req, res) {
  const fromCookie = /(?:^|;\s*)vid=([A-Za-z0-9_-]{16,64})/.exec(req.headers.cookie || '');
  if (fromCookie) return fromCookie[1];
  const id = VISITOR.test(String(req.headers['x-visitor'] || '')) ? req.headers['x-visitor'] : crypto.randomBytes(16).toString('hex');
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `vid=${id}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${secure}`);
  return id;
}

module.exports = { usage, event, feedFetch, calKey, visitorId, DATA_DIR };
