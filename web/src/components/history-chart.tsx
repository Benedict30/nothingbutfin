import { useState } from 'react'
import { fmt, pct } from '@/lib/format'
import { t as tr } from '@/lib/i18n'
import type { HistPoint } from '@/lib/view-model'
import { cn } from '@/lib/utils'

const W = 420, H = 168, PAD_L = 44, PAD_B = 22, PAD_T = 8

// clean axis ticks (1 / 2 / 2.5 / 5 × 10^n), compact from 1,000 up
function ticks(lo: number, hi: number) {
  const span = hi - lo || Math.abs(hi) || 1
  const raw = span / 4, mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw)!
  const out: number[] = []
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12))
  return out
}
const compact = (v: number) => {
  const a = Math.abs(v)
  if (a >= 1e6) return +(v / 1e6).toFixed(1) + 'M'
  if (a >= 1e3) return +(v / 1e3).toFixed(1) + 'K'
  return String(+v.toFixed(2))
}

function Growth({ label, value }: { label: string; value: number | null }) {
  if (value == null) return null
  return (
    <span className="text-muted-foreground">
      <span className={value > 0 ? 'text-positive' : value < 0 ? 'text-negative' : 'text-foreground'}>{(value > 0 ? '+' : '') + fmt(value)}%</span> {label}
    </span>
  )
}

/** Larger bar chart of a line item's recent history; hover, tap or arrow keys pick a bar. */
export function HistoryChart({ points, isQ }: { points: HistPoint[]; isQ: boolean }) {
  const lastIdx = points.length - 1
  const [sel, setSel] = useState(lastIdx)
  const nums = points.map(p => p.value).filter((v): v is number => v != null)
  const t = ticks(Math.min(0, ...nums), Math.max(0, ...nums))
  const lo = t[0], hi = t[t.length - 1]
  const y = (v: number) => PAD_T + ((hi - v) / (hi - lo || 1)) * (H - PAD_T - PAD_B)
  const band = (W - PAD_L) / points.length
  const bw = Math.min(24, band - 2) // ≤24px bars with at least a 2px gap
  const p = points[sel]
  const r = 4

  return (
    <div className="space-y-2">
      <div className="flex min-h-5 flex-wrap items-baseline gap-x-3 text-sm">
        <span className="font-medium">{p.label}</span>
        <span className="font-semibold">{p.value == null ? '—' : fmt(p.value)}</span>
        {isQ && <Growth label={tr('QoQ')} value={pct(p.value, p.prev)} />}
        <Growth label={tr('YoY')} value={pct(p.value, p.yearAgo)} />
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={tr('Bar chart, {from} to {to}', { from: points[0].label, to: points[lastIdx].label })}
        tabIndex={0}
        className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onKeyDown={e => {
          if (e.key === 'ArrowLeft') setSel(i => Math.max(0, i - 1))
          if (e.key === 'ArrowRight') setSel(i => Math.min(lastIdx, i + 1))
        }}
        onPointerLeave={e => e.pointerType === 'mouse' && setSel(lastIdx)}
      >
        {t.map(v => (
          <g key={v}>
            <line x1={PAD_L} x2={W} y1={y(v)} y2={y(v)} className={v === 0 ? 'stroke-muted-foreground/50' : 'stroke-border'} strokeWidth={1} shapeRendering="crispEdges" />
            <text x={PAD_L - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
              {compact(v)}
            </text>
          </g>
        ))}
        {points.map((pt, i) => {
          const x = PAD_L + i * band + (band - bw) / 2
          const hit = <rect x={PAD_L + i * band} y={0} width={band} height={H - PAD_B} fill="transparent" onPointerEnter={() => setSel(i)} onPointerDown={() => setSel(i)} />
          if (pt.value == null) return <g key={i}>{hit}</g>
          const y0 = y(0), y1 = y(pt.value), h = Math.abs(y1 - y0)
          const rr = Math.min(r, h, bw / 2)
          // rounded at the data end, square at the baseline
          const d = pt.value >= 0
            ? `M${x},${y0} V${y1 + rr} Q${x},${y1} ${x + rr},${y1} H${x + bw - rr} Q${x + bw},${y1} ${x + bw},${y1 + rr} V${y0} Z`
            : `M${x},${y0} V${y1 - rr} Q${x},${y1} ${x + rr},${y1} H${x + bw - rr} Q${x + bw},${y1} ${x + bw},${y1 - rr} V${y0} Z`
          return (
            <g key={i}>
              <path d={d} className={cn(pt.value >= 0 ? 'fill-chart-up' : 'fill-chart-down', 'transition-opacity', i === sel ? 'opacity-100' : 'opacity-55')} />
              {hit}
            </g>
          )
        })}
        {[0, Math.floor(lastIdx / 2), lastIdx].map((i, k) => (
          <text key={i} x={k === 0 ? PAD_L : k === 2 ? W : PAD_L + i * band + band / 2} y={H - 6} textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'} className="fill-muted-foreground text-[11px]">
            {points[i].label}
          </text>
        ))}
      </svg>
    </div>
  )
}
