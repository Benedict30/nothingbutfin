import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Globe, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Toaster } from 'sonner'
import { MagazineProvider } from '@/components/magazine'
import { NextEarnings } from '@/components/next-earnings'
import { MyCalendar } from '@/components/my-calendar'
import { Feedback } from '@/components/feedback'
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
        const v = st.kind !== 'flow' || last == null || before == null ? null
          : r.unit === 'shares' ? last
          : last > 0 && before > 0 ? last * (last / before)
          : last + (last - before)
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
function CompanyLogo({ ticker, name }: { ticker: string; name?: string }) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false) // a grey tile until the image arrives, not a white flash
  useEffect(() => { setFailed(false); setLoaded(false) }, [ticker])
  const box = 'size-10 shrink-0 rounded-lg'
  if (failed || !ticker) {
    const initials = (name || ticker).replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase()
    return <div aria-hidden className={cn(box, 'flex items-center justify-center bg-muted text-sm font-semibold text-muted-foreground')}>{initials}</div>
  }
  return <img src={'logo/' + encodeURIComponent(ticker) + '.png'} alt="" className={cn(box, 'object-contain p-1.5', loaded ? 'bg-white' : 'bg-muted')} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
}

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
  const update = (p: Partial<Prefs>) => setPrefs(cur => ({ ...cur, ...p }))

  useEffect(() => savePrefs(prefs), [prefs])

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
  // the next quarter is projected until its press release brings the real (preliminary) figures
  const quarterly = useMemo(() => {
    if (!data) return null
    if (prelim?.status === 'ready') return withPreliminary(data.quarterly, prelim)
    return prefs.projection ? withQuarterProjection(data.quarterly) : data.quarterly
  }, [data, prelim, prefs.projection])
  // analysts' revenue estimates by period; the next quarter's goes on the projected or preliminary column
  const estimates = useMemo(() => {
    const e = data?.estimates
    if (!e) return null
    const map = { ...e.byPeriod }
    if (e.next) {
      map.PROJQ = e.next.revenue
      if (prelim?.status === 'ready') map[prelim.period.key] = e.next.revenue
    }
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
          <div className="flex items-center gap-2 text-[15px] font-semibold tracking-tight whitespace-nowrap">
            <img src="favicon.svg" alt="" className="size-6" />
            Nothing But Fin
          </div>
          <Search
            onPick={(ticker, company) => {
              setPicked(company ?? null)
              update({ ticker: ticker.toUpperCase() })
            }}
          />
          <div className="ml-auto">
            <LanguagePicker />
          </div>
        </div>
      </header>
      <InstallApp />

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
                  {t("Shows analysts' consensus revenue estimate under Total Revenue, and the surprise: reported revenue minus the estimate. Data by Eulerpool.")}
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

        {prefs.freq === 'q' && prelim && prelim.status !== 'ready' && !switching && (
          <div className="flex items-center gap-2.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-sm">
            {prelim.status === 'generating' && <Loader2 className="size-4 shrink-0 animate-spin text-amber-400" />}
            <span>
              {t('{period} results are out (earnings press release) but not yet in the SEC data.', { period: prelim.period.label })}{' '}
              {prelim.status === 'generating' ? t('Reading the press release for preliminary figures…')
                : prelim.status === 'no-key' ? t('Add an Anthropic API key to show preliminary figures from the press release.')
                : t('Preliminary figures could not be read: {message}', { message: prelim.message ?? '' })}
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
      </MagazineProvider>
      <MyCalendar
        open={calendarOpen}
        onOpenChange={setCalendarOpen}
        onFollows={setFollows}
        onPick={ticker => { setPicked(null); update({ ticker }) }}
      />
      <Toaster theme="dark" position="bottom-right" offset={{ bottom: 76, right: 24 }} toastOptions={{ style: { fontFamily: 'inherit' } }} />
    </TooltipProvider>
  )
}
