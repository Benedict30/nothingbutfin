# Nothing But Fin

Income statement, balance sheet and cash flow history for any SEC-registered company, built to the *Financial Statements v2* design handoff, with live data from **SEC EDGAR**. EDGAR is free, needs no API key, and its data can be shown internally without licensing restrictions.

## Run it

You need **Node 18+**. Run `npm install` and `npm run build` once (the build writes the UI to `public/`; the server's only runtime dependency is the Anthropic SDK, used for magazine stories).

**On a Mac, the easy way:** double-click `start.command`. It asks once for the name and email the SEC requires, starts the server and opens your browser. If macOS refuses to open it, right-click it and choose **Open**.

**Or from a terminal:**

```bash
SEC_USER_AGENT="Your Org Data Team you@yourorg.com" node server.js
# → http://127.0.0.1:3000   (try ?ticker=MSFT&tab=cash&freq=a)
```

The SEC requires every request to identify the caller with an organisation name and a contact email. Without one, EDGAR answers `403`.

| Env var | Default | |
|---|---|---|
| `SEC_USER_AGENT` | — | **Required.** Org + contact email |
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` to serve on your network |
| `CACHE_DIR` | `./cache` | Raw EDGAR JSON is cached here |
| `DATA_DIR` | `./data` | Personal earnings calendars (`follows.json`) |
| `FRESH_MINUTES` | `5` | How old EDGAR data may be when a company's page is opened |
| `FACTS_TTL_HOURS` | `12` | How long background calls reuse a company's data (opening the page always fetches fresh) |

**Docker:** `docker build -t fin-statements . && docker run -p 3000:3000 -e SEC_USER_AGENT="Org you@org.com" fin-statements`

**Behind a corporate proxy:** Node's built-in `fetch` ignores `HTTPS_PROXY` unless you start it with `NODE_USE_ENV_PROXY=1`, which needs Node 22.21+ or 24+.

**Under a sub-path** (for example `https://platform.internal/fin/`): the UI only uses relative URLs, so a reverse proxy that strips the prefix works as-is.

## Working on the UI

The UI is React + TypeScript with [shadcn/ui](https://ui.shadcn.com) components and Tailwind, built with Vite. Source is in `web/src`; `npm run build` writes the site to `public/`, which `server.js` serves.

```bash
npm install
node server.js        # API on :3000 (with SEC_USER_AGENT set)
npm run dev           # UI with hot reload on :5173, API calls proxied to :3000
npm run build         # rebuild public/ before deploying
```

The table shows as many periods as fit the screen without horizontal scrolling. The full-height **+** column on the right brings in the previous period; once the table is full, the newest period moves out and a **‹** column on the left brings it back. **×** on a period header hides it. The statement, frequency and growth toggles are remembered in the browser. Phones get the desktop layout, scaled to fit.

## Magazine stories (Claude)

The newspaper icon on each period header opens **The Quarterly**: a magazine-style story about what the table can't show. Claude (`claude-opus-5-5`) reads that period's **earnings press release** (the results-day 8-K, exhibit 99.1) and the **Management's Discussion & Analysis** of its 10-Q (or the 10-K for Q4 and annual periods), and writes: executives' own words, operating metrics outside the financial statements (customers, retention, backlog, products), guidance, what drove the period, and a watch list. Earnings-call transcripts aren't filed with the SEC, so they aren't included.

- **API key:** set `ANTHROPIC_API_KEY`, or save the key in a file named `.anthropic-api-key` in the project folder (gitignored; read on each request, so no restart needed). Without a key the page shows the figures and a link to the filing.
- **Accuracy:** executive quotes, metric evidence and guidance lines are checked word for word against the sources, and anything that doesn't match is dropped. Claude can still make mistakes in the story text, so the page links both documents.
- **Cost:** one request per filing, cached in `cache/magazine/`. A typical request is 15–35K input tokens (press release + MD&A); filings whose MD&A can't be located (some banks) are sent whole, up to ~150K tokens. Requests use server-side refusal fallbacks (`fallbacks: "default"`).

## Earnings day (before the 10-Q)

Companies announce results in a press release (an 8-K with exhibit 99.1); the structured XBRL data behind the table only arrives with the 10-Q or 10-K, often days later. When a results 8-K for the next quarter is filed and that quarter is not in the data yet:

- **Preliminary column.** The quarterly table starts with that quarter, tagged **Prelim**. Claude (`claude-opus-5-5`) copies each line from the release's GAAP tables exactly as printed; the server keeps a figure only if the number and its row label appear word for word in the release, converts units itself, and turns year-to-date figures into the quarter using the earlier quarters. This starts automatically the first time the company is opened (about $0.05 per release, cached). Definitions can differ slightly from the XBRL tags, especially for banks, and the 10-Q's data replaces the column when it arrives.
- **Story.** The magazine icon on that column writes the story from the press release.
- **Freshness.** Just reload the page: opening a company uses EDGAR data at most `FRESH_MINUTES` (5) old, shared by all visitors. Background calls reuse that copy, and the last copy is shown if EDGAR is unreachable.

## Earnings calendar

The bell on the next-earnings chip follows the company. Each browser gets a private random ID (no accounts), and the companies it follows are kept on the server in `data/follows.json`. Its calendar feed, `/cal/<id>.ics`, lists each followed company's next earnings, estimated and marked "(est.)" until the company announces the date, then moved to that date (see below), each with alerts 1 month, 2 weeks and 1 week before and at 9 am on the day. The first follow offers "Add to my calendar" (a one-time subscription). "My calendar" in the top bar lists the companies followed with their next earnings (unfollow there), shows whether a calendar app is reading the feed, and has the subscribe link plus "Use on another browser" (a private link with `?calendar=<id>` that makes another browser use the same calendar). Each event's link in the calendar carries the id too, so tapping one reconnects a browser whose storage was cleared. Calendar apps re-read the feed, so dates move as estimates change and newly followed companies appear by themselves. A calendar that is neither fetched by a calendar app nor changed on the site for 60 days (deleted from the phone, or its browser forgot the id) is removed, with its follows, so companies nobody receives stop being checked (`data/calendar-activity.json`). Apple Calendar shows the feed's alerts (leave "Remove alerts" unticked); Google Calendar ignores alerts in subscribed feeds, so set notifications on that calendar.

## Deploying

`deploy/deploy.sh` deploys to a Linux server with Docker over SSH: it builds the UI, copies the source, builds the image there and runs it behind [Caddy](https://caddyserver.com) for HTTPS. Put your server's SSH address in `deploy/.host` (or `DEPLOY_HOST`), copy `deploy/Caddyfile.example` to `deploy/Caddyfile` with your domain and email, and put the settings (`SEC_USER_AGENT`, `ANTHROPIC_API_KEY`, `EULERPOOL_API_KEY`) in `/opt/fsv/app.env` on the server. All three files stay out of git.

## API (for SQL and notebooks)

| Endpoint | Returns |
|---|---|
| `GET /api/search?q=apple` | Top 10 ticker/company matches |
| `GET /api/statements?ticker=AAPL` | `{company, currency, units, quarterly, annual, source}`. Each block has `periods[]` (newest first) and `statements.{income,balance,cash}.rows[]` with `vals[]` and `src[]` (tag and filing behind every number) |
| `GET /api/statements.csv?ticker=AAPL` | The same data in long format, one row per value: `ticker, cik, statement, line_item_key, line_item, unit, frequency, period, fiscal_year, fiscal_quarter, period_end, value, source`. Ready to load into a table |

`lib/edgar.js` is a standalone module (`normalize(companyFactsJson)`), so you can also use it in a batch job that loads many tickers into your warehouse.

## How the numbers are built

EDGAR's `companyfacts` endpoint returns every XBRL-tagged number a company has filed since about 2009. That data is raw, so `lib/edgar.js` cleans it up:

- **Fiscal calendar.** Fiscal years and quarter ends are read from the company's own 10-K and 10-Q filings, so 52/53-week years and odd year-ends work. Columns are labelled by **calendar period**: the calendar quarter or year a period mostly falls in, so different fiscal calendars line up. Snowflake's quarter ending Jul 31, 2026 (its Q2 FY2027) shows as Q2 2026, and NVIDIA's year ending Jan 2026 (its FY 2026) shows as 2025. The company's own fiscal year and quarter are still in the API (`fy`, `q`) and the CSV (`fiscal_year`, `fiscal_quarter`).
- **Duplicates and restatements.** Each number appears in several filings as a comparative. The **most recently filed** value wins, so restatements flow through.
- **Q4 and YTD-only quarters are derived.** 10-Qs often report cash flow only year-to-date, and the 10-K has no Q4 column. So Q2 = 6M − 3M, Q3 = 9M − 6M and Q4 = FY − 9M. The API and CSV include each value's tag and filing, and whether it was derived.
- **Tag changes.** Each line item tries a list of candidate tags in order, because companies change tags over time (for example `Revenues` vs `RevenueFromContractWithCustomer…`). Edit `ITEMS` in `lib/edgar.js` to add or remap lines.
- **Defined, not reported:** EBITDA = operating income + D&A. Free cash flow = CFO − capex. Gross profit and total liabilities are computed only when the company doesn't report them. Capex, buybacks, dividends and debt repayments are shown as negatives (outflows).
- **TTM (trailing twelve months).** When the latest quarter is newer than the latest annual report, the annual view starts with a TTM column: the last four quarters summed for income and cash flow items, the latest quarter for the balance sheet, and share counts averaged. Its YoY growth compares with the TTM a year earlier.
- **Per-share data.** Q4 EPS is approximated as FY − 9M. Q4 weighted shares are left blank because they aren't additive.
- **Currency.** The reporting currency is the unit most facts use, so TSMC shows TWD and Alibaba shows CNY, not their partial USD convenience translations.

### Checked against reported figures

The normalizer was run on live EDGAR data and compared with figures from company reports, and all of them matched. The set covers:

- Apple: FY24 revenue, net income, EPS, CFO, capex and total assets; derived Q4 FY24 revenue and net income; FY25 revenue and net income.
- Microsoft: FY24 and FY25 revenue and net income, plus Q4 FY25.
- NVIDIA: FY25 and Q4 FY25 revenue and net income (January year-end), plus Q1 FY26.
- Walmart: FY25 revenue and net income, plus Q4 FY25 revenue.
- Target: FY24 revenue and net income (fiscal year labelled by its start year).
- JPMorgan: FY24 net income, total assets and EPS, plus Q4 FY24 net income.
- Amazon: FY24 revenue, net income, CFO and capex, plus Q4 FY24 revenue and net income.
- Berkshire Hathaway: FY24 revenue and net income.
- Reddit (recent IPO): FY24 revenue and net income.
- Shopify (moved from 40-F to 10-K): FY24 revenue and net income.
- Alibaba (20-F, CNY): FY25 revenue.
- TSMC (20-F, IFRS, TWD): FY24 revenue and net income.

## Limits worth knowing

- **Coverage.** Only companies that file with the SEC are covered. Funds and ETFs have no statements. Foreign filers using 20-F or 40-F show annual data only.
- **Banks and insurers.** Their statements have a different shape, so lines like gross profit or current assets will be blank.
- **Segment detail.** Product and geographic segment data is not in `companyfacts`, which only holds totals.
- **Mixed vintages.** Very old periods (2007–2009) can be sparse, and values come from different filing vintages: older periods aren't restated for later reclassifications.

## Files

```
server.js            HTTP server: EDGAR fetch + cache, API, static files
lib/edgar.js         companyfacts → statements normaliser (Node + browser)
lib/magazine.js      filing lookup, MD&A extraction and Claude write-up for magazine stories
web/src/             UI source (React, shadcn/ui, Tailwind); built into public/
test/                node test/normalize.test.js · mock SEC for offline runs
```

Run the tests with `npm test`. They include accounting identity checks (gross profit = revenue − COGS, operating income = gross profit − opex, assets = liabilities & equity). `npm run check:data` runs the same checks, plus two that only hold when no line is left out (liabilities + equity; CFO + CFI + CFF = change in cash), on every company in the cache. It exits 1 if a strict identity fails, which so far happens only in pre-2015 periods built from mixed filing vintages. To run the app offline against synthetic data, use `npm run mock`, then start the server with `SEC_DATA_BASE=http://127.0.0.1:4000 SEC_WWW_BASE=http://127.0.0.1:4000` and open `?ticker=TEST`.

### Confirmed earnings dates

SEC data has no future dates, so the next earnings date is estimated from last year's results date for the same quarter. Eulerpool's earnings calendar (`lib/estimates.js`, the same request as the revenue estimates, cached 12 hours) replaces it once the company has announced the date: Eulerpool gives a time of day (before the open / after the close) only for announced dates, and its date must be within 45 days of our estimate.

Calendar events switch from the estimate to the confirmed date (the same event moves); the website chip shows the confirmed date, or the estimate marked "est.".

### AI cost report

`node scripts/costs.js` totals the recorded Claude usage per month and feature (stories, preliminary figures; earnings-date checks until November 2026) at list prices; on the server: `ssh <your-server> docker exec fsv node scripts/costs.js`. In Claude Code, the project skill `/costs` runs it and summarises. The exact bill is in the Anthropic Console.

### Usage and visitor logs

`data/usage.jsonl` records every Claude API call (feature, model, tokens, web searches, estimated cost, outcome — failed calls too), and `data/events.jsonl` records page views and story generations and reads under an anonymous random visitor id, kept for a year in a first-party cookie (`vid`, set by the server; no IP addresses). `node scripts/analytics.js [days]` reports PV, UV and UV/PV for the site and for stories; in Claude Code, `/analytics` runs it on the server and summarises.
