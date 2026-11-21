import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Globe, Loader2, Activity } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Toaster, toast } from 'sonner'
import { MagazineProvider } from '@/components/magazine'
import { NextEarnings } from '@/components/next-earnings'
import { MyCalendar } from '@/components/my-calendar'
import { Feedback } from '@/components/feedback'
import { CompanyNews } from '@/components/company-news'
import { CompanyLogo } from '@/components/company-logo'
import { MarketPage } from '@/components/market-backdrop'
import { InstallApp } from '@/components/install-app'
import { loadFollows } from '@/lib/calendar'
import { rememberRecent, Search } from '@/components/search'
import { StatementTable, TableSkeleton } from '@/components/statement-table'
import { currencyName, LANG_SHORT, LANGS, locale, monthName, t, useLang } from '@/lib/i18n'
import { loadPrefs, modeShown, MODES, savePrefs, TABS, type Mode, type Prefs } from '@/lib/prefs'
import type { Block, Freq, Preliminary, SearchResult, StatementKey, Statements } from '@/lib/types'
import { cn } from '@/lib/utils'
import { visitorHeaders } from '@/lib/visitor'

/** The quarterly block with the press release's preliminary quarter in front, once its figures are read. */
function withPreliminary(block: Block, pre: Preliminary | null | undefined): Block {
  if (!pre || pre.status !== 'ready' || !pre.values) return block
  const statements = Object.fromEntries(
    Object.entries(block.statements).map(([k, st]) => [k, {
      ...st,
      rows: st.rows.map(r => ({ ...r, vals: [pre.values![r.key]?.value ?? null, ...r.vals], src: [pre.values![r.key]?.src ?? null, ...(r.src ?? r.vals.map(() => null))] })),
    }]),
  ) as Block['statements']
  return { periods: [{ ...pre.period, preliminary: true, release: pre.release }, ...block.periods], statements }
}

/** "Q3 2026" for a quarter ending on `end` (the calendar quarter it mostly covers, as the server labels them). */
function quarterLabel(end: string) {
  const d = new Date(Date.parse(end) - 45 * 86400e3)
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`
}

/** The projection formula for one row: the latest value grown at its latest rate (for a loss, the same change in dollars). */
const project = (last: number | null, before: number | null, shares = false) =>
  last == null || before == null ? null : shares ? last : last > 0 && before > 0 ? last * (last / before) : last + (last - before)

/**
 * The quarterly block with the next quarter projected in front: the latest quarter grown at its
 * latest quarter-on-quarter rate (for a loss, the same change in dollars; share counts unchanged).
 * Flow statements only, as for the projected year.
 */
function withQuarterProjection(block: Block): Block {
  const [cur, prev] = block.periods
  if (!cur?.q || !prev?.q || cur.fy * 4 + cur.q - (prev.fy * 4 + prev.q) !== 1) return block
  const end = new Date(Date.parse(cur.end) + 91 * 86400e3).toISOString().slice(0, 10)
  const period = {
    key: 'PROJQ', label: quarterLabel(end), fy: cur.q === 4 ? cur.fy + 1 : cur.fy, q: cur.q === 4 ? 1 : cur.q + 1, end, months: 3,
    projected: { reported: [], projected: [quarterLabel(end)], from: prev.label, to: cur.label },
  }
  const statements = Object.fromEntries(
    Object.entries(block.statements).map(([k, st]) => [k, {
      ...st,
      rows: st.rows.map(r => {
        const [last, before] = r.vals
        const v = st.kind !== 'flow' ? null : project(last, before, r.unit === 'shares')
        return { ...r, vals: [v, ...r.vals], src: [null, ...(r.src ?? r.vals.map(() => null))] }
      }),
    }]),
  ) as Block['statements']
  return { periods: [period, ...block.periods], statements }
}

/** The annual block without its "projected" year (when the person hides it). */
function withoutProjection(block: Block): Block {
  const i = block.periods.findIndex(p => p.key === 'PROJ')
  if (i < 0) return block
  const drop = <T,>(a: T[] | undefined) => a && a.filter((_, k) => k !== i)
  const statements = Object.fromEntries(
    Object.entries(block.statements).map(([k, st]) => [k, { ...st, rows: st.rows.map(r => ({ ...r, vals: drop(r.vals)!, src: drop(r.src) })) }]),
  ) as Block['statements']
  return { periods: drop(block.periods)!, statements }
}

const SHORT: Record<Mode, string> = { qoq: 'QoQ', qoqp: 'QoQ %', yoy: 'YoY', yoyp: 'YoY %' }

/** Company logo (via our server, cached); the initials when there is none. */
/** Language menu in the top bar. */
function LanguagePicker() {
  const { lang, setLang } = useLang()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={t('Language')} className="inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <Globe className="size-4" />
          {LANG_SHORT[lang]}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-40 p-1">
        {LANGS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            lang={k}
            onClick={() => { setLang(k); setOpen(false) }}
            className={cn('flex w-full items-center rounded-sm px-2.5 py-1.5 text-left text-sm hover:bg-muted', k === lang && 'font-semibold text-chart-up')}
          >
            {label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

export default function App() {
  useLang() // re-render in the chosen language
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [data, setData] = useState<Statements | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [extra, setExtra] = useState(0) // periods added beyond what fits the screen
  const [prelim, setPrelim] = useState<Preliminary | null>(null)
  const [picked, setPicked] = useState<SearchResult | null>(null) // the company just chosen in search, shown while it loads
  const [follows, setFollows] = useState<string[]>([]) // companies in this person's earnings calendar
  const [calendarOpen, setCalendarOpen] = useState(false)
  useEffect(() => { loadFollows().then(setFollows).catch(() => {}) }, [])
  // confirms the owner's ?exclude-me link (see index.html)
  useEffect(() => {
    try { if (sessionStorage.getItem('fsv-excluded')) { sessionStorage.removeItem('fsv-excluded'); toast.success('This browser is excluded from analytics') } } catch { /* storage unavailable */ }
  }, [])
  const update = (p: Partial<Prefs>) => setPrefs(cur => ({ ...cur, ...p }))
  // a company's page, or the market page (?view=market); Back and Forward move between them
  const [view, setView] = useState<'company' | 'market'>(() => (new URLSearchParams(location.search).get('view') === 'market' ? 'market' : 'company'))
  const openCompany = (ticker: string, company?: SearchResult) => {
    setPicked(company ?? null)
    update({ ticker: ticker.toUpperCase() })
    if (view === 'market') { history.pushState(null, '', '?ticker=' + encodeURIComponent(ticker.toUpperCase())); setView('company'); window.scrollTo(0, 0) }
  }
  // Back returns to the company page behind the market page; when the visit started on the market page there is none
  const showCompany = () => { if (view === 'market') history.state?.fromCompany ? history.back() : openCompany(prefs.ticker) }
  const showMarket = () => {
    if (view === 'market') return
    history.pushState({ fromCompany: true }, '', '?view=market')
    setView('market')
    window.scrollTo(0, 0)
  }
  useEffect(() => {
    const onPop = () => {
      const q = new URLSearchParams(location.search)
      if (q.get('view') === 'market') return setView('market')
      if (q.get('ticker')) update({ ticker: q.get('ticker')!.toUpperCase() })
      setView('company')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => savePrefs(prefs, view === 'market'), [prefs, view])

  useEffect(() => {
    const ctl = new AbortController()
    setLoading(true)
    setError(null)
    // the first company's request was started by index.html, before this code loaded
    const early = (window as { __early?: { ticker: string; res: Promise<Response> } }).__early
    delete (window as { __early?: unknown }).__early
    const res = early?.ticker === prefs.ticker ? early.res : fetch('api/statements?ticker=' + encodeURIComponent(prefs.ticker), { signal: ctl.signal, headers: visitorHeaders() })
    res
      .then(async r => {
        if (ctl.signal.aborted) return
        const j = await r.json().catch(() => ({ error: `Unexpected response from server (HTTP ${r.status})` }))
        if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status)
        setData(j)
        rememberRecent({ cik: j.company.cik, name: j.company.name, ticker: j.company.ticker, exchange: j.company.exchange })
        setPrelim(j.preliminary ?? null)
        setExtra(0)
        setLoading(false)
      })
      .catch(e => {
        if (e.name === 'AbortError') return
        setError(e.message)
        setLoading(false)
      })
    return () => ctl.abort()
  }, [prefs.ticker])

  // while the press release is being read, check every 4s
  useEffect(() => {
    if (prelim?.status !== 'generating') return
    const t = setInterval(() => {
      fetch('api/preliminary?ticker=' + encodeURIComponent(prefs.ticker))
        .then(r => r.json())
        .then(j => j.preliminary?.status !== 'generating' && setPrelim(j.preliminary ?? null))
        .catch(() => {})
    }, 4000)
    return () => clearInterval(t)
  }, [prelim?.status, prefs.ticker])

  const c = data?.company
  // a different company is loading: show it right away (name from search) with placeholders, not the old one
  const switching = loading && !!c && (c.ticker || String(c.cik)).toUpperCase() !== prefs.ticker
  const next = picked && picked.ticker.toUpperCase() === prefs.ticker ? picked : null
  // the latest quarter (preliminary, from its press release, once that is out) and, with projections on,
  // the next one projected
  const quarterly = useMemo(() => {
    if (!data) return null
    const block = prelim?.status === 'ready' ? withPreliminary(data.quarterly, prelim) : data.quarterly
    return prefs.projection ? withQuarterProjection(block) : block
  }, [data, prelim, prefs.projection])
  // analysts' revenue estimates by period; the next quarter's goes on the projected or preliminary column
  const estimates = useMemo(() => {
    const e = data?.estimates
    if (!e) return null
    const map = { ...e.byPeriod }
    // the quarter after the latest filed one: the preliminary column if its results are out, else the projection
    if (prelim?.status === 'ready') {
      if (e.next) map[prelim.period.key] = e.next.revenue
      if (e.after) map.PROJQ = e.after.revenue
    } else if (e.next) map.PROJQ = e.next.revenue
    return map
  }, [data, prelim])
  const annual = useMemo(() => (data && !prefs.projection ? withoutProjection(data.annual) : data?.annual), [data, prefs.projection])
  const block = data ? (prefs.freq === 'q' ? quarterly : annual!) : null
  const fetched = data?.source.fetchedAt ? new Date(data.source.fetchedAt).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : ''

  return (
    <TooltipProvider delayDuration={250}>
      <MagazineProvider
        ticker={c?.ticker || prefs.ticker}
        freq={prefs.freq}
        company={c ?? { cik: 0, name: prefs.ticker }}
        periods={block?.periods ?? []}
        onNavigate={(ticker, freq) => {
          update({ ticker, freq })
          setExtra(0)
        }}
      >
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1320px] items-center gap-6 px-6 py-3">
          <button type="button" onClick={showCompany} className="flex items-center gap-2 rounded-md text-[15px] font-semibold tracking-tight whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <img src="favicon.svg" alt="" className="size-6" />
            Nothing But Fin
          </button>
          <Search onPick={openCompany} />
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={showMarket}
              aria-current={view === 'market' ? 'page' : undefined}
              className={cn('inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50', view === 'market' ? 'text-foreground' : 'text-muted-foreground')}
            >
              <Activity className="size-4" /> <span className="max-sm:hidden">{t('Market')}</span>
            </button>
            <LanguagePicker />
          </div>
        </div>
      </header>
      <InstallApp />

      {view === 'market' ? (
        <main className="mx-auto max-w-[1100px] px-6 pt-7 pb-12"><MarketPage back={{ label: t('Back to {name}', { name: c?.ticker || prefs.ticker }), onClick: showCompany }} /></main>
      ) : (
      <main className="mx-auto flex max-w-[1320px] flex-col gap-5 px-6 pt-7 pb-12">
        <section className="flex min-h-[92px] flex-col gap-1.5">
          {switching ? (
            <>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="secondary" className="font-semibold tracking-wide">{prefs.ticker}</Badge>
                {next?.exchange}
              </div>
              {next ? (
                <div className="flex items-center gap-3">
                  <CompanyLogo ticker={next.ticker} name={next.name} />
                  <h1 className="text-3xl font-semibold tracking-tight">{next.name}</h1>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <Skeleton className="size-10 rounded-lg" />
                  <Skeleton className="h-9 w-72" />
                </div>
              )}
              <Skeleton className="mt-1 h-4 w-96" />
            </>
          ) : c ? (
            <>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {c.ticker && <Badge variant="secondary" className="font-semibold tracking-wide">{c.ticker}</Badge>}
                {c.exchange}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                <div className="flex items-center gap-3">
                  <CompanyLogo ticker={c.ticker || ''} name={c.name} />
                  <h1 className="text-3xl font-semibold tracking-tight">{c.name}</h1>
                </div>
                {data!.nextEarnings && c.ticker && (
                  <NextEarnings ticker={c.ticker} {...data!.nextEarnings} following={follows.includes(c.ticker.toUpperCase())} onFollows={setFollows} revenueEstimate={data!.estimates?.next?.revenue} onOpenCalendar={() => setCalendarOpen(true)} />
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {t('Figures in millions of {cur}, except per-share data', { cur: currencyName(data!.currency) })}
                {c.fiscalYearEnd && t(' · Fiscal year ends in {month}', { month: monthName(+c.fiscalYearEnd.slice(0, 2)) })}
              </p>
            </>
          ) : (
            <>
              <Skeleton className="h-5 w-28" />
              <div className="flex items-center gap-3">
                <Skeleton className="size-10 rounded-lg" />
                <Skeleton className="h-9 w-72" />
              </div>
              <Skeleton className="mt-1 h-4 w-96" />
            </>
          )}
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Tabs value={prefs.tab} onValueChange={v => update({ tab: v as StatementKey })}>
              <TabsList className="h-10">
                {TABS.map(([k, l]) => (
                  <TabsTrigger key={k} value={k} className="px-3.5 text-sm">
                    {t(l)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Tabs
              value={prefs.freq}
              onValueChange={v => {
                update({ freq: v as Freq })
                setExtra(0)
              }}
            >
              <TabsList className="h-10">
                <TabsTrigger value="q" className="px-3.5 text-sm">{t('Quarterly')}</TabsTrigger>
                <TabsTrigger value="a" className="px-3.5 text-sm">{t('Annual')}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {/* growth rows: plain text toggles; the selected ones are highlighted */}
          <div className="flex items-center gap-1" role="group" aria-label="Growth rows to show">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-pressed={prefs.projection}
                  onClick={() => update({ projection: !prefs.projection })}
                  className={cn(
                    'h-8 rounded-md px-2.5 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    prefs.projection ? 'bg-chart-up/15 text-chart-up' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t('Projected')}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-72 px-3 py-2 text-xs leading-relaxed">
                {prefs.freq === 'q'
                  ? t('Shows the next quarter projected: the latest quarter grown at its latest quarter-on-quarter rate. A trend, not a forecast.')
                  : t('Shows this fiscal year projected: the quarters reported so far plus the rest, each grown at the latest quarter-on-quarter rate. A trend, not a forecast.')}
              </TooltipContent>
            </Tooltip>
            {data?.estimates && (prefs.freq === 'q' || Object.keys(data.estimates.annual ?? {}).length > 0) && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={prefs.estimates}
                    onClick={() => update({ estimates: !prefs.estimates })}
                    className={cn(
                      'h-8 rounded-md px-2.5 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      prefs.estimates ? 'bg-chart-up/15 text-chart-up' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t('Estimates')}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-72 px-3 py-2 text-xs leading-relaxed">
                  {t("Shows analysts' consensus revenue estimate under Total Revenue, and how reported revenue compared with it. Data by Eulerpool.")}
                </TooltipContent>
              </Tooltip>
            )}
            <span className="mx-1.5 h-5 w-px bg-border" aria-hidden />
            <span className="mr-1.5 text-sm text-muted-foreground/70 select-none">{t('Growth')}</span>
            {MODES.filter(([k]) => modeShown(k, prefs.freq)).map(([k]) => {
              const on = prefs.modes.includes(k)
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  onClick={() => update({ modes: on ? prefs.modes.filter(m => m !== k) : [...prefs.modes, k] })}
                  className={cn(
                    'h-8 rounded-md px-2.5 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    on ? 'bg-chart-up/15 text-chart-up' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(SHORT[k])}
                </button>
              )
            })}
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
            {error}
            <div className="mt-1 text-muted-foreground">{data ? t('Still showing {name}.', { name: c?.ticker || c?.name || '' }) : t('Try another ticker, e.g. AAPL, MSFT, NVDA.')}</div>
          </div>
        )}

        {prefs.freq === 'q' && data?.quarterlySource === 'Eulerpool' && !switching && (
          <div className="text-sm text-muted-foreground">
            {t('{name} reports its quarters as press releases, not SEC data, so quarterly figures are from Eulerpool, shown only where they match its SEC annual reports.', { name: c?.ticker || '' })}
          </div>
        )}

        {prefs.freq === 'q' && prelim && prelim.status !== 'ready' && !switching && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {prelim.status === 'generating' && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
            <span>
              {t('{period} results are out (earnings press release) but not yet in the SEC data.', { period: prelim.period.label })}{' '}
              {prelim.status === 'generating' ? t('Reading the press release for preliminary figures…')
                : prelim.status === 'no-key' ? t('Add an Anthropic API key to show preliminary figures from the press release.')
                : <>
                    {t("Its figures will appear here when the {form} is filed.", { form: prelim.period.q === 4 ? '10‑K' : '10‑Q' })}{' '}
                    {prelim.link && <a href={prelim.link} target="_blank" rel="noopener" className="inline-flex items-center gap-1 font-medium underline underline-offset-4">{t('Read the press release')} <ExternalLink className="size-3" /></a>}
                  </>}
            </span>
          </div>
        )}

        {block && !switching ? (
          <div className={cn('transition-opacity duration-200', loading && 'opacity-50')}>
            <StatementTable
              block={block}
              tab={prefs.tab}
              freq={prefs.freq}
              modes={prefs.modes}
              units={data!.units}
              keyOnly={prefs.keyRows}
              onKeyOnly={on => update({ keyRows: on })}
              estimates={!prefs.estimates ? null : prefs.freq === 'q' ? estimates : data!.estimates?.annual ?? null}
              reported={{
                ...(data!.reported?.[prefs.freq === 'q' ? 'quarterly' : 'annual'] ?? {}),
                ...(prefs.freq === 'q' && prelim?.status === 'ready' && prelim.release ? { [prelim.period.key]: { release: prelim.release.filed } } : {}),
              }}
              extra={extra}
              onExtra={setExtra}
            />
          </div>
        ) : (
          !error && <TableSkeleton tab={prefs.tab} keyOnly={prefs.keyRows} subLines={prefs.modes.filter(m => modeShown(m, prefs.freq)).length} />
        )}

        {data && !switching && c?.ticker && <CompanyNews ticker={c.ticker} />}

        {data && !switching && (
          <footer className="flex flex-wrap justify-between gap-4 text-sm leading-relaxed text-muted-foreground">
            <div>
              {t('Source: SEC EDGAR XBRL filings')}{fetched && t(' · retrieved {date}', { date: fetched })}
              {data.source.stale && t(' (cached — EDGAR unreachable)')}
              {data.estimates && (
                <> · {t('Revenue estimates')}: <a href="https://eulerpool.com" target="_blank" rel="noopener" className="text-foreground underline-offset-4 hover:underline">Data by Eulerpool</a></>
              )}
              <br />{t('Q4 and some quarterly cash-flow figures are calculated from year-to-date totals. Select numbers to see their sum and average.')}
              <br />{t('For information only, not investment advice. Earnings dates are estimates; stories are written by AI and can contain mistakes.')}
            </div>
            <div className="flex items-start gap-5">
              <Feedback />
              {data.source.filings && (
                <a className="inline-flex items-center gap-1.5 text-foreground underline-offset-4 hover:underline" href={data.source.filings} target="_blank" rel="noopener">
                  {t('Filings on EDGAR')} <ExternalLink className="size-4" />
                </a>
              )}
            </div>
          </footer>
        )}
      </main>
      )}
      </MagazineProvider>
      <MyCalendar
        open={calendarOpen}
        onOpenChange={setCalendarOpen}
        onFollows={setFollows}
        onPick={ticker => openCompany(ticker)}
      />
      <Toaster theme="dark" position="bottom-right" offset={{ bottom: 76, right: 24 }} toastOptions={{ style: { fontFamily: 'inherit' } }} />
    </TooltipProvider>
  )
}
