import { Bell, BellRing, ChevronDown, Clock, ExternalLink, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TipCard } from '@/components/tip-card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Statements } from '@/lib/types'
import { hasSubscribed, setFollow } from '@/lib/calendar'
import { clockTime, date as fmtDate, t, useLang } from '@/lib/i18n'

/** "Earnings in 3 days · Mon, Nov 3" on the company line: announced by the company, or estimated ("est.") from last year's results date. */
const TIMING = { 'before-open': 'before open', 'after-close': 'after close', during: 'during market hours' } as const
const FULL: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }

/**
 * Next-earnings chip in the company header: "Earnings in 2 days · Mon, Nov 2, after close", with a
 * bell to follow the company: its earnings go into the person's calendar feed, estimated until the
 * company announces the date (alerts 1 month, 2 weeks and 1 week before, and on the day). The first
 * follow offers the one-time subscribe.
 */
export function NextEarnings({ ticker, date, basedOn, timing, time, source, following, onFollows, revenueEstimate, onOpenCalendar }: NonNullable<Statements['nextEarnings']> & {
  ticker: string; following: boolean; onFollows: (tickers: string[]) => void; revenueEstimate?: number; onOpenCalendar: () => void
}) {
  useLang()
  const [menu, setMenu] = useState(false)
  const day = fmtDate
  const now = new Date() // the viewer's own date, not UTC
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const days = Math.round((Date.parse(date) - Date.parse(today)) / 86400e3)
  // once the estimate has passed: "Earnings due · est. Oct 29"
  const when = days < 0 ? t('Earnings due') : days === 0 ? t('Earnings today') : days === 1 ? t('Earnings tomorrow') : t('Earnings in {n} days', { n: days })
  const short = day(date, { weekday: 'short', month: 'short', day: 'numeric' })
  const shown = days < 0 ? short : short + (timing ? ', ' + t(TIMING[timing]) : '')
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const at = time ? ' · ' + (source ? t('{time} ET', { time: clockTime(time) }) : t('around {time} ET', { time: clockTime(time) })) : ''
  const toggle = async () => {
    try {
      onFollows(await setFollow(ticker, !following))
    } catch {
      return toast.error(t('Could not reach the server.'))
    }
    if (following) return toast(t('Stopped following {ticker}', { ticker }), { description: t('Its earnings leave your calendar at its next refresh.') })
    if (hasSubscribed()) return toast.success(t('Following {ticker}', { ticker }), { description: t('Its next earnings are in your calendar, estimated until the company confirms the date, with reminders 1 month, 2 weeks and 1 week before.') })
    toast.success(t('Following {ticker}', { ticker }), {
      description: t('Sync your calendar once; every company you follow then shows up there (estimated until the company confirms the date), with reminders 1 month, 2 weeks and 1 week before.'),
      duration: 30000,
      action: { label: t('Sync with my calendar'), onClick: onOpenCalendar }, // the list, and the sync button
    })
  }
  return (
    <div className="inline-flex items-stretch rounded-lg border bg-muted/20 text-sm">
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex items-center gap-2 rounded-l-lg py-1.5 pr-2 pl-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <Clock className="size-4 text-muted-foreground" />
            <span>
              <span className="font-medium">{when}</span>
              <span className="text-muted-foreground">
                {' · '}{source ? shown : t('est. {date}', { date: shown })}
              </span>
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="px-3.5">
          <TipCard
            title={t('Next earnings')}
            status={source ? undefined : t('Estimated')}
            rows={[
              [t('Date'), day(date, FULL)],
              ...(revenueEstimate ? [[t('Revenue estimate'), (revenueEstimate >= 1000 ? `$${(revenueEstimate / 1000).toFixed(1)}B` : `$${Math.round(revenueEstimate)}M`) + ' · Eulerpool'] as [string, string]] : []),
              ...(timing ? [[t('Time'), cap(t(TIMING[timing])) + at] as [string, string]] : []),
              source
                ? [t('Source'), <a href={source} target="_blank" rel="noopener" className="inline-flex items-center gap-1 underline underline-offset-4">Eulerpool<ExternalLink className="size-3" /></a>]
                : [t('Based on'), t('Last year: {date}', { date: day(basedOn, FULL) })],
            ]}
            note={source ? undefined : days < 0
              ? t("Past the estimated date without results, so they're likely due any day.")
              : t("Estimated from last year's date for the same quarter; it switches to the company's date once announced.")}
          />
        </TooltipContent>
      </Tooltip>
      {/* the bell follows or unfollows in one click; the arrow opens My earnings calendar: the
          companies followed, and syncing with the calendar app */}
      <button
        type="button"
        onClick={toggle}
        aria-pressed={following}
        aria-label={following ? t('Following {ticker}: its earnings are in your calendar. Click to stop.', { ticker }) : t('Follow {ticker} earnings', { ticker })}
        title={following ? t('Following {ticker}: its earnings are in your calendar. Click to stop.', { ticker }) : t('Follow {ticker} earnings', { ticker })}
        className={`flex items-center border-l py-1.5 pr-1 pl-2.5 outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 ${following ? 'text-chart-up' : 'text-muted-foreground hover:text-foreground'}`}
      >
        {following ? <BellRing className="size-4" /> : <Bell className="size-4" />}
      </button>
      <Popover open={menu} onOpenChange={setMenu}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('Configure calendar')}
            className="flex items-center rounded-r-lg pr-2 pl-0.5 text-muted-foreground outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:text-foreground"
          >
            <ChevronDown className="size-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-52 p-1 text-sm">
          <button type="button" onClick={() => { setMenu(false); onOpenCalendar() }} className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left hover:bg-muted">
            <Settings2 className="size-4 text-muted-foreground" />
            {t('Configure calendar')}
          </button>
        </PopoverContent>
      </Popover>
    </div>
  )
}

