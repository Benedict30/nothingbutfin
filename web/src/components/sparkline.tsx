/** Tiny bar chart of a row's recent history (oldest → newest); negatives hang below the axis. */
export function Sparkline({ values, width = 64, height = 24 }: { values: (number | null)[]; width?: number; height?: number }) {
  const nums = values.filter((v): v is number => v != null)
  if (nums.length < 2) return null
  const max = Math.max(...nums.map(Math.abs)) || 1
  const hasPos = nums.some(v => v > 0), hasNeg = nums.some(v => v < 0)
  const span = hasPos && hasNeg ? height / 2 : height
  const axis = hasPos && hasNeg ? height / 2 : hasNeg ? 0 : height
  const gap = values.length > 12 ? 1 : 2
  const w = (width - gap * (values.length - 1)) / values.length
  return (
    <svg width={width} height={height} aria-hidden className="block">
      {values.map((v, i) => {
        if (v == null) return null
        const h = v === 0 ? 1 : Math.max((Math.abs(v) / max) * span, 1.5)
        const y = v >= 0 ? axis - h : axis
        return <rect key={i} x={i * (w + gap)} y={y} width={w} height={h} rx={0.5} className={v > 0 ? 'fill-chart-up' : v < 0 ? 'fill-chart-down' : 'fill-muted-foreground'} />
      })}
    </svg>
  )
}
