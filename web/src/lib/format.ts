export function fmt(v: number, digits = 2) {
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return v < 0 ? '-' + s : s
}

export const pct = (cur: number | null, prev: number | null) =>
  prev === 0 || prev == null || cur == null ? null : ((cur - prev) / Math.abs(prev)) * 100
