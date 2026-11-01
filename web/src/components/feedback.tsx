import { useState } from 'react'
import { Mail, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { t } from '@/lib/i18n'
import { visitorHeaders } from '@/lib/visitor'

const CONTACT = 'ben.chin.credit@gmail.com' // for people who'd rather write directly

/** "Feedback" in the footer: a short form (message, optional email for updates) saved on the server (data/feedback.jsonl). */
export function Feedback() {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)

  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!message.trim()) return
    setSending(true)
    try {
      const r = await fetch('api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...visitorHeaders() },
        body: JSON.stringify({ message, email, page: location.search }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || t('Could not reach the server.'))
      toast.success(t('Thanks for the feedback!'), { description: email ? t("We'll keep you posted.") : undefined })
      setMessage('')
      setEmail('')
      setOpen(false)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex items-center gap-1.5 text-foreground underline-offset-4 hover:underline">
          <MessageSquare className="size-4" /> {t('Feedback')}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-80">
        <form onSubmit={send} className="space-y-3">
          <div className="space-y-1">
            <div className="text-sm font-semibold">{t('What would you like to see?')}</div>
            <p className="text-xs text-muted-foreground">{t('Ideas, missing companies, bugs: anything helps.')}</p>
          </div>
          <textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            maxLength={2000}
            rows={4}
            required
            autoFocus
            className="w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            placeholder={t('Your idea or feedback')}
          />
          <div className="space-y-1">
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              maxLength={200}
              className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              placeholder={t('Your email')}
            />
            <p className="text-xs text-muted-foreground">{t("Optional. Leave it and we'll tell you when your idea ships. No spam.")}</p>
          </div>
          <Button type="submit" size="sm" className="w-full" disabled={sending || !message.trim()}>
            {sending ? t('Sending…') : t('Send')}
          </Button>
          <a href={`mailto:${CONTACT}?subject=${encodeURIComponent('Nothing But Fin')}`} className="flex items-center justify-center gap-1.5 border-t pt-3 text-xs text-muted-foreground hover:text-foreground">
            <Mail className="size-3.5" /> {t('Or email me directly: {email}', { email: CONTACT })}
          </a>
        </form>
      </PopoverContent>
    </Popover>
  )
}
