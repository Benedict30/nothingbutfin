import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/** A company's logo on a white tile (initials when there is none); `size` in Tailwind units. */
export function CompanyLogo({ ticker, name, className = 'size-10' }: { ticker: string; name?: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false) // a grey tile until the image arrives, not a white flash
  useEffect(() => { setFailed(false); setLoaded(false) }, [ticker])
  const box = cn(className, 'shrink-0 rounded-lg')
  if (failed || !ticker) {
    const initials = (name || ticker).replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase()
    return <div aria-hidden className={cn(box, 'flex items-center justify-center bg-muted text-sm font-semibold text-muted-foreground')}>{initials}</div>
  }
  return <img src={'logo/' + encodeURIComponent(ticker) + '.png'} alt="" className={cn(box, 'object-contain p-1.5', loaded ? 'bg-white' : 'bg-muted')} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
}
