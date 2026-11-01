---
name: costs
description: Report what Nothing But Fin's Claude API usage has cost — magazine stories and preliminary figures (plus past earnings-date checks), per month — from the production server. Use when asked about AI cost, spend, or the bill.
---

# Claude API cost report

Every AI feature records its token usage, so spend can be totalled exactly (at list prices):

- **Stories** — `cache/magazine/*.json` (one per filing and language; written once, then free to reopen)
- **Preliminary figures** — `cache/preliminary/*.json` (one per earnings press release)
- **Earnings-date checks** — `data/confirmed.json` → `spent` per month (retired November 2026: dates now come from Eulerpool, free)
- **Every call, one line each** — `data/usage.jsonl` (from 2026-10-31): feature, what it was about, model, outcome, input / output / cache tokens, web searches, cost. Failed calls (refused, cut off) are included; they cost money too. Use it to look for savings: tokens per story, how often checks fail, which feature dominates.

## Run it

Production (the numbers that matter):

```
ssh "$(head -n1 deploy/.host)" docker exec fsv node scripts/costs.js
```

Local copy, for comparison: `node scripts/costs.js`

## Report back

Give the user a short summary: this month's total and by feature, the all-time total, and anything unusual (a month or story far above the rest, many failed calls). Story rows are listed by SEC accession number; name the company if it matters (the CIK in the accession is often the company's, but filing agents such as Workiva use their own).

These are estimates from recorded usage at list prices (`PRICES` in `lib/magazine.js`, plus $0.01 per web search). The exact bill is in the Anthropic Console (Usage and Cost pages); say so if the user needs exact figures. If a model's price is missing from `PRICES`, its cost shows as $0 — add the price.
