/** Validate task-page request provenance; this does not identify a user. */
export function taskCenterBrowserAllowed(input: {
  method: string
  serverOrigin: string
  headers: Record<string, string | undefined>
}): boolean {
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
