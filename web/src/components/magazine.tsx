import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ExternalLink, Eye, KeyRound, Loader2, Mail, Newspaper, RotateCw, Telescope } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { locale, longDate, t, useLang, type Lang } from '@/lib/i18n'
import type { Freq, Period, Statements } from '@/lib/types'
import { cn } from '@/lib/utils'
import { visitorHeaders } from '@/lib/visitor'

interface Article {
  headline: string
  dek: string
  mood: 'strong' | 'steady' | 'mixed' | 'tough'
  lede: string
  voices: { speaker: string; role: string; quote: string; translation?: string; context: string }[]
  beyond: { label: string; value: string; detail: string; evidence: string }[]
  takeaways: string[]
  sections: { kicker: string; heading: string; body: string }[]
  outlook: { summary: string; items: { label: string; value: string; evidence: string }[] }
  watchlist: { title: string; detail: string }[]
}
type Ok = {
  status: 'ok'
  article: Article
  sources: string[]
  model: string
  cached: boolean // true when served from the saved copy (no new cost)
  cost: number | null // USD, what writing the story cost the first time
  createdAt?: string
  usage?: { input_tokens: number; output_tokens: number }
}
interface MagazineResponse {
  filing: { form: string; filed: string; url: string } | null
  release: { filed: string; url: string } | null
  ai: Ok | { status: 'none' | 'generating' | 'no-key' | 'limit' | 'closed' } | { status: 'error'; message: string }
  free?: Free // new stories this visitor may still have written for free
}
interface Free { limit: number | null; left: number | null; until: string; closed: boolean } // limit/left null: no per-visitor limit
const WAITLIST = 'ben.chin.credit@gmail.com'
/** When new stories end, in the reader's own timezone and language: "Nov 10, 2026, 11:00 AM EST" */
const untilText = (until: string) =>
  new Date(until).toLocaleString(locale(), { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const freeNote = (f: Free) => f.left == null ? t('Available until {date}', { date: untilText(f.until) }) : t('{left} of {limit} stories left · available until {date}', { left: f.left, limit: f.limit ?? 0, date: untilText(f.until) })
type State = 'none' | 'generating' | 'ready' | 'error'

const MOOD = { // labels are translated where shown
  strong: { label: 'Strong period', dot: 'bg-positive' },
  steady: { label: 'Steady period', dot: 'bg-chart-up' },
  mixed: { label: 'Mixed period', dot: 'bg-amber-400' },
  tough: { label: 'Tough period', dot: 'bg-negative' },
}
const initials = (name: string) => name.split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase()

function Kicker({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-semibold tracking-[0.14em] text-chart-up uppercase">{children}</div>
}

function Paragraphs({ text, dropCap = false }: { text: string; dropCap?: boolean }) {
  return (
    <>
      {text.split(/\n\s*\n/).map((p, k) => (
        <p
          key={k}
          className={cn(
            'text-[17px] leading-[1.7] text-foreground/90',
            dropCap && k === 0 && 'first-letter:float-left first-letter:mt-1 first-letter:mr-2 first-letter:font-serif first-letter:text-[3.4em] first-letter:leading-[0.8] first-letter:font-semibold first-letter:text-foreground',
          )}
        >
          {p}
        </p>
      ))}
    </>
  )
}

/** The story's sections in reading order: opening, quotes, metrics, key points, each section, outlook, watch list. */
function storySections(a: Article): { key: string; node: React.ReactNode }[] {
  const pages: { key: string; node: React.ReactNode }[] = [{ key: 'lede', node: <Paragraphs text={a.lede} dropCap /> }]
  if (a.voices.length) pages.push({ key: 'voices', node: (
<section className="space-y-4">
          <Kicker>{t('In their own words')}</Kicker>
          {a.voices.map((v, k) => (
            <figure key={k} className={cn('flex gap-4', k % 2 === 1 && 'flex-row-reverse text-right')}>
              <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-chart-up/20 text-sm font-semibold text-chart-up">{initials(v.speaker)}</div>
              <div className="flex-1 space-y-2 rounded-2xl border bg-muted/25 px-5 py-4">
                <blockquote className="font-serif text-[19px] leading-snug text-foreground italic">“{v.quote.replace(/^["“”]+|["“”]+$/g, '')}”</blockquote>
                {/* the quote stays in the original English (it is checked word for word); the translation follows */}
                {v.translation && <p className="text-[15px] leading-relaxed text-foreground/85">{v.translation}</p>}
                <figcaption className="text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{v.speaker}</span>, {v.role} · {t('on {context}', { context: /^[A-Z][a-z]/.test(v.context) ? v.context.charAt(0).toLowerCase() + v.context.slice(1) : v.context })}
                </figcaption>
              </div>
            </figure>
          ))}
        </section>
  ) })
  if (a.beyond.length) pages.push({ key: 'beyond', node: (
<section className="space-y-3">
          <Kicker>{t('Beyond the table')}</Kicker>
          <h3 className="font-serif text-2xl leading-tight font-semibold">{t("What the financial statements don't show")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {a.beyond.map((b, k) => (
              <div key={k} className="space-y-1.5 rounded-xl border p-4">
                <div className="font-serif text-3xl font-semibold tracking-tight">{b.value}</div>
                <div className="text-sm font-medium">{b.label}</div>
                <p className="text-sm leading-relaxed text-muted-foreground">{b.detail}</p>
                <p className="border-l pl-2 text-xs leading-relaxed text-muted-foreground/80 italic">“{b.evidence}”</p>
              </div>
            ))}
          </div>
        </section>
  ) })
  pages.push({ key: 'takeaways', node: (
<aside className="rounded-xl border bg-muted/25 p-5">
        <Kicker>{t('In 30 seconds')}</Kicker>
        <ol className="mt-3 space-y-2.5">
          {a.takeaways.map((t, k) => (
            <li key={k} className="flex gap-3 text-[15px] leading-snug">
              <span className="font-serif text-lg leading-none font-semibold text-chart-up">{k + 1}</span>
              <span>{t}</span>
            </li>
          ))}
        </ol>
      </aside>
  ) })
  a.sections.forEach((s, k) => pages.push({ key: 'section' + k, node: (
        <section className="space-y-3">
          <Kicker>{s.kicker}</Kicker>
          <h3 className="font-serif text-2xl leading-tight font-semibold">{s.heading}</h3>
          <Paragraphs text={s.body} />
        </section>
  ) }))
  pages.push({ key: 'outlook', node: (
<section className="space-y-3 rounded-xl border border-chart-up/30 bg-chart-up/5 p-5">
        <div className="flex items-center gap-2"><Telescope className="size-4 text-chart-up" /><Kicker>{t("What's next")}</Kicker></div>
        <p className="text-[15px] leading-relaxed">{a.outlook.summary}</p>
        {a.outlook.items.length > 0 && (
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {a.outlook.items.map((o, k) => (
              <div key={k} className="flex items-baseline justify-between gap-3 border-b border-dashed py-1.5">
                <dt className="text-sm text-muted-foreground">{o.label}</dt>
                <dd className="text-sm font-semibold">{o.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
  ) })
  if (a.watchlist.length) pages.push({ key: 'watchlist', node: (
<section className="space-y-3">
          <Kicker>{t('Watch list')}</Kicker>
          <h3 className="font-serif text-2xl leading-tight font-semibold">{t('What to keep an eye on')}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {a.watchlist.map((w, k) => (
              <div key={k} className="space-y-1.5 rounded-xl border p-4">
                <div className="flex items-center gap-2 font-medium"><Eye className="size-4 text-amber-400" />{w.title}</div>
                <p className="text-sm leading-relaxed text-muted-foreground">{w.detail}</p>
              </div>
            ))}
          </div>
        </section>
  ) })
  return pages
}

/** The whole story on one scrolling page: headline, then each section, then the sources. */
function Story({ a, cover, end }: { a: Article; cover: React.ReactNode; end: React.ReactNode }) {
  return (
    <article className="space-y-10">
      {cover}
      {storySections(a).map(p => <div key={p.key}>{p.node}</div>)}
      {end}
    </article>
  )
}

/** Placeholder in the shape of a story (lede, quotes, metric cards, key points, a section) while it loads or is written. */
function StorySkeleton() {
  const lines = (widths: number[], h = 'h-4') => widths.map((w, k) => <Skeleton key={k} className={h} style={{ width: `${w}%` }} />)
  return (
    <div aria-hidden className="space-y-8">
      <div className="flex gap-3">
        <Skeleton className="size-14 shrink-0 rounded-md" />
        <div className="flex-1 space-y-2.5 pt-1">{lines([100, 96, 98])}</div>
      </div>
      <div className="-mt-5 space-y-2.5">{lines([97, 64])}</div>

      <section className="space-y-4">
        <Skeleton className="h-3 w-36" />
        {[0, 1].map(k => (
          <div key={k} className={cn('flex gap-4', k === 1 && 'flex-row-reverse')}>
            <Skeleton className="size-11 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2.5 rounded-2xl border px-5 py-4">
              <div className={cn('space-y-2', k === 1 && 'flex flex-col items-end')}>{lines([94, 70], 'h-5')}</div>
              <Skeleton className={cn('h-3 w-48', k === 1 && 'ml-auto')} />
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-7 w-80" />
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, k) => (
            <div key={k} className="space-y-2.5 rounded-xl border p-4">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-4 w-40" />
              {lines([95, 75], 'h-3')}
            </div>
          ))}
        </div>
      </section>

      <div className="space-y-3 rounded-xl border bg-muted/25 p-5">
        <Skeleton className="h-3 w-28" />
        {[88, 76, 82].map((w, k) => (
          <div key={k} className="flex items-center gap-3">
            <Skeleton className="size-4 shrink-0 rounded-sm" />
            <Skeleton className="h-4" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>

      <section className="space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-96 max-w-full" />
        <div className="space-y-2.5">{lines([100, 97, 99, 92, 58])}</div>
      </section>
    </div>
  )
}

function Body({ data, period, freq, company, onGenerate }: { data: MagazineResponse | null; period: Period; freq: Freq; company: Statements['company']; onGenerate: () => void }) {
  const ok = data?.ai.status === 'ok' ? (data.ai as Ok) : null
  const art = ok?.article
  const status = data?.ai.status
  const periodName = freq === 'q' ? period.label : t('fiscal {period}', { period: period.label })
  const header = (
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
          {art && (
            <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 tracking-normal normal-case">
              <span className={cn('size-2 rounded-full', MOOD[art.mood].dot)} />
              {t(MOOD[art.mood].label)}
            </span>
          )}
          <span>{company.ticker} · {periodName}</span>
        </div>
        {!data ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-28 rounded-full" />
            <Skeleton className="h-10 w-11/12" />
            <Skeleton className="h-10 w-3/5" />
            <div className="space-y-2 pt-1">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
            </div>
          </div>
        ) : (
          <>
            <h2 className="font-serif text-[40px] leading-[1.08] font-semibold tracking-tight text-balance">{art?.headline ?? t('{name} in {period}', { name: company.name, period: periodName })}</h2>
            {art && <p className="text-lg leading-relaxed text-pretty text-muted-foreground">{art.dek}</p>}
          </>
        )}
      </header>
  )
  const footer = data && (data.filing || data.release) && (
        <footer className="space-y-2 border-t pt-4 text-xs leading-relaxed text-muted-foreground">
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {data.release && (
              <a href={data.release.url} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:underline">
                {t('Earnings press release ({date})', { date: longDate(data.release.filed) })} <ExternalLink className="size-3.5" />
              </a>
            )}
            {data.filing && (
              <a href={data.filing.url} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:underline">
                {t('Full {form} ({date})', { form: data.filing.form, date: longDate(data.filing.filed) })} <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>
          {ok && (
            <p className="flex flex-wrap gap-x-2 rounded-md bg-muted/40 px-3 py-2">
              <span>{t('Generated {date} by {model}', { date: ok.createdAt ? longDate(ok.createdAt) : '', model: ok.model })}</span>
              {ok.usage && <span>· {t('{input}K tokens read, {output}K written', { input: Math.round(ok.usage.input_tokens / 1000), output: (ok.usage.output_tokens / 1000).toFixed(1) })}</span>}
              {ok.cost != null && <span>· {t('cost')} <span className="font-semibold text-foreground">${ok.cost.toFixed(2)}</span></span>}
              <span>· {t('saved, so opening it again costs nothing')}</span>
            </p>
          )}
          {ok && <p>{t("Written by Claude from the {sources}. Quotes, metrics and guidance are checked word for word against those sources, and anything that doesn't match is removed. AI can still make mistakes, so check anything important against the filing.", { sources: ok.sources.join(' and the ') })}</p>}
        </footer>
  )
  if (art) return <Story a={art} cover={header} end={footer} />
  return (
    <article className="space-y-8">
      {header}

      {status === 'generating' && (
        <div className="space-y-8">
          <div className="flex items-center gap-3 rounded-lg border border-chart-up/40 bg-chart-up/10 p-4 text-sm">
            <Loader2 className="size-4 shrink-0 animate-spin text-chart-up" />
            <span>{t("Generating the story. This takes about a minute. You can close this window; you'll get a notification when it's ready.")}</span>
          </div>
          <StorySkeleton />
        </div>
      )}

      {status === 'no-key' && (
        <div className="flex gap-3 rounded-lg border border-chart-up/40 bg-chart-up/10 p-4 text-sm">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-chart-up" />
          <div className="space-y-1">
            <div className="font-medium">{t('The story needs an Anthropic API key')}</div>
            <div className="text-muted-foreground">
              Save the key in a file named <code className="rounded bg-muted px-1">.anthropic-api-key</code> in the project folder (or set <code className="rounded bg-muted px-1">ANTHROPIC_API_KEY</code>) and reopen this page.
            </div>
          </div>
        </div>
      )}
      {(status === 'limit' || status === 'closed' || (status === 'none' && data?.free && (data.free.closed || (data.free.left != null && data.free.left <= 0)))) && (
        <div className="flex gap-3 rounded-lg border border-chart-up/40 bg-chart-up/10 p-4 text-sm">
          <Newspaper className="mt-0.5 size-4 shrink-0 text-chart-up" />
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="font-medium">
                {status === 'closed' || data?.free?.closed
                  ? t('New AI stories ended on {date}, to keep AI costs under control', { date: untilText(data!.free!.until) })
                  : t("You've used your {n} stories", { n: data?.free?.limit ?? 3 })}
              </div>
              <div className="text-muted-foreground">{t('Stories already written can still be read. Interested in a subscription to keep this feature? Join the waitlist.')}</div>
            </div>
            <Button size="sm" asChild>
              <a href={`mailto:${WAITLIST}?subject=${encodeURIComponent('Nothing But Fin: subscription waitlist')}`}><Mail className="size-3.5" /> {t('Join the waitlist')}</a>
            </Button>
            <div className="text-xs text-muted-foreground">{WAITLIST}</div>
          </div>
        </div>
      )}
      {status === 'error' && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
          <span>{(data!.ai as { message: string }).message || t('The story could not be generated.')}</span>
          <Button variant="outline" size="sm" onClick={onGenerate}><RotateCw className="size-3.5" /> {t('Try again')}</Button>
        </div>
      )}

      {!data && <StorySkeleton />}

      {footer}
    </article>
  )
}

// ------------------------------------------------------------ store
// Story states for the company on screen, background jobs (which may belong to another
// company by the time they finish) and the open story. Lives above the table so jobs keep
// being watched while you browse.
interface Target { ticker: string; freq: Freq; key: string; label: string; company: string; lang: Lang }
interface Store {
  states: Record<string, State>
  open: (key: string) => void
  start: (t: Target) => void
}
const Ctx = createContext<Store | null>(null)
// each language is its own story
const qs = (t: { ticker: string; freq: Freq; key?: string; lang: Lang }) => `ticker=${encodeURIComponent(t.ticker)}&freq=${t.freq}&lang=${t.lang}` + (t.key ? `&period=${encodeURIComponent(t.key)}` : '')

export function MagazineProvider({ ticker, freq, company, periods, onNavigate, children }: {
  ticker: string; freq: Freq; company: Statements['company']; periods: Period[]
  onNavigate: (ticker: string, freq: Freq) => void; children: React.ReactNode
}) {
  const { lang } = useLang()
  const [states, setStates] = useState<Record<string, State>>({})
  const [pending, setPending] = useState<Target[]>([])
  const [target, setTarget] = useState<Target | null>(null) // story to show (may wait for navigation)
  const [data, setData] = useState<MagazineResponse | null>(null)
  const pendingRef = useRef(pending)
  pendingRef.current = pending

  const same = (x: Target, y: Target) => x.ticker === y.ticker && x.freq === y.freq && x.key === y.key && x.lang === y.lang
  const tid = (t: Target) => `story-${t.ticker}-${t.freq}-${t.key}-${t.lang}` // one toast per story, updated in place
  const name = (t: Target) => `${t.company} · ${t.label}`
  const watch = (t: Target) => setPending(list => [...list.filter(x => !same(x, t)), t])
  const loading = (x: Target, note?: string) =>
    toast.loading(t('Generating {name} story…', { name: name(x) }), { id: tid(x), description: t('About a minute. Keep browsing; this updates when it’s ready.') + (note ? ' ' + note : ''), duration: Infinity })
  const ready = (x: Target) =>
    toast.success(t('{name} story is ready', { name: name(x) }), { id: tid(x), description: t('Saved, so you can open it again any time.'), duration: 20000, action: { label: t('Open'), onClick: () => show(x) } })
  const failed = (x: Target, message: string) =>
    toast.error(t('{name} story could not be generated', { name: name(x) }), { id: tid(x), description: message, duration: 20000, action: { label: t('Retry'), onClick: () => start(x) } })

  const loadStates = useCallback(async () => {
    try {
      const j = await (await fetch('api/magazine/status?' + qs({ ticker, freq, lang }))).json()
      const st: Record<string, State> = j.states || {}
      setStates(st)
      // stories still being written (e.g. after a reload): watch them and show their toast
      for (const [key, s] of Object.entries(st)) {
        const p = periods.find(x => x.key === key)
        if (s !== 'generating' || !p) continue
        const job = { ticker, freq, key, label: p.label, company: company.name, lang }
        if (!pendingRef.current.some(x => same(x, job))) { watch(job); loading(job) }
      }
    } catch { /* keep the last known states */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, freq, periods, lang])
  useEffect(() => { loadStates() }, [loadStates])
  useEffect(() => { setStates({}) }, [ticker, freq, lang])

  // watch background jobs every 3s; the job's toast turns into "ready" or "failed"
  useEffect(() => {
    if (!pending.length) return
    const timer = setInterval(async () => {
      const groups = [...new Set(pendingRef.current.map(p => p.ticker + '|' + p.freq + '|' + p.lang))]
      for (const g of groups) {
        const [tk, fq, lg] = g.split('|') as [string, Freq, Lang]
        let st: Record<string, State> = {}
        try { st = (await (await fetch('api/magazine/status?' + qs({ ticker: tk, freq: fq, lang: lg }))).json()).states || {} } catch { continue }
        if (tk === ticker && fq === freq && lg === lang) setStates(st)
        for (const p of pendingRef.current.filter(p => p.ticker === tk && p.freq === fq && p.lang === lg)) {
          if (st[p.key] === 'generating') continue
          setPending(list => list.filter(x => !same(x, p)))
          if (st[p.key] === 'ready') ready(p)
          else if (st[p.key] === 'none' || !st[p.key]) failed(p, t('Interrupted because the server restarted. Retry to generate it.'))
          else {
            let message = t('Something went wrong.')
            try { message = (await (await fetch('api/magazine?' + qs(p))).json()).ai?.message || message } catch { /* keep generic */ }
            failed(p, message)
          }
        }
      }
    }, 3000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.length, ticker, freq, lang])

  const show = (t: Target) => {
    if (t.ticker !== ticker || t.freq !== freq) onNavigate(t.ticker, t.freq)
    setData(null)
    setTarget(t)
  }
  /** Icon click: open a ready story; otherwise start writing it (or re-show its progress). */
  const open = (key: string) => {
    const p = periods.find(x => x.key === key)
    if (!p) return
    const story = { ticker, freq, key, label: p.label, company: company.name, lang }
    const s = states[key]
    if (s === 'ready') show(story)
    else if (s === 'generating') loading(story)
    else start(story)
  }
  const start = async (x: Target) => {
    loading(x)
    setStates(s => (x.ticker === ticker && x.freq === freq && x.lang === lang ? { ...s, [x.key]: 'generating' } : s))
    try {
      const j = await (await fetch('api/magazine?' + qs(x), { method: 'POST', headers: visitorHeaders() })).json()
      const status = j.ai?.status
      if (status === 'limit' || status === 'closed') {
        toast.dismiss(tid(x)) // no story is being written: the window explains why
        show(x)
        loadStates()
        return
      }
      if (status === 'generating' && j.free && !j.free.closed) loading(x, freeNote(j.free))
      if (status === 'generating') watch(x)
      else if (status === 'ok') ready(x) // already saved
      else if (status === 'no-key') failed(x, 'Add an Anthropic API key: save it in .anthropic-api-key in the project folder.')
      else failed(x, j.ai?.message || j.error || t('Something went wrong.'))
      if (status !== 'generating') loadStates()
    } catch {
      failed(x, t('Could not reach the server.'))
      loadStates()
    }
  }

  // load the open story (once the table for its company is on screen)
  const visible = target && target.ticker === ticker && target.freq === freq && target.lang === lang ? target : null
  useEffect(() => {
    if (!visible || data) return
    const ctl = new AbortController()
    fetch('api/magazine?' + qs(visible) + '&open=1', { signal: ctl.signal, headers: visitorHeaders() }) // counted as a read
      .then(r => r.json())
      .then(j => setData(j.ai ? j : { filing: null, release: null, ai: { status: 'error', message: j.error || t('Could not load the story.') } }))
      .catch(e => e.name !== 'AbortError' && setData({ filing: null, release: null, ai: { status: 'error', message: t('Could not reach the server.') } }))
    return () => ctl.abort()
  }, [visible, data])

  const period = visible ? periods.find(p => p.key === visible.key) : undefined
  return (
    <Ctx.Provider value={{ states, open, start }}>
      {children}
      <Dialog open={!!(visible && period)} onOpenChange={o => { if (!o) { setTarget(null); setData(null) } }}>
        {visible && period && (
          <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[760px]" /* centred; scrolls inside when the story is taller than 88% of the screen */>
            <div className="flex shrink-0 items-center justify-between border-b bg-background px-8 py-3">
              <DialogTitle className="font-serif text-lg font-semibold tracking-tight italic">The Quarterly</DialogTitle>
              <DialogDescription className="pr-8 text-xs text-muted-foreground">{company.name} · {period.label}</DialogDescription>
            </div>
            {data?.free && !data.free.closed && (
              <div className="shrink-0 border-b bg-chart-up/10 px-8 py-2 text-xs leading-relaxed text-muted-foreground">
                {t('New AI stories are available until {date}, to keep AI costs under control. Want to keep this feature with a subscription?', { date: untilText(data.free.until) })}{' '}
                <a href={`mailto:${WAITLIST}?subject=${encodeURIComponent('Nothing But Fin: subscription waitlist')}`} className="font-medium whitespace-nowrap text-chart-up hover:underline">{t('Join the waitlist')}</a>
              </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 pt-6">
              <Body data={data} period={period} freq={freq} company={company} onGenerate={() => start(visible)} />
            </div>
          </DialogContent>
        )}
      </Dialog>
    </Ctx.Provider>
  )
}

const ICON: Record<State, { cls: string; title: string }> = { // titles are translated where shown
  none: { cls: 'text-muted-foreground/60 hover:text-foreground', title: 'No story yet: click to generate (about $0.15–0.35)' },
  generating: { cls: 'text-chart-up', title: 'Generating story… (about a minute)' },
  ready: { cls: 'text-chart-up hover:text-chart-up', title: 'Read the story' },
  error: { cls: 'text-negative', title: 'The story could not be generated: click to try again' },
}

/** Magazine icon on a period header; its look shows the story state. */
export function MagazineIcon({ period }: { period: Period }) {
  const ctx = useContext(Ctx)
  if (!ctx) return null
  const state = ctx.states[period.key]
  if (!state) return null // no filing for this period
  const { cls } = ICON[state]
  const title = t(ICON[state].title)
  return (
    <Button variant="ghost" size="icon" className={cn('relative size-6', cls)} aria-label={`${title} (${period.label})`} title={`${period.label}: ${title}`} onClick={() => ctx.open(period.key)}>
      {state === 'generating' ? <Loader2 className="size-3.5 animate-spin" /> : <Newspaper className="size-3.5" />}
      {(state === 'ready' || state === 'error') && <span className={cn('absolute top-0.5 right-0.5 size-1.5 rounded-full', state === 'ready' ? 'bg-chart-up' : 'bg-negative')} />}
    </Button>
  )
}


