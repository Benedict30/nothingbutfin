import { visitorHeaders } from './visitor'
import type { Statements } from './types'

// Personal earnings calendar: a private random id kept in this browser (no accounts). Following a
// company adds it to the calendar at /cal/<id>.ics, which the person subscribes to once.
const ID_KEY = 'fsv-calendar-id'
const SUBSCRIBED_KEY = 'fsv-calendar-subscribed'
const EMAIL_KEY = 'fsv-email-reminders'
const LAST_EMAIL_KEY = 'fsv-email'
const VALID = /^[A-Za-z0-9_-]{16,64}$/

// "Use on another browser": a link with ?calendar=<id> makes this browser use that calendar
try {
  const shared = new URLSearchParams(location.search).get('calendar')
  if (shared && VALID.test(shared)) localStorage.setItem(ID_KEY, shared)
} catch { /* storage unavailable */ }

export function calendarId(): string {
  try {
    let id = localStorage.getItem(ID_KEY)
    if (!id) {
      const bytes = crypto.getRandomValues(new Uint8Array(18))
      id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      localStorage.setItem(ID_KEY, id)
    }
    return id
  } catch {
    return ''
  }
}

/** webcal:// opens the calendar app's "subscribe" flow; the https/http link works for copying. */
export const calendarUrl = (scheme: 'webcal' | 'page' = 'webcal') =>
  `${scheme === 'webcal' ? 'webcal:' : location.protocol}//${location.host}/cal/${calendarId()}.ics`

export const hasSubscribed = () => { try { return localStorage.getItem(SUBSCRIBED_KEY) === '1' } catch { return false } }
export const markSubscribed = () => { try { localStorage.setItem(SUBSCRIBED_KEY, '1') } catch { /* storage unavailable */ } }

export async function setFollow(ticker: string, on: boolean): Promise<string[]> {
  const r = await fetch(`api/follows?id=${encodeURIComponent(calendarId())}&ticker=${encodeURIComponent(ticker)}&on=${on ? 1 : 0}`, { method: 'POST', headers: visitorHeaders() })
  return (await r.json()).tickers ?? []
}
export async function loadFollows(): Promise<string[]> {
  const r = await fetch(`api/follows?id=${encodeURIComponent(calendarId())}`)
  return (await r.json()).tickers ?? []
}

/** The email this calendar's earnings reminders go to (opt-in), or null. */
export async function loadEmail(): Promise<string | null> {
  const r = await fetch(`api/email-reminders?id=${encodeURIComponent(calendarId())}`)
  return (await r.json()).email ?? null
}
/** Sets the reminder email (an empty one turns reminders off); returns the email now stored. */
export async function saveEmail(email: string): Promise<string | null> {
  const r = await fetch(`api/email-reminders?id=${encodeURIComponent(calendarId())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...visitorHeaders() },
    body: JSON.stringify({ email }),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error || 'Server error')
  try { localStorage.setItem(EMAIL_KEY, j.email ? '1' : '') } catch { /* storage unavailable */ }
  rememberEmail(j.email)
  return j.email ?? null
}
/** The email last entered in this browser (reminders or feedback), to fill the next form with. */
export const rememberedEmail = () => { try { return localStorage.getItem(LAST_EMAIL_KEY) || '' } catch { return '' } }
export const rememberEmail = (email: string) => { try { if (email) localStorage.setItem(LAST_EMAIL_KEY, email) } catch { /* storage unavailable */ } }
/** Whether this browser has signed up for email reminders (to skip the prompt after following). */
export const hasEmail = () => { try { return localStorage.getItem(EMAIL_KEY) === '1' } catch { return false } }

export interface CalendarDetails {
  items: { ticker: string; name: string; next: NonNullable<Statements['nextEarnings']> | null }[]
  calendar: { fetched: string | null } // when a calendar app last read the feed
}
export async function loadCalendar(): Promise<CalendarDetails> {
  const r = await fetch(`api/follows?id=${encodeURIComponent(calendarId())}&details=1`)
  return r.json()
}
