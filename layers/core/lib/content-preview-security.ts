/** Only HTTP(S) links are actionable. Relative resources need an explicit caller-owned map. */
export function previewLink(value: string, resources: Readonly<Record<string, string>> = {}): string | null {
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value)
      return !url.username && !url.password ? url.href : null
    }
    const mapped = resources[value] ?? (Object.values(resources).includes(value) ? value : undefined)
    if (!mapped || !mapped.startsWith('/api/') || mapped.startsWith('//')) return null
    const url = new URL(mapped, 'https://preview.invalid')
    if (url.origin !== 'https://preview.invalid' || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decodeURIComponent(mapped))) return null
    if (!url.pathname.startsWith('/api/files/') && !url.pathname.startsWith('/api/page-images/')) return null
    return `${url.pathname}${url.search}`
  } catch { return null }
}
