// An anonymous random id for counting visitors (UV / PV); no personal data, and separate from the
// private calendar id. index.html makes it on the first visit, the same way.
const KEY = 'fsv-visitor'

export function visitorId(): string {
  try {
    let id = localStorage.getItem(KEY)
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
      localStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return ''
  }
}
export const visitorHeaders = (): Record<string, string> => ({ 'X-Visitor': visitorId() })
