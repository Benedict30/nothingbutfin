import { useEffect, useRef, useState } from 'react'
import { Search as SearchIcon } from 'lucide-react'
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Command as Cmdk } from 'cmdk'
import { t, useLang } from '@/lib/i18n'
import type { SearchResult } from '@/lib/types'

// recently opened companies, newest first, remembered in this browser
const RECENT_KEY = 'fsv-recent'
const loadRecent = (): SearchResult[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') } catch { return [] } }
export function rememberRecent(c: SearchResult) {
  if (!c.ticker) return
  const list = [c, ...loadRecent().filter(x => x.ticker !== c.ticker)].slice(0, 6)
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)) } catch { /* storage unavailable */ }
}

/** Prominent company / ticker search. "/" focuses it; an empty box lists recent companies; Enter on no match tries the text as a ticker. */
export function Search({ onPick }: { onPick: (ticker: string, company?: SearchResult) => void }) {
  const [q, setQ] = useState('')
  useLang()
  const [results, setResults] = useState<SearchResult[]>([])
  const [answered, setAnswered] = useState('') // the search text the results belong to
  const [recent, setRecent] = useState<SearchResult[]>([])
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '/' && !/INPUT|TEXTAREA/.test(t.tagName)) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const term = q.trim()
    if (!term) return setResults([])
    const ctl = new AbortController()
    const t = setTimeout(() => {
      fetch('api/search?q=' + encodeURIComponent(term), { signal: ctl.signal })
        .then(r => r.json())
        .then(j => { setResults(j.results || []); setAnswered(term) })
        .catch(() => {})
    }, 120)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [q])

  const pick = (ticker: string, company?: SearchResult) => {
    setQ('')
    setOpen(false)
    input.current?.blur()
    onPick(ticker, company)
  }

  return (
    <Command shouldFilter={false} className="relative h-auto w-full max-w-xl overflow-visible bg-transparent">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-muted-foreground" />
        <Cmdk.Input
          ref={input}
          value={q}
          onValueChange={v => {
            setQ(v)
            setOpen(!!v.trim() || recent.length > 0)
          }}
          onFocus={() => {
            const r = loadRecent()
            setRecent(r)
            setOpen(!!q.trim() || r.length > 0)
          }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={e => {
            if (e.key === 'Escape') {
              setQ('')
              input.current?.blur()
            }
            if (e.key === 'Enter' && q.trim() && !results.length) pick(q.trim())
          }}
          placeholder={t('Search any company or ticker…')}
          aria-label={t('Search company or ticker')}
          className="peer h-11 w-full rounded-lg border border-input bg-muted/40 pr-11 pl-10 text-base text-foreground shadow-xs outline-none transition-[color,box-shadow,background-color] placeholder:text-muted-foreground hover:bg-muted/60 focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <kbd className="pointer-events-none absolute top-1/2 right-3 inline-flex h-6 min-w-6 -translate-y-1/2 items-center justify-center rounded border bg-muted px-1.5 font-sans text-xs font-medium text-muted-foreground peer-focus-visible:hidden">
          /
        </kbd>
      </div>
      {open && (
        <CommandList className="absolute top-full right-0 left-0 z-50 mt-1.5 max-h-80 rounded-lg border bg-popover p-1 shadow-lg">
          {/* "no matches" only once the server has answered for this text */}
          {q.trim() && (
            <CommandEmpty className="px-2 py-2 text-sm text-muted-foreground">
              {answered === q.trim() ? t('No matches — press Enter to try “{q}”', { q: q.trim().toUpperCase() }) : t('Searching…')}
            </CommandEmpty>
          )}
          <CommandGroup heading={q.trim() ? undefined : t('Recent')} className="p-0">
            {(q.trim() ? results : recent).map(r => (
              <CommandItem key={r.ticker} value={r.ticker} onSelect={() => pick(r.ticker, r)} className="gap-3 py-2">
                <span className="w-14 font-medium">{r.ticker}</span>
                <span className="flex-1 truncate text-muted-foreground">{r.name}</span>
                <span className="text-xs tracking-wide text-muted-foreground uppercase">{r.exchange}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      )}
    </Command>
  )
}
