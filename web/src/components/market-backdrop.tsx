import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { date, longDate, t, useLang } from '@/lib/i18n'

interface Macro {
  months: string[]
  sp500?: (number | null)[] // absent from a copy cached before it was added
  pe?: (number | null)[] // the S&P 500's price/earnings ratio; absent when its earnings have never been read
  fed: (number | null)[]
  yield10: (number | null)[]
  inflation: (number | null)[]
  // with the P/E only: earningsTo (the month the last four quarters of earnings end), average (of the months
  // shown) and earningsYield (the same ratio upside down, as a %)
  latest: Partial<Record<Key, { value: number; date: string; earningsTo?: string; average?: number; earningsYield?: number } | null>>
  schedule?: { fedLast: string | null; fedNext: string | null; pceNext: string | null }
  source: string
  earningsSource?: string
}
type Key = 'sp500' | 'pe' | 'fed' | 'yield10' | 'inflation'
interface Line { key: Key; name: string; color: string }

const RATES: Line[] = [
  { key: 'fed', name: 'Fed rate', color: '#22c55e' },
  { key: 'yield10', name: '10-yr yield', color: 'var(--chart-up)' },
  { key: 'inflation', name: 'Core inflation', color: '#f59e0b' },
]
const SP500: Line[] = [{ key: 'sp500', name: 'S&P 500', color: '#38bdf8' }]
const PE: Line[] = [{ key: 'pe', name: 'P/E ratio', color: '#ec4899' }]
const pctFmt = (v: number) => v.toFixed(2) + '%'
const peFmt = (v: number) => v.toFixed(1)
const ptsFmt = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 })

const WHY = 'space-y-1 border-t pt-3 text-sm leading-relaxed text-muted-foreground' // the notes under a chart, inside its card
const W = 760, PL = 52, PR = 150, PT = 12, PB = 26 // PL fits a 6-character axis label such as "10,000"
/**
 * A line chart with each line labelled at its end (name and value, in its colour), no legend to look up.
 * Hovering (or dragging on a phone) moves a marker across both charts and the labels show that month.
 */
function LineChart({ d, lines, fmt, tick, height, hover, onHover, note, step: fixedStep, reference }: {
  d: Macro; lines: Line[]; fmt: (v: number) => string; tick: (v: number) => string; height: number
  step?: number // the gap between gridlines (otherwise 1, or 20 for values above 20)
  reference?: { value: number; label: string } // a dashed level across the chart to read the line against (its average)
  hover: number | null; onHover: (i: number | null) => void
  note: (key: Key, month: string) => string // the small grey line under an end-of-line label (its month, what's next)
}) {
  const vals = (k: Key) => d[k] ?? []
  lines = lines.filter(l => Array.isArray(d[l.key])) // a series the server didn't send is left out
  const n = d.months.length, H = height
  const x = (i: number) => PL + (i / (n - 1)) * (W - PL - PR)
  const all = lines.flatMap(l => vals(l.key)).filter((v): v is number => v != null)
  if (!all.length) return null
  const step = fixedStep ?? (Math.max(...all) > 20 ? 20 : 1)
  const max = Math.ceil(Math.max(...all) / step) * step, min = Math.min(0, Math.floor(Math.min(...all) / step) * step)
  const y = (v: number) => PT + (1 - (v - min) / (max - min)) * (H - PT - PB)
  const ticks: number[] = []
  for (let v = min; v <= max; v += step) ticks.push(v)
  const shownTicks = ticks.length > 8 ? ticks.filter((_, i) => i % 2 === 0) : ticks
  const path = (vals: (number | null)[]) => vals.map((v, i) => (v == null ? '' : `${i && vals[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join('')
  // each line's label: at the hovered month, or at its last value; nudged apart so they never overlap
  const at = (vals: (number | null)[]) => {
    if (hover != null) return vals[hover] != null ? hover : null
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return i
    return null
  }
  const labels = lines.map(l => ({ l, i: at(vals(l.key)) })).filter((v): v is { l: Line; i: number } => v.i != null)
    .map(({ l, i }) => ({ l, i, v: vals(l.key)[i]!, ly: y(vals(l.key)[i]!) }))
    .sort((a, b) => a.ly - b.ly)
  for (let k = 1; k < labels.length; k++) labels[k].ly = Math.max(labels[k].ly, labels[k - 1].ly + (hover == null ? 46 : 40))
  const years = d.months.map((m, i) => [m, i] as const).filter(([m]) => m.endsWith('-01'))
  // the hovered month's pill on the x axis, under the crosshair (kept inside the plot), as wide as its text (CJK characters
  // are wider); a year label it would cover or touch is left out
  const pillText = hover == null ? '' : date(d.months[hover] + '-01', { month: 'short', year: 'numeric' })
  const pillW = [...pillText].reduce((w, c) => w + (c > '\u2e7f' ? 12 : c === ' ' ? 3.5 : 7.4), 12)
  const pillX = hover == null ? null : Math.min(Math.max(x(hover), PL + pillW / 2), W - PR - pillW / 2)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full touch-none select-none" onPointerLeave={() => onHover(null)}
      onPointerMove={e => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
        const i = Math.round(((((e.clientX - r.left) / r.width) * W - PL) / (W - PL - PR)) * (n - 1))
        onHover(i < 0 || i > n - 1 ? null : i)
      }}>
      {shownTicks.map(v => (
        <g key={v}>
          <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} />
          <text x={PL - 8} y={y(v) + 4} textAnchor="end" className="fill-muted-foreground text-[12px]">{tick(v)}</text>
        </g>
      ))}
      {years.map(([m, i]) => (pillX == null || Math.abs(x(i) - pillX) > pillW / 2 + 19) && <text key={m} x={x(i)} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[12px]">{m.slice(0, 4)}</text>)}
      {reference && (
        <g>
          <line x1={PL} x2={W - PR} y1={y(reference.value)} y2={y(reference.value)} className="stroke-muted-foreground" strokeDasharray="5 4" />
          <text x={PL + 6} y={y(reference.value) - 6} className="fill-muted-foreground text-[11px]">{reference.label}</text>
        </g>
      )}
      {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PT} y2={H - PB} className="stroke-muted-foreground" strokeDasharray="3 3" />}
      {lines.map(l => <path key={l.key} d={path(vals(l.key))} fill="none" stroke={l.color} strokeWidth={2.25} strokeLinejoin="round" />)}
      {hover != null && pillX != null && (
        <g>
          <rect x={pillX - pillW / 2} y={H - PB + 2} width={pillW} height={22} rx={5} className="fill-foreground" />
          <text x={pillX} y={H - 8} textAnchor="middle" className="fill-background text-[12px] font-semibold">{pillText}</text>
        </g>
      )}
      {labels.map(({ l, i, v, ly }) => {
        // at the end of the line, in the right margin; while hovering, beside the point (left of it near the right edge)
        const left = hover != null && x(i) > W - PR - 140
        const lx = hover == null ? W - PR + 14 : left ? x(i) - 12 : x(i) + 12
        const anchor = left ? 'end' : 'start'
        return (
          <g key={l.key}>
            <circle cx={x(i)} cy={y(v)} r={4} fill={l.color} className="stroke-background" strokeWidth={2} />
            {/* a thin leader from the point to its label when the label had to move */}
            {hover == null && <line x1={x(i) + 6} x2={W - PR + 10} y1={y(v)} y2={ly} stroke={l.color} strokeOpacity={0.35} />}
            {/* while hovering, a backing so the label reads over the lines, which still show faintly through it */}
            {hover != null && (() => {
              const w = Math.max(t(l.name).length * 6.8, fmt(v).length * 8.6) + 14
              return <rect x={left ? lx - w + 6 : lx - 7} y={ly - 16} width={w} height={36} rx={6} className="fill-card stroke-border" fillOpacity={0.82} strokeWidth={1} />
            })()}
            <text x={lx} y={ly - 2} textAnchor={anchor} fill={l.color} className="text-[12px] font-medium">{t(l.name)}</text>
            <text x={lx} y={ly + 14} textAnchor={anchor} className="fill-foreground text-[14px] font-semibold">{fmt(v)}</text>
            {hover == null && <text x={lx} y={ly + 28} className="fill-muted-foreground text-[11px]">{note(l.key, d.months[i])}</text>}
          </g>
        )
      })}
    </svg>
  )
}

/** The market page: the S&P 500, and the forces that move the whole market (interest rates, inflation and oil). */
export function MarketPage({ back }: { back: { label: string; onClick: () => void } }) {
  useLang()
  const [d, setD] = useState<Macro | null>(null)
  const [failed, setFailed] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    fetch('api/macro').then(r => (r.ok ? r.json() : Promise.reject())).then(setD, () => setFailed(true))
  }, [])
  const sched = d?.schedule
  const day = (iso: string) => date(iso, { month: 'short', day: 'numeric' })
  const month = (m: string) => date(m + '-01', { month: 'short', year: 'numeric' })
  const note = (k: Key, m: string) => {
    const l = d?.latest[k]
    if (k === 'fed' && sched?.fedNext) return t('Next decision {date}', { date: day(sched.fedNext) })
    if (k === 'inflation') return sched?.pceNext ? t('{month} · next {date}', { month: month(m), date: day(sched.pceNext) }) : month(m)
    if (k === 'pe') return l?.earningsTo ? t('Earnings to {month}', { month: month(l.earningsTo) }) : month(m) // earnings trail the price
    if (l && l.date.slice(0, 7) === m) return longDate(l.date) // the line ends at the latest day's value, not a month's average
    return t('{month} average', { month: month(m) })
  }
  const latest = (k: Key, f: (v: number) => string) => {
    const l = d?.latest[k]
    return l ? <><span className="font-semibold text-foreground">{f(l.value)}</span> <span className="text-xs">({k === 'inflation' ? date(l.date, { month: 'short', year: 'numeric' }) : longDate(l.date)})</span></> : '—'
  }
  const pe = d?.pe ? d.latest.pe : null // the S&P 500's P/E now, when there is one
  const bond = d?.latest.yield10
  return (
    <div className="flex flex-col gap-6">
      <button type="button" onClick={back.onClick} className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> {back.label}
      </button>
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{t('Market')}</h1>
        <p className="mt-1 text-muted-foreground">{t('The S&P 500, how expensive it is, and the forces that move the whole market: interest rates and inflation. Monthly, last 10 years.')}</p>
      </div>
      {failed ? <p className="text-sm text-muted-foreground">{t('Could not reach the server.')}</p>
        : !d ? <div className="space-y-4"><Skeleton className="h-[300px] w-full rounded-xl" /><Skeleton className="h-[200px] w-full rounded-xl" /></div>
        : <>
          <div className="min-h-5 text-sm text-muted-foreground">
            {t('Monthly averages for prices and yields; each line ends at its latest value. Point at a chart, or drag across it, for any month.')}
          </div>
          {/* each chart's card ends with what its lines are and why they matter */}
          {d.sp500 && (
            <section className="space-y-2 rounded-xl border bg-card p-4">
              <h2 className="font-semibold">{t('S&P 500')}</h2>
              <LineChart d={d} lines={SP500} fmt={ptsFmt} tick={ptsFmt} step={1000} height={220} hover={hover} onHover={setHover} note={note} />
              <div className={WHY}>
                <p><span className="font-medium text-foreground">{t('S&P 500')}</span> {latest('sp500', ptsFmt)}: {t('the 500 largest US companies, the usual measure of "the market"; when it falls, most stocks fall with it.')}</p>
              </div>
            </section>
          )}
          {pe && (
            <section className="space-y-2 rounded-xl border bg-card p-4">
              <h2 className="font-semibold">{t("Valuation: the S&P 500's P/E ratio")}</h2>
              <LineChart d={d} lines={PE} fmt={peFmt} tick={v => String(v)} step={10} height={220} hover={hover} onHover={setHover} note={note}
                reference={pe.average != null ? { value: pe.average, label: t('10-year average {value}', { value: peFmt(pe.average) }) } : undefined} />
              <div className={WHY}>
                <p><span className="font-medium text-foreground">{t('P/E ratio')}</span> <span className="font-semibold text-foreground">{peFmt(pe.value)}</span>
                  {' '}<span className="text-xs">({pe.earningsTo ? t('{date} · earnings to {month}', { date: longDate(pe.date), month: month(pe.earningsTo) }) : longDate(pe.date)})</span>
                  : {t("the S&P 500's price divided by its companies' profit per share over the last four quarters: what investors pay for $1 of yearly profit. Higher is more expensive.")}
                  {pe.earningsYield != null && bond && <> {t('Turned over, it is an earnings yield of {yield}, against the {bond} a 10-year Treasury pays.', { yield: pctFmt(pe.earningsYield), bond: pctFmt(bond.value) })}</>}</p>
              </div>
            </section>
          )}
          <section className="space-y-2 rounded-xl border bg-card p-4">
            <h2 className="font-semibold">{t('Interest rates and inflation')}</h2>
            <LineChart d={d} lines={RATES} fmt={pctFmt} tick={v => v + '%'} height={300} hover={hover} onHover={setHover} note={note} />
            <div className={WHY}>
              <p><span className="font-medium text-foreground">{t('Fed rate')}</span> {latest('fed', pctFmt)}
                {sched?.fedNext && <> · {sched.fedLast && t('last decision {date}', { date: day(sched.fedLast) }) + ' · '}<span className="font-medium text-foreground">{t('next decision {date}', { date: day(sched.fedNext) })}</span></>}
                : {t("set by the Federal Reserve at its meetings; it sets what cash and short-term loans earn.")}</p>
              <p><span className="font-medium text-foreground">{t('10-yr yield')}</span> {latest('yield10', pctFmt)}: {t('set by investors every day; when it rises, stocks (growth stocks most) tend to fall, and mortgages get dearer.')}</p>
              <p><span className="font-medium text-foreground">{t('Core inflation')}</span> {latest('inflation', pctFmt)}
                {sched?.pceNext && <> · <span className="font-medium text-foreground">{t('next report {date}', { date: day(sched.pceNext) })}</span></>}
                : {t("the Fed's preferred measure (PCE, excluding food and energy); its target is 2%, and above it rates tend to stay high.")}</p>
            </div>
          </section>
          <p className="text-xs text-muted-foreground">{t('Source')}: <a href="https://fred.stlouisfed.org" target="_blank" rel="noopener" className="underline underline-offset-4">{d.source}</a>
            {pe && d.earningsSource && <> · {t('S&P 500 earnings')}: <a href="https://shillerdata.com" target="_blank" rel="noopener" className="underline underline-offset-4">{d.earningsSource}</a></>}</p>
        </>}
    </div>
  )
}
