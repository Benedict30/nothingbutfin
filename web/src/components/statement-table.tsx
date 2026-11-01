import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, ExternalLink, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HistoryChart } from '@/components/history-chart'
import { TipCard } from '@/components/tip-card'
import { DEFINITIONS } from '@/lib/definitions'
import { MagazineIcon } from '@/components/magazine'
import { Sparkline } from '@/components/sparkline'
import { fmt, pct } from '@/lib/format'
import { currencyName, longDate, shortDate, t, useLang } from '@/lib/i18n'
import { buildRows, type Tone, type ViewRow } from '@/lib/view-model'
import { KEY_ROWS, type Mode } from '@/lib/prefs'
import type { Block, Freq, Period, Reported, StatementKey, Statements } from '@/lib/types'
import { cn } from '@/lib/utils'

const LABEL_W = 264, SPARK_W = 88, NAV_W = 48, PAD_X = 32, MIN_COL = 104
const FONT_MAIN = '400 14px "Geist Variable"', FONT_SUB = '400 13px "Geist Variable"', FONT_HEAD = '500 13px "Geist Variable"'

const toneClass: Record<Tone, string> = { pos: 'text-positive', neg: 'text-negative', flat: 'text-foreground', none: 'text-muted-foreground', info: 'text-chart-up' }

// Width of a string in the table font, so columns are sized to their figures.
const ctx = document.createElement('canvas').getContext('2d')!
const textW = (s: string, font: string) => {
  ctx.font = font
  return ctx.measureText(s).width
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    if (ref.current) ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

interface Props {
  block: Block
  tab: StatementKey
  freq: Freq
  modes: Mode[]
  units: Statements['units']
  reported: Record<string, Reported>
  estimates?: Record<string, number> | null // analysts' revenue estimate by period key
  keyOnly: boolean // only the statement's key rows; the bar under the table shows the rest
  onKeyOnly: (on: boolean) => void
  extra: number // periods shown beyond (or, if negative, short of) what fits the screen
  onExtra: (n: number) => void
}

// Line-item and sparkline columns stay pinned while the periods scroll (the sparkline
// column overlaps by 1px so no hairline gap shows when scaled); they need an
// opaque background that still follows the row's total / hover / selected shading.
const pinned = (total: boolean) =>
  cn(
    'sticky z-[1]',
    total ? 'bg-[color-mix(in_oklab,var(--card),var(--muted)_30%)]' : 'bg-card',
    'group-hover:bg-[color-mix(in_oklab,var(--card),var(--muted)_50%)] group-data-[state=selected]:bg-muted',
  )

/**
 * Opens with as many periods as fit the width. The full-height column on the right adds
 * the previous period; once they no longer fit, the periods scroll sideways while the
 * line-item names stay pinned. Only the oldest period can be removed, so the columns
 * always run unbroken from the newest period back.
 */
export function StatementTable({ block, tab, freq, modes, units, reported, estimates, keyOnly, onKeyOnly, extra, onExtra }: Props) {
  const { lang } = useLang()
  const [ref, width] = useWidth<HTMLDivElement>()
  const [fontsReady, setFontsReady] = useState(false)
  useEffect(() => {
    document.fonts.ready.then(() => setFontsReady(true))
  }, [])

  const all = block.periods
  const candidates = useMemo(() => all.map((_, i) => i), [all])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const built = useMemo(() => buildRows(block, tab, freq, modes, candidates, estimates), [block, tab, freq, modes, candidates, estimates, lang])
  const allRows = useMemo(() => (keyOnly ? built.filter(r => KEY_ROWS[tab].includes(r.key)) : built), [built, keyOnly, tab])
  const folded = built.length - built.filter(r => KEY_ROWS[tab].includes(r.key)).length
  // folding shortens the page: keep the bar where it was on screen, so the tap doesn't land on the footer
  const foldBar = useRef<HTMLButtonElement>(null)
  const foldTop = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (foldTop.current == null || !foldBar.current) return
    window.scrollBy(0, foldBar.current.getBoundingClientRect().top - foldTop.current)
    foldTop.current = null
  }, [keyOnly])

  // width each candidate period needs: widest figure / growth line / header label
  const need = useMemo(
    () =>
      candidates.map((i, j) => {
        let w = textW(all[i].label + (all[i].projected ? ' ' + t('proj.') : ''), FONT_HEAD) + 30 + (all[i].preliminary ? 12 : 0) // room for the magazine icon (and the preliminary dot)
        w = Math.max(w, textW(shortDate(all[i].end), FONT_MAIN))
        for (const r of allRows) {
          const c = r.cells[j]
          w = Math.max(w, textW(c.main, FONT_MAIN), ...c.subs.map(s => textW(s.text, FONT_SUB)))
        }
        return Math.max(MIN_COL, Math.ceil(w + PAD_X))
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, allRows, fontsReady],
  )

  // how many periods fit without scrolling, plus any the user added
  const avail = width - LABEL_W - SPARK_W - NAV_W
  let fit = 0, used = 0
  while (fit < candidates.length && used + need[fit] <= avail) used += need[fit++]
  const base = Math.max(1, fit)
  const k = Math.max(1, Math.min(candidates.length, base + extra))
  // a short fade for an added period (columns from `cols` on); cleared once things settle, so loading
  // a company or switching tabs doesn't animate
  const motion = useRef({ cols: Infinity })
  useEffect(() => {
    const id = setTimeout(() => { motion.current = { cols: Infinity } }, 500)
    return () => clearTimeout(id)
  })
  const fadeCol = (j: number) => j >= motion.current.cols && 'animate-in fade-in-0 duration-300'
  const older = k < candidates.length
  const vis = candidates.slice(0, k).map(i => all[i])
  const rows = allRows
    .map(r => ({ ...r, cells: r.cells.slice(0, k) }))
    .filter(r => r.cells.some(c => !c.empty))
  const viewW = width
  const tableW = LABEL_W + SPARK_W + need.slice(0, k).reduce((a, b) => a + b, 0) + (older ? NAV_W : 0)
  const scrolls = tableW > viewW

  // edge fades + scroll to the newly added period
  const scroller = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const onScroll = () => {
    const el = scroller.current
    if (el) setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 })
  }
  useEffect(onScroll, [tableW, viewW])
  const prevExtra = useRef(extra)
  useEffect(() => {
    if (extra > prevExtra.current) scroller.current?.scrollTo({ left: scroller.current.scrollWidth, behavior: 'smooth' })
    prevExtra.current = extra
  }, [extra])

  // ---- spreadsheet-style cell selection: click, drag, shift-click, ⌘/ctrl-click, or a row name.
  // A status bar fixed at the bottom right shows the count, sum and average.
  const cellId = (r: number, c: number) => r + ':' + c
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const anchor = useRef<{ r: number; c: number } | null>(null)
  const dragFrom = useRef<{ r: number; c: number } | null>(null)
  const cellBlock = (a: { r: number; c: number }, b: { r: number; c: number }) => {
    const out = new Set<string>()
    for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++)
      for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) out.add(cellId(r, c))
    return out
  }
  const clear = () => { setSelected(new Set()); anchor.current = null }
  const onCellDown = (e: React.MouseEvent, r: number, c: number) => {
    if (e.button !== 0) return
    e.preventDefault() // no text selection while dragging
    if (e.shiftKey && anchor.current) {
      setSelected(cellBlock(anchor.current, { r, c }))
      dragFrom.current = anchor.current
    } else if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected)
      if (next.has(cellId(r, c))) next.delete(cellId(r, c))
      else next.add(cellId(r, c))
      anchor.current = { r, c }
      setSelected(next)
    } else {
      anchor.current = dragFrom.current = { r, c }
      setSelected(new Set([cellId(r, c)]))
    }
  }
  const onCellEnter = (r: number, c: number) => {
    if (dragFrom.current) setSelected(cellBlock(dragFrom.current, { r, c }))
  }
  // Touch: a tap adds a cell to the selection (or removes it); holding a cell for a
  // moment and then dragging selects a range. Moving before the hold just scrolls the page.
  const touch = useRef<{ timer: number; x: number; y: number; r: number; c: number; dragging: boolean } | null>(null)
  const onCellTouch = (e: React.TouchEvent, r: number, c: number) => {
    const p = e.touches[0]
    if (e.touches.length > 1) return
    const tch = { x: p.clientX, y: p.clientY, r, c, dragging: false, timer: 0 }
    tch.timer = window.setTimeout(() => {
      tch.dragging = true
      anchor.current = dragFrom.current = { r, c }
      setSelected(new Set([cellId(r, c)]))
      navigator.vibrate?.(10)
    }, 350)
    touch.current = tch
  }
  useEffect(() => {
    const cellAt = (x: number, y: number) => {
      const el = (document.elementFromPoint(x, y) as Element | null)?.closest<HTMLElement>('[data-cell]')
      if (!el) return null
      const [r, c] = el.dataset.cell!.split(':').map(Number)
      return { r, c }
    }
    const move = (e: TouchEvent) => {
      const tch = touch.current
      if (!tch) return
      const p = e.touches[0]
      if (!tch.dragging) {
        if (Math.hypot(p.clientX - tch.x, p.clientY - tch.y) > 8) { clearTimeout(tch.timer); touch.current = null } // a scroll
        return
      }
      e.preventDefault() // selecting, not scrolling
      const at = cellAt(p.clientX, p.clientY)
      if (at && dragFrom.current) setSelected(cellBlock(dragFrom.current, at))
    }
    const end = (e: TouchEvent) => {
      const tch = touch.current
      if (!tch) return
      clearTimeout(tch.timer)
      e.preventDefault() // handled here: no emulated mouse click afterwards (iOS sends none for table cells anyway)
      if (!tch.dragging) {
        // a tap adds the cell to the selection, or takes it out, so tapping a few numbers sums them
        const id = cellId(tch.r, tch.c)
        anchor.current = { r: tch.r, c: tch.c }
        setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
      }
      touch.current = null
      dragFrom.current = null
    }
    document.addEventListener('touchmove', move, { passive: false })
    document.addEventListener('touchend', end, { passive: false })
    document.addEventListener('touchcancel', end)
    return () => {
      document.removeEventListener('touchmove', move)
      document.removeEventListener('touchend', end)
      document.removeEventListener('touchcancel', end)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const onRowName = (e: React.MouseEvent, r: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    anchor.current = { r, c: 0 }
    setSelected(cellBlock({ r, c: 0 }, { r, c: vis.length - 1 }))
  }
  useEffect(() => {
    const up = () => { dragFrom.current = null }
    const down = (e: Event) => {
      const t = e.target as Element
      if (!ref.current?.contains(t) && !t.closest?.('[data-cell-summary]')) clear()
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') clear() }
    document.addEventListener('mouseup', up)
    document.addEventListener('mousedown', down)
    document.addEventListener('touchstart', down, { passive: true }) // iOS sends no mousedown for a tap on plain text
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mouseup', up)
      document.removeEventListener('mousedown', down)
      document.removeEventListener('touchstart', down)
      document.removeEventListener('keydown', key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // a different table (statement, frequency, growth rows, columns, rows shown) starts a fresh selection
  useEffect(clear, [tab, freq, modes, k, keyOnly])

  return (
    <div>
    <div ref={ref} className="relative overflow-hidden rounded-lg border bg-card">
      {width > 0 && (
        <>
          <div ref={scroller} onScroll={onScroll} className="overflow-x-auto overscroll-x-contain">
          <table data-slot="table" className="table-fixed caption-bottom text-sm" style={{ width: scrolls ? tableW : '100%' }}>
            <colgroup>
              <col style={{ width: LABEL_W }} />
              <col style={{ width: SPARK_W }} />
              {vis.map((p, j) => (
                <col key={p.key} style={scrolls ? { width: need[j] } : undefined} />
              ))}
              {older && <col style={{ width: NAV_W }} />}
            </colgroup>
            <TableHeader>
              <TableRow className="group hover:bg-transparent">
                <TableHead className={cn('left-0 h-11 pl-4 text-muted-foreground', pinned(false))}>{t('Period')}</TableHead>
                <TableHead className={pinned(false)} style={{ left: LABEL_W - 1 }} />
                {vis.map((p, j) => (
                  <TableHead key={p.key} className={cn('group/col relative h-11 pr-4 text-right', fadeCol(j))}>
                    <span className="inline-flex items-center gap-1 text-[13px] font-medium text-foreground">
                      <PeriodLabel period={p} reported={reported[p.key]} />
                      <MagazineIcon period={p} />
                      {/* remove the oldest period: in the corner on hover with a mouse; on touch screens after the label, with a larger invisible tap area */}
                      {j === vis.length - 1 && j > 0 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="absolute top-1 right-1 size-6 rounded-md text-muted-foreground opacity-0 pointer-coarse:relative pointer-coarse:top-auto pointer-coarse:right-auto pointer-coarse:-mr-1.5 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-3 pointer-coarse:after:-right-3 pointer-coarse:after:-left-0.5 transition-opacity group-hover/col:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-70"
                          aria-label={t('Remove {period}', { period: p.label })}
                          title={t('Remove {period}', { period: p.label })}
                          onClick={() => onExtra(k - 1 - base)}
                        >
                          <X className="size-3.5" />
                        </Button>
                      )}
                    </span>
                  </TableHead>
                ))}
                {/* the last column adds the previous period; its cells below stay empty */}
                {older && (
                  <TableHead className="h-11 px-0 text-center">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="relative inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5"
                          onClick={() => { motion.current.cols = k; onExtra(k + 1 - base) }}
                          aria-label={t('Add {period}', { period: all[candidates[k]].label })}
                        >
                          <Plus className="size-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{t('Add {period}', { period: all[candidates[k]].label })}</TooltipContent>
                    </Tooltip>
                  </TableHead>
                )}
              </TableRow>
              {(
                [
                  ['Period End Date', (p: Period) => shortDate(p.end)],
                  ['Period Length', (p: Period) => t('{n} Months', { n: p.months })],
                ] as const
              ).map(([name, get]) => (
                <TableRow key={name} className="group hover:bg-transparent">
                  <TableCell className={cn('left-0 pl-4 text-muted-foreground', pinned(false))}>{t(name)}</TableCell>
                  <TableCell className={pinned(false)} style={{ left: LABEL_W - 1 }} />
                  {vis.map((p, j) => (
                    <TableCell key={p.key} className={cn('pr-4 text-right tabular-nums', fadeCol(j))}>
                      {get(p)}
                    </TableCell>
                  ))}
                  {older && <TableCell />}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {rows.map((r, ri) => (
                <TableRow key={r.key} className={cn('group', r.total && 'bg-muted/30')}>
                  <TableCell className={cn('left-0 cursor-pointer py-2.5 pl-4 align-middle whitespace-normal select-none', pinned(r.total))} onMouseDown={e => onRowName(e, ri)} title={t('Select this row')}>
                    <RowName name={r.name} definition={DEFINITIONS[r.key]?.[lang]} className={cn('leading-[22px]', r.total ? 'font-semibold text-foreground' : 'text-foreground/90')} />
                    {r.subLabels.map(s => (
                      <div key={s} className="text-[13px] leading-[22px] text-muted-foreground">
                        {s}
                      </div>
                    ))}
                  </TableCell>
                  <TableCell className={cn('py-2.5 align-middle', pinned(r.total))} style={{ left: LABEL_W - 1 }}>
                    <ChartPopover row={r} isQ={freq === 'q'} unit={unitText(units[(r.unit as keyof typeof units) || 'money'] ?? units.money)} />
                  </TableCell>
                  {r.cells.map((c, j) => (
                    <TableCell
                      key={vis[j].key}
                      data-cell={cellId(ri, j)}
                      onMouseDown={e => onCellDown(e, ri, j)}
                      onMouseEnter={() => onCellEnter(ri, j)}
                      onTouchStart={e => onCellTouch(e, ri, j)}
                      onContextMenu={e => e.preventDefault()}
                      className={cn(
                        'cursor-cell py-2.5 pr-4 text-right align-middle tabular-nums select-none [-webkit-touch-callout:none]',
                        fadeCol(j),
                        selected.has(cellId(ri, j)) && 'bg-chart-up/15 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--chart-up)_55%,transparent)]',
                      )}
                    >
                      <div className={cn('leading-[22px]', c.empty ? 'text-muted-foreground' : vis[j].projected ? 'text-foreground/75 italic' : 'text-foreground')}>{c.main}</div>
                      {c.subs.map((s, i) => (
                        <div key={i} className={cn('text-[13px] leading-[22px]', toneClass[s.tone])}>
                          {s.text}
                        </div>
                      ))}
                    </TableCell>
                  ))}
                  {older && <TableCell />}
                </TableRow>
              ))}
            </TableBody>
          </table>
          </div>
          {selected.size > 0 && <SelectionSummary rows={rows} selected={selected} onClear={clear} />}
          {/* fades hint at periods scrolled out of view */}
          <div aria-hidden className={cn('pointer-events-none absolute top-0 bottom-0 z-[2] w-6 bg-gradient-to-r from-black/45 to-transparent transition-opacity', edges.left ? 'opacity-100' : 'opacity-0')} style={{ left: LABEL_W + SPARK_W }} />
          <div aria-hidden className={cn('pointer-events-none absolute top-0 bottom-0 z-[2] w-6 bg-gradient-to-l from-black/45 to-transparent transition-opacity', edges.right ? 'opacity-100' : 'opacity-0')} style={{ right: 0 }} />
        </>
      )}
    </div>
    {folded > 0 && (
      <button
        type="button"
        ref={foldBar}
        onClick={e => {
          if (!keyOnly) foldTop.current = e.currentTarget.getBoundingClientRect().top
          onKeyOnly(!keyOnly)
        }}
        className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-sm text-muted-foreground transition-colors outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {keyOnly ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
        {keyOnly ? t('Show {n} more rows', { n: folded }) : t('Show key rows only')}
      </button>
    )}
    </div>
  )
}

// each statement's rows as [label width %, total row?], so its skeleton has the real table's shape
const SKELETON_ROWS: Record<StatementKey, [number, number][]> = {
  income: [[32,1],[38,0],[30,1],[55,0],[82,0],[60,0],[40,1],[40,0],[75,0],[48,1],[30,0],[88,0],[25,1],[28,0],[32,0],[78,0],[82,0],[15,1]],
  balance: [[45,0],[55,0],[48,0],[22,0],[50,1],[82,0],[20,0],[58,0],[30,1],[40,0],[65,0],[38,0],[62,1],[35,0],[42,1],[65,1],[65,1]],
  cash: [[25,0],[68,0],[60,0],[75,1],[50,0],[65,0],[75,1],[42,0],[35,0],[28,0],[28,0],[75,1],[35,1]],
}

/** Placeholder in the shape of the statement's table (header, period rows, its line items and growth lines) while a company loads. */
export function TableSkeleton({ tab, subLines, keyOnly }: { tab: StatementKey; subLines: number; keyOnly: boolean }) {
  const cols = 5
  const cell = 'flex flex-1 justify-end pr-4'
  return (
    <div aria-busy="true" className="overflow-hidden rounded-lg border bg-card">
      <div className="flex h-11 items-center border-b">
        <div className="pl-4" style={{ width: LABEL_W }}><Skeleton className="h-3.5 w-14" /></div>
        <div style={{ width: SPARK_W }} />
        {Array.from({ length: cols }, (_, i) => <div key={i} className={cell}><Skeleton className="h-3.5 w-16" /></div>)}
      </div>
      {[0, 1].map(k => (
        <div key={k} className="flex h-10 items-center border-b">
          <div className="pl-4" style={{ width: LABEL_W }}><Skeleton className="h-3.5" style={{ width: k ? 84 : 104 }} /></div>
          <div style={{ width: SPARK_W }} />
          {Array.from({ length: cols }, (_, i) => <div key={i} className={cell}><Skeleton className="h-3.5 w-14" /></div>)}
        </div>
      ))}
      {(keyOnly ? SKELETON_ROWS[tab].slice(0, KEY_ROWS[tab].length) : SKELETON_ROWS[tab]).map(([w, total], r) => (
        <div key={r} className={cn('flex items-center border-b py-2.5 last:border-0', total && 'bg-muted/30')}>
          <div className="space-y-2 py-1 pl-4" style={{ width: LABEL_W }}>
            <Skeleton className={cn('h-3.5', total && 'bg-accent-foreground/15')} style={{ width: `${w}%` }} />
            {Array.from({ length: subLines }, (_, i) => <Skeleton key={i} className="h-3 w-24 opacity-60" />)}
          </div>
          <div style={{ width: SPARK_W }}><Skeleton className="h-5 w-16" /></div>
          {Array.from({ length: cols }, (_, i) => (
            <div key={i} className={cn(cell, 'flex-col items-end space-y-2 py-1')}>
              <Skeleton className="h-3.5 w-16" />
              {Array.from({ length: subLines }, (_, s) => <Skeleton key={s} className="h-3 w-12 opacity-60" />)}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// a line item's meaning on hover (desktop; on phones a tap on the name selects the row, so the
// meaning is in the chart card instead)
const hover = typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches
function RowName({ name, definition, className }: { name: string; definition?: string; className: string }) {
  if (!definition || !hover) return <div className={className}>{name}</div>
  return (
    <Tooltip delayDuration={700}>
      <TooltipTrigger asChild>
        <div className={className}>{name}</div>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="max-w-72 px-3 py-2 text-sm leading-relaxed">
        {definition}
      </TooltipContent>
    </Tooltip>
  )
}

/** Sparkline that opens a card with the line item's meaning, key stats and a larger, explorable bar chart. */
function ChartPopover({ row, isQ, unit }: { row: ViewRow; isQ: boolean; unit: string }) {
  const { lang } = useLang()
  const pts = row.hist
  const vals = pts.map(p => p.value).filter((v): v is number => v != null)
  if (vals.length < 2) return null
  const latest = [...pts].reverse().find(p => p.value != null)!
  const yoy = pct(latest.value, latest.yearAgo)
  const Stat = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-semibold">{children}</div>
    </div>
  )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={e => e.stopPropagation()}
          aria-label={t('Chart of {name}', { name: row.name })}
          className="-m-1.5 block cursor-pointer rounded-md p-1.5 transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none data-[state=open]:bg-muted"
        >
          <Sparkline values={row.spark} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-[468px] space-y-4 p-4" onClick={e => e.stopPropagation()}>
        <div>
          <div className="font-semibold">{row.name}</div>
          {DEFINITIONS[row.key] && <p className="mt-1 mb-2 text-sm leading-relaxed text-muted-foreground">{DEFINITIONS[row.key][lang]}</p>}
          <div className="text-xs text-muted-foreground">
            {pts[0].label} – {pts[pts.length - 1].label} · {t(isQ ? 'quarterly' : 'annual')} · {unit}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-3 text-sm">
          <Stat label={t('Latest · {period}', { period: latest.label })}>{fmt(latest.value!)}</Stat>
          <Stat label={t('YoY')}>
            {yoy == null ? <span className="text-muted-foreground">—</span> : <span className={yoy > 0 ? 'text-positive' : yoy < 0 ? 'text-negative' : ''}>{(yoy > 0 ? '+' : '') + fmt(yoy)}%</span>}
          </Stat>
          <Stat label={t('High')}>{fmt(Math.max(...vals))}</Stat>
          <Stat label={t('Low')}>{fmt(Math.min(...vals))}</Stat>
        </div>
        <HistoryChart points={pts} isQ={isQ} />
      </PopoverContent>
    </Popover>
  )
}

/** "USD millions" → "millions of USD" in the reader's language. */
function unitText(u: string) {
  const m = /^(\w+) (millions|per share)$/.exec(u)
  if (!m) return u === 'millions of shares' ? t(u) : u
  const cur = currencyName(m[1])
  return m[2] === 'millions' ? t('millions of {cur}', { cur }) : t('{cur} per share', { cur })
}

/**
 * Period name in the column header. Hovering shows the period, when its results came out (press
 * release) and when the 10-Q / 10-K was filed; a preliminary quarter (amber dot, dotted underline)
 * explains that its figures come from the press release and links it.
 */
function PeriodLabel({ period, reported }: { period: Period; reported?: Reported }) {
  if (period.key === 'TTM') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="rounded-sm underline decoration-muted-foreground/60 decoration-dotted underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">TTM</span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="px-3.5">
          <TipCard
            title={t('TTM · trailing twelve months')}
            rows={[[t('Covers'), t('{n} months ended {date}', { n: 12, date: longDate(period.end) })]]}
            note={t('The last four reported quarters added up, so a full year that is more recent than the last annual report. Balance sheet: the latest quarter.')}
          />
        </TooltipContent>
      </Tooltip>
    )
  }
  if (period.projected) {
    const { reported: done, projected: todo, from, to } = period.projected
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="rounded-sm italic underline decoration-muted-foreground/60 decoration-dotted underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            {period.label} <span className="text-muted-foreground">{t('proj.')}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="px-3.5">
          <TipCard
            title={t('{year} (projected)', { year: period.label })}
            status={t('Projection')}
            rows={[...(done.length ? [[t('Reported'), done.join(', ')] as [string, string]] : []), [t('Projected'), todo.join(', ')], [t('Growth used'), `${from} → ${to}`]]}
            note={<>
              {t("Each remaining quarter grows at the latest quarter-on-quarter rate, compounding (for a loss, by the latest change in dollars). A trend, not a forecast or company guidance.")}
              <span className="mt-1.5 block">{t("Under Total Revenue, the blue figure in this column is the projection minus the analysts' estimate.")}</span>
            </>}
          />
        </TooltipContent>
      </Tooltip>
    )
  }
  const release = period.release?.filed ?? reported?.release
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={period.preliminary ? t('{period}, preliminary', { period: period.label }) : period.label}
          className="inline-flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {period.preliminary && <span className="size-1.5 rounded-full bg-amber-400" />}
          <span className={cn(period.preliminary && 'underline decoration-amber-400/70 decoration-dotted underline-offset-4')}>{period.label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="px-3.5">
        <TipCard
          title={period.label}
          status={period.preliminary ? t('Preliminary') : undefined}
          tone="amber"
          rows={[
            [t('Covers'), t('{n} months ended {date}', { n: period.months, date: longDate(period.end) })],
            ...(release ? [[t('Results'), longDate(release)] as [string, string]] : []),
            ...(reported?.filing ? [[t('{form} filed', { form: reported.filing.form }), longDate(reported.filing.filed)] as [string, string]] : []),
          ]}
          note={period.preliminary ? t("The official {form} isn't out yet, so these figures come from the press release; they are replaced automatically when it arrives.", { form: period.q === 4 ? '10‑K' : '10‑Q' }) : undefined}
        >
          {period.preliminary && period.release && (
            <a href={period.release.url} target="_blank" rel="noopener" className="inline-flex items-center gap-1 font-medium underline underline-offset-4">
              {t('Read the press release')} <ExternalLink className="size-3" />
            </a>
          )}
        </TipCard>
      </TooltipContent>
    </Tooltip>
  )
}

/** Status bar fixed at the bottom right (like a spreadsheet's): count, sum and average of the selected numbers. */
function SelectionSummary({ rows, selected, onClear }: { rows: ViewRow[]; selected: Set<string>; onClear: () => void }) {
  const nums = [...selected]
    .map(id => { const [r, c] = id.split(':').map(Number); return rows[r]?.cells[c]?.value })
    .filter((v): v is number => v != null)
  const sum = nums.reduce((a, b) => a + b, 0)
  const stat = (label: string, value: string) => (
    <span><span className="text-muted-foreground">{label} </span><span className="font-semibold">{value}</span></span>
  )
  // phones show the desktop layout scaled down to fit, so on touch screens the box is drawn about twice as large
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 pointer-coarse:bottom-8">
      <div className="mx-auto flex max-w-[1320px] justify-end px-6">
        <div
          data-cell-summary
          className="pointer-events-auto flex items-center gap-4 rounded-lg border bg-popover py-2 pr-2 pl-4 text-sm shadow-lg tabular-nums pointer-coarse:gap-7 pointer-coarse:rounded-2xl pointer-coarse:py-4 pointer-coarse:pr-4 pointer-coarse:pl-7 pointer-coarse:text-[30px]"
        >
          {stat(t('Count'), String(nums.length))}
          {stat(t('Sum'), nums.length ? fmt(sum) : '—')}
          {stat(t('Avg'), nums.length ? fmt(sum / nums.length) : '—')}
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground pointer-coarse:size-14" aria-label={t('Clear selection')} title={t('Clear selection (Esc)')} onClick={onClear}>
            <X className="size-3.5 pointer-coarse:size-7" />
          </Button>
        </div>
      </div>
    </div>
  )
}
