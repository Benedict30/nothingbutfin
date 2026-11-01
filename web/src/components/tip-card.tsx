import { cn } from '@/lib/utils'

/** Layout for detail tooltips: a title with an optional status pill, label–value rows and a short note. */
export function TipCard({ title, status, tone = 'muted', rows, note, children }: {
  title: React.ReactNode
  status?: string
  tone?: 'muted' | 'amber'
  rows: [string, React.ReactNode][]
  note?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="w-64 space-y-2.5 py-1.5 text-left">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold">{title}</span>
        {status && (
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', {
            muted: 'bg-muted text-muted-foreground',
            amber: 'bg-amber-400/15 text-amber-400',
          }[tone])}>
            {status}
          </span>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      {note && <p className="border-t pt-2 leading-relaxed text-muted-foreground">{note}</p>}
      {children}
    </div>
  )
}
