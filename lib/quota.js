/*
 * quota.js — free magazine stories: each visitor may have a few new stories written for free, until
 * a closing date. Reading a story that is already written is always free and never counted.
 *
 * A visitor is counted by their visitor id (cookie) and, so that clearing cookies doesn't reset it,
 * by a hash of their IP address (the address itself is never stored); the higher count applies.
 * Counts live in DATA_DIR/story-quota.json.
 *
 *   STORY_FREE_LIMIT  stories per visitor (default: no limit)
 *   STORY_FREE_UNTIL  when new stories end, to keep AI costs under control (default 2026-11-11T00:00:00+08:00)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIMIT = process.env.STORY_FREE_LIMIT ? Math.max(0, +process.env.STORY_FREE_LIMIT || 0) : null; // null: no per-visitor limit
const UNTIL = process.env.STORY_FREE_UNTIL || '2026-11-11T00:00:00+08:00'; // shown to readers as written (date, time, offset)

const fileOf = dataDir => path.join(dataDir, 'story-quota.json');
function load(dataDir) {
  try { return JSON.parse(fs.readFileSync(fileOf(dataDir), 'utf8')); } catch { return { visitors: {}, ips: {} }; }
}

/** The caller's address: Cloudflare's header, else the one our proxy (Caddy) appended last, else the socket. */
function ipOf(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf);
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || '';
}
const ipKey = req => crypto.createHash('sha256').update('fsv-quota|' + ipOf(req)).digest('hex').slice(0, 16);

/** { limit, left, until, closed } for this visitor (limit and left are null when there is no limit). */
function status(dataDir, req) {
  const q = load(dataDir);
  const used = Math.max(q.visitors[req.visitor] || 0, q.ips[ipKey(req)] || 0);
  return { limit: LIMIT, left: LIMIT == null ? null : Math.max(0, LIMIT - used), until: UNTIL, closed: closed() };
}

/** Counts one new story for this visitor; null if allowed, else the reason ({ status: 'closed' | 'limit' }). */
function take(dataDir, req) {
  const s = status(dataDir, req);
  if (s.closed) return { status: 'closed' };
  if (s.left != null && s.left <= 0) return { status: 'limit' };
  const q = load(dataDir);
  if (req.visitor) q.visitors[req.visitor] = (q.visitors[req.visitor] || 0) + 1;
  const k = ipKey(req);
  q.ips[k] = (q.ips[k] || 0) + 1;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(fileOf(dataDir), JSON.stringify(q));
  return null;
}

/** Whether the free period is over (no new stories are written for anyone after it, see server.js autoStories too). */
const closed = () => Date.now() >= Date.parse(UNTIL);

module.exports = { status, take, closed, LIMIT, UNTIL };
