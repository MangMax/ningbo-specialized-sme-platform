/** Temporary deployment capability, like browserReviewEnabled (#127 replaces it
 * with user permissions). Never returns or accepts a browser-stored API secret. */
export function taskCenterBrowserAllowed(input: {
  enabled?: boolean | string
  apiToken?: string
  method: string
  serverOrigin: string
  headers: Record<string, string | undefined>
}): boolean {
  if (input.enabled !== true || !input.apiToken?.trim()) return false
  const h = input.headers
  if (h['x-task-center-browser'] !== '1' || h['sec-fetch-site'] !== 'same-origin') return false
  try {
    const expected = new URL(input.serverOrigin).origin
    if (h.origin && h.origin !== expected) return false
    if (input.method === 'GET') {
      // Same-origin fetch GETs usually omit Origin; the browser supplies Referer.
      return !!h.referer && new URL(h.referer).origin === expected
    }
    return input.method === 'POST' && h.origin === expected
      && /^application\/json(?:\s*;|$)/i.test(h['content-type'] ?? '')
  } catch { return false }
}
