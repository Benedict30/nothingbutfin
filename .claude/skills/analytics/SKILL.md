---
name: analytics
description: Nothing But Fin's visitors — totals (PV, UV, UV/PV, countries, top companies, stories generated and read) and each recent visitor (country, companies, magazines, calendar, Claude cost, last visit) — from the production server. Use when asked about traffic, visitors, users, usage or engagement.
---

# Analytics

Run both on the production server:

```
ssh "$(head -n1 deploy/.host)" docker exec fsv node scripts/analytics.js
ssh "$(head -n1 deploy/.host)" docker exec fsv node scripts/visitors.js
```

`analytics.js [days]` gives totals for the last 30 days (or `days`) and the email sign-ups; `visitors.js [count] [--all]` groups visitors by country, then lists the latest 20 (or `count`) active visitors (read or generated a story, or follow a company). Times in GMT+8.

Both leave out automated traffic (marked `bot` when logged: crawler or headless user agents, or calls not from the site's own page) and the owner's own browsers, and count from the clean start; all three are in `data/analytics-exclude.json` (`visitors`, `since`). `--all` also counts the noisy period before the clean start (Oct 31 – Nov 1, 2026: mostly test runs).

Reply briefly, in two parts:

1. **Totals** — one line or small table: PV, UV, UV/PV; story reads and generations; email sign-ups; feedback.
2. **By country** — the country table; then the active visitors, one row each: country · companies viewed · magazines · following / calendar · last visit.

Then at most two or three notable points. Don't explain the method unless asked.

**Excluding a new device of the owner:** open `https://nothingbutfin.com/?exclude-me` once in that browser (it sets a `nolog` cookie; the site confirms "This browser is excluded from analytics"). Its visits are then not logged at all.

How it works, if asked: events are in `data/events.jsonl` (page views, story generations and reads, follows, calendar refreshes); each visitor is an anonymous random 128-bit id made by the browser and kept by the server in a year-long first-party cookie (`vid`). Unique per browser, not per person; no IP addresses. Country comes from Cloudflare. For spend, use the `costs` skill.
