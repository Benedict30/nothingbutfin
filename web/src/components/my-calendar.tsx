import { useEffect, useState } from 'react'
import { CalendarCheck, CalendarX, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { calendarUrl, loadCalendar, markSubscribed, setFollow, type CalendarDetails } from '@/lib/calendar'
import { date as fmtDate, locale, t } from '@/lib/i18n'

const TIMING = { 'before-open': 'before open', 'after-close': 'after close', during: 'during market hours' } as const

/** "2 hours ago", in the reader's language. */
function ago(iso: string) {
  const s = (Date.parse(iso) - Date.now()) / 1000
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' })
  for (const [unit, n] of [['day', 86400], ['hour', 3600], ['minute', 60]] as const) if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit)
  return rtf.format(0, 'minute')
}

const copy = (text: string, done: string, description: string) =>
  navigator.clipboard.writeText(text).then(() => toast.success(done, { description }), () => toast.error(t('Could not copy the link')))

/**
 * "My earnings calendar": the companies this browser's calendar follows with their next earnings
 * (unfollow here), whether a calendar app is reading it, and how to add it to one.
 */
export function MyCalendar({ open, onOpenChange, onFollows, onPick }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onFollows: (tickers: string[]) => void
  onPick: (ticker: string) => void
}) {
  const [data, setData] = useState<CalendarDetails | null>(null)
  const refresh = () => loadCalendar().then(setData, () => toast.error(t('Could not reach the server.')))
  useEffect(() => { if (open) refresh() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const unfollow = async (ticker: string) => {
    try { onFollows(await setFollow(ticker, false)) } catch { return toast.error(t('Could not reach the server.')) }
    refresh()
  }
  const fetched = data?.calendar.fetched

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-[480px]">
        <div className="space-y-1 border-b px-6 pt-5 pb-4">
          <DialogTitle className="text-lg font-semibold">{t('My earnings calendar')}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">{t('Companies you follow and their next earnings. Your calendar app shows the same list.')}</DialogDescription>
        </div>

        <div className="max-h-[50vh] overflow-y-auto px-3 py-2">
          {!data ? (
            <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : !data.items.length ? (
            <p className="px-3 py-6 text-sm text-muted-foreground">{t("Not following any companies yet. Click the bell next to a company's earnings date to follow it.")}</p>
          ) : (
            <ul>
              {data.items.map(({ ticker, name, next }) => (
                <li key={ticker} className="group flex items-center gap-3 rounded-md px-3 py-2.5 hover:bg-muted/50">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { onPick(ticker); onOpenChange(false) }}>
                    <div className="flex items-baseline gap-2">
                      <span className="font-semibold">{ticker}</span>
                      <span className="truncate text-xs text-muted-foreground">{name}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-sm">
                      {next ? (
                        <>
                          <span>{fmtDate(next.date, { weekday: 'short', month: 'short', day: 'numeric' })}{next.timing ? ', ' + t(TIMING[next.timing]) : ''}</span>
                          {!next.source && <span className="rounded-full bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground">{t('Estimated')}</span>}
                        </>
                      ) : <span className="text-muted-foreground">{t('Date not available yet')}</span>}
                    </div>
                  </button>
                  <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-foreground" aria-label={t('Unfollow {ticker}', { ticker })} title={t('Unfollow {ticker}', { ticker })} onClick={() => unfollow(ticker)}>
                    <X className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-3 border-t px-6 py-4">
          <div className="flex items-center gap-2 text-sm">
            {fetched ? <CalendarCheck className="size-4 text-positive" /> : <CalendarX className="size-4 text-muted-foreground" />}
            <span className="text-muted-foreground">{t('Calendar sync')}:</span>
            <span className="font-medium">{fetched ? t('On · last synced {when}', { when: ago(fetched) }) : t('Off')}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" asChild>
              <a href={calendarUrl()} onClick={markSubscribed}>{t('Sync with my calendar')}</a>
            </Button>
          </div>
          {/* Google Calendar can't take the one-click sync: it subscribes by pasting the feed's address */}
          <button type="button" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={() => copy(calendarUrl('page'), t('Calendar link copied'), t('In Google Calendar: Other calendars → + → From URL, then paste it. Keep it private.'))}>
            {t('Using Google Calendar? Copy the calendar link')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
