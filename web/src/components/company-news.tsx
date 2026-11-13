import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { date, longDate, t, useLang } from '@/lib/i18n'

interface NewsItem { filed: string; label: string; form: string; title: string | null; period: string | null; url: string }

/** What an item says when its filing has no press-release headline. */
function describe(n: NewsItem) {
  if (n.form === '10-Q' && n.period) return t('Quarterly report for the period ended {date}', { date: longDate(n.period) })
  if (n.period) return t('Annual report for the year ended {date}', { date: longDate(n.period) })
  if (n.form === 'DEF 14A') return t('Proxy statement for the annual meeting')
  return t('{label} (SEC filing)', { label: t(n.label) })
}

/** "Latest from the company": its own announcements and reports, from SEC EDGAR (lib/news.js). */
export function CompanyNews({ ticker }: { ticker: string }) {
  useLang()
  const [items, setItems] = useState<NewsItem[] | null>(null)
  useEffect(() => {
    setItems(null)
    const ctl = new AbortController()
    fetch('api/news?ticker=' + encodeURIComponent(ticker), { signal: ctl.signal })
      .then(r => r.json())
      .then(j => setItems(j.items || []))
      .catch(e => e.name !== 'AbortError' && setItems([]))
    return () => ctl.abort()
  }, [ticker])
  if (items && !items.length) return null
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">{t('Latest from the company')}</h2>
        <p className="text-sm text-muted-foreground">{t('Its own announcements and reports, from SEC filings.')}</p>
      </div>
      <ul className="divide-y rounded-lg border bg-card">
        {!items
          ? Array.from({ length: 4 }, (_, k) => (
              <li key={k} className="flex items-center gap-4 px-4 py-3">
                <Skeleton className="h-4 w-14" />
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </li>
            ))
          : items.map(n => (
              <li key={n.url}>
                {/* desktop: date · label · headline on one line; phones: date and label above a two-line headline */}
                <a href={n.url} target="_blank" rel="noopener" className="group flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm hover:bg-muted/50 sm:flex-nowrap">
                  <span className="w-14 shrink-0 text-muted-foreground tabular-nums">{date(n.filed, { month: 'short', day: 'numeric' })}</span>
                  <span className="shrink-0 sm:w-36"><span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium whitespace-nowrap text-muted-foreground">{t(n.label)}</span></span>
                  <span className="line-clamp-2 min-w-0 basis-full sm:flex-1 sm:basis-auto sm:truncate" title={n.title ?? undefined}>{n.title ?? describe(n)}</span>
                  <ExternalLink className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
              </li>
            ))}
      </ul>
    </section>
  )
}
