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

`analytics.js [days]` gives totals for the last 30 days (or `days`); `visitors.js [count]` lists the latest 20 visitors (or `count`), times in GMT+8.

Reply briefly, in two parts:

1. **Totals** — one line or small table: PV, UV, UV/PV; story reads and generations; top countries and companies.
2. **Visitors** — one table row each: country · companies viewed · magazines generated · calendar (following / subscribed) · Claude cost · last visit.

Then at most two or three notable points. Don't explain the method unless asked.

How it works, if asked: events are in `data/events.jsonl` (page views, story generations and reads, follows, calendar refreshes); each visitor is an anonymous random 128-bit id made by the browser and kept by the server in a year-long first-party cookie (`vid`). Unique per browser, not per person; no IP addresses. Country comes from Cloudflare. For spend, use the `costs` skill.
