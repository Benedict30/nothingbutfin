// Shapes returned by server.js (/api/statements, /api/search).
export type StatementKey = 'income' | 'balance' | 'cash'
export type Freq = 'q' | 'a'

export interface Period {
  key: string // fiscal key, e.g. "2027Q2" or "FY2026"; "TTM" for trailing twelve months
  label: string // calendar label, e.g. "Q2 2026" or "2025"
  fy: number // null for the TTM column
  q?: number
  end: string // ISO date
  months: number
  preliminary?: boolean // from the earnings press release; the 10-Q / 10-K is not out yet
  release?: { filed: string; url: string } // that press release
  projected?: { reported: string[]; projected: string[]; from: string; to: string } // "FY… (projected)": the quarters reported, those projected, and the growth used (from → to)
}

export interface Row {
  key: string
  name: string
  total?: boolean
  unit?: string
  vals: (number | null)[]
  src?: (string | null)[]
  ttmYearAgo?: number | null // annual rows: the TTM measure four quarters earlier
}

export interface Block {
  periods: Period[]
  statements: Record<StatementKey, { label: string; kind: 'flow' | 'stock'; rows: Row[] }>
}

export interface Statements {
  company: { cik: number; name: string; ticker?: string; exchange?: string; fiscalYearEnd?: string }
  currency: string
  units: { money: string; perShare: string; shares: string }
  quarterly: Block
  annual: Block
  source: { fetchedAt?: string; stale?: boolean; filings?: string }
  preliminary?: Preliminary | null
  nextEarnings?: { date: string; basedOn: string; timing?: 'before-open' | 'after-close' | 'during'; time?: string; source?: string } | null // estimated from past results dates; `source`: set when the company has announced the date (via Eulerpool)
  reported?: { quarterly: Record<string, Reported>; annual: Record<string, Reported> } | null
  // analysts' revenue estimates (Eulerpool), in the statement's money unit: by quarter, and for the next quarter
  estimates?: { byPeriod: Record<string, number>; next: { revenue: number; eps: number | null; date: string | null } | null; annual?: Record<string, number> | null } | null
}

/** When a period's results came out: the earnings press release and the 10-Q / 10-K. */
export interface Reported {
  release?: string
  filing?: { form: string; filed: string }
}

/** Earnings-day figures read from a press release whose 10-Q / 10-K is not out yet. */
export interface Preliminary {
  status: 'ready' | 'generating' | 'error' | 'no-key'
  message?: string
  period: Period
  release?: { filed: string; url: string }
  values?: Record<string, { value: number; src: string }>
}

export interface SearchResult {
  cik: number
  name: string
  ticker: string
  exchange?: string
}
