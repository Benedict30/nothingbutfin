import { fmt, pct } from './format'
import { itemName, t } from './i18n'
import { modeShown, type Mode } from './prefs'
import type { Block, Freq, Period, StatementKey } from './types'

export type Tone = 'pos' | 'neg' | 'flat' | 'none' | 'info'
export interface Sub { text: string; tone: Tone }
export interface Cell { main: string; value: number | null; empty: boolean; subs: Sub[]; src: string | null }
export interface HistPoint { label: string; value: number | null; prev: number | null; yearAgo: number | null }
export interface ViewRow { key: string; name: string; total: boolean; unit?: string; subLabels: string[]; cells: Cell[]; spark: (number | null)[]; hist: HistPoint[] }

const tone = (v: number | null): Tone => (v == null ? 'none' : Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'pos' : 'neg')

/**
 * Rows of one statement for the given periods (indexes into block.periods), with growth sub-lines.
 * `estimates` (period key → analysts' revenue estimate) adds "Analyst estimate" and "Surprise"
 * lines under Total Revenue.
 */
export function buildRows(block: Block, tab: StatementKey, freq: Freq, modes: Mode[], idx: number[], estimates?: Record<string, number> | null): ViewRow[] {
  const all = block.periods
  const isQ = freq === 'q'
  // previous-period lookup by fiscal key (robust to gaps)
  const ix = new Map(all.map((p, i) => [isQ ? p.fy + 'Q' + p.q : 'FY' + p.fy, i]))
  const prevQ = (p: Period) => (p.q! > 1 ? p.fy + 'Q' + (p.q! - 1) : p.fy - 1 + 'Q4')
  const prevY = (p: Period) => (isQ ? p.fy - 1 + 'Q' + p.q : 'FY' + (p.fy - 1))
  // the annual TTM column (trailing twelve months) compares with the TTM a year earlier
  const yearAgo = (row: Block['statements'][StatementKey]['rows'][number], p: Period, at: (k: string) => number | null) =>
    p.key === 'TTM' ? (row.ttmYearAgo ?? null) : at(prevY(p))
  const off = Math.max(0, all.findIndex(p => !['TTM', 'PROJ', 'PROJQ'].includes(p.key))) // charts skip TTM and projections: not reported periods
  const on = (m: Mode) => modes.includes(m) && modeShown(m, freq)
  const subLabels = (['qoq', 'qoqp', 'yoy', 'yoyp'] as Mode[]).filter(on).map(m => t({ qoq: 'QoQ Growth', qoqp: 'QoQ Growth %', yoy: 'YoY Growth', yoyp: 'YoY Growth %' }[m]))

  const withEstimate = (key: string) => key === 'revenue' && !!estimates && Object.keys(estimates).length > 0

  return block.statements[tab].rows
    .filter(r => idx.some(i => r.vals[i] != null))
    .map(row => {
      const at = (key: string) => {
        const i = ix.get(key)
        return i == null ? null : row.vals[i]
      }
      const cells = idx.map(i => {
        const p = all[i], v = row.vals[i]
        const subs: Sub[] = []
        const abs = (pv: number | null) => {
          const d = v == null || pv == null ? null : v - pv
          subs.push({ text: d == null ? '—' : fmt(d), tone: tone(d) })
        }
        const rel = (pv: number | null) => {
          const g = pct(v, pv)
          subs.push({ text: g == null ? '—' : fmt(g) + '%', tone: tone(g) })
        }
        if (on('qoq')) abs(at(prevQ(p)))
        if (on('qoqp')) rel(at(prevQ(p)))
        if (on('yoy')) abs(yearAgo(row, p, at))
        if (on('yoyp')) rel(yearAgo(row, p, at))
        if (withEstimate(row.key)) {
          const e = estimates![p.key] ?? null
          subs.push({ text: e == null ? '—' : fmt(e), tone: 'none' }) // a reference figure: quiet grey, so the surprise stands out
          if (p.projected) {
            // the projection against the analysts' estimate, in the same form as a surprise; blue, as
            // two forecasts differing is neither a beat nor a miss (the column's tooltip says so)
            const d = e == null || v == null ? null : v - e
            subs.push({ text: d == null ? '—' : `${fmt(d)} (${fmt((d / e!) * 100)}%)`, tone: 'info' })
          } else {
            // the surprise: what was reported against what analysts expected
            const d = e == null || v == null ? null : v - e
            subs.push({ text: d == null ? '—' : `${fmt(d)} (${fmt((d / e!) * 100)}%)`, tone: tone(d) })
          }
        }
        return { main: v == null ? '—' : fmt(v), value: v, empty: v == null, subs, src: row.src?.[i] ?? null }
      })
      // sparkline + chart popover: the 20 most recent periods, oldest → newest
      const hist = all.slice(off, off + 20).map((p, i) => ({ label: p.label, value: row.vals[i + off], prev: at(isQ ? prevQ(p) : prevY(p)), yearAgo: at(prevY(p)) })).reverse()
      const labels = withEstimate(row.key) ? [...subLabels, t('Analyst estimate'), t('Surprise')] : subLabels
      return { key: row.key, name: itemName(row.key, row.name), total: !!row.total, unit: row.unit, subLabels: labels, cells, spark: row.vals.slice(off, off + 20).reverse(), hist }
    })
}
