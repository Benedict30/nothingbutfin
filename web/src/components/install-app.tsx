import { useEffect, useState } from 'react'
import { Share, Smartphone, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { t } from '@/lib/i18n'

// Chrome / Edge / Android: the browser's own install prompt, kept for when the button is tapped
interface InstallPrompt extends Event { prompt: () => Promise<void> }
let deferred: InstallPrompt | null = null
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e as InstallPrompt })

// closing the reminder hides it for 30 days
const DISMISS_KEY = 'fsv-install-dismissed'
const dismissedRecently = () => { try { return Date.now() - Number(localStorage.getItem(DISMISS_KEY) || 0) < 30 * 86400e3 } catch { return false } }
const installed = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
const touchDevice = () => matchMedia('(pointer: coarse)').matches
const iOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const iOSOtherBrowser = () => /CriOS|FxiOS|EdgiOS/.test(navigator.userAgent) // Chrome, Firefox, Edge on iPhone: Share sits in the address bar

/**
 * A friendly reminder under the top bar, on phones and tablets until the site is installed (closing
 * it hides it for 30 days): "How" shows Android's install prompt, or on iPhone (where sites can't
 * trigger it, in Safari or Chrome) the two steps.
 */
export function InstallApp() {
  const [show, setShow] = useState(() => touchDevice() && !installed() && !dismissedRecently())
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const done = () => setShow(false)
    window.addEventListener('appinstalled', done)
    return () => window.removeEventListener('appinstalled', done)
  }, [])
  if (!show) return null

  const install = async () => {
    if (deferred) {
      await deferred.prompt()
      deferred = null
      return
    }
    setOpen(true)
  }
  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())) } catch { /* storage unavailable */ }
    setShow(false)
  }
  return (
    <div className="border-b bg-chart-up/10">
      <div className="mx-auto flex max-w-[1320px] items-center gap-3 px-6 py-2 text-sm">
        <Smartphone className="size-4 shrink-0 text-chart-up" />
        <span className="flex-1">{t('Get Nothing But Fin on your home screen')}</span>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              onClick={e => { e.preventDefault(); install() }}
              className="rounded-md bg-chart-up/20 px-3 py-1 font-medium text-chart-up outline-none hover:bg-chart-up/30 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {t('How')}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 space-y-2 text-sm">
        <div className="font-semibold">{t('Add Nothing But Fin to your home screen')}</div>
        {iOS() ? (
          <p className="leading-relaxed text-muted-foreground">
            {iOSOtherBrowser() ? t('Tap the Share button in the address bar') : t('In Safari, tap the Share button')} <Share className="inline size-4 align-text-bottom text-foreground" />{t(', then “Add to Home Screen”.')}
          </p>
        ) : (
          <p className="leading-relaxed text-muted-foreground">{t('Open your browser’s menu and choose “Install app” or “Add to Home screen”.')}</p>
        )}
          </PopoverContent>
        </Popover>
        <button type="button" onClick={dismiss} aria-label={t('Close')} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
