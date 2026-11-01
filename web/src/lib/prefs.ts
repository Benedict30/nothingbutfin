import type { Freq, StatementKey } from './types'

export type Mode = 'qoq' | 'qoqp' | 'yoy' | 'yoyp'
export const MODES: [Mode, string][] = [
  ['qoq', 'QoQ Growth'],
  ['qoqp', 'QoQ Growth %'],
  ['yoy', 'YoY Growth'],
  ['yoyp', 'YoY Growth %'],
]
/** Growth rows per view: quarter-on-quarter for quarters, year-on-year for years. */
export const modeShown = (m: Mode, freq: Freq) => (freq === 'q' ? m.startsWith('qoq') : !m.startsWith('qoq'))

export const TABS: [StatementKey, string][] = [
  ['income', 'Income Statement'],
  ['balance', 'Balance Sheet'],
  ['cash', 'Cash Flow'],
]

/** The rows "Key rows" keeps; "All rows" shows the whole statement. */
export const KEY_ROWS: Record<StatementKey, string[]> = {
  income: ['revenue', 'grossProfit', 'opIncome', 'netIncome', 'epsDiluted'],
  balance: ['cash', 'assets', 'liabilities', 'equity'],
  cash: ['cfo', 'capex', 'fcf'],
}

export interface Prefs {
  ticker: string
  tab: StatementKey
  freq: Freq
  modes: Mode[]
  projection: boolean // the projected next quarter / year
  estimates: boolean // analysts' revenue estimate and the surprise, under Total Revenue
  keyRows: boolean // only each statement's KEY_ROWS
}

// Settings persist in this browser; URL parameters win when present.
const KEY = 'fsv-prefs'

export function loadPrefs(): Prefs {
  let saved: Partial<Prefs> & Record<string, unknown> = {}
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}
  } catch {
    /* storage unavailable */
  }
  const url = new URLSearchParams(location.search)
  const tab = url.get('tab') || saved.tab
  const freq = url.get('freq') || saved.freq
  const modes = Array.isArray(saved.modes) ? saved.modes.filter((m): m is Mode => MODES.some(([k]) => k === m)) : (['qoqp', 'yoyp'] as Mode[])
  return {
    ticker: (url.get('ticker') || saved.ticker || 'AAPL').toUpperCase(),
    tab: TABS.some(([k]) => k === tab) ? (tab as StatementKey) : 'income',
    freq: freq === 'a' ? 'a' : 'q',
    modes,
    projection: saved.projection !== false,
    estimates: saved.estimates !== false,
    keyRows: saved.keyRows !== false,
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* storage unavailable */
  }
  const q = new URLSearchParams({ ticker: p.ticker })
  if (p.tab !== 'income') q.set('tab', p.tab)
  if (p.freq !== 'q') q.set('freq', p.freq)
  history.replaceState(null, '', '?' + q)
}
