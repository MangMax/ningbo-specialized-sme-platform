import { destr } from 'destr'
import type { H3Event } from 'h3'

// Match Nuxt's JSON parser in archive tests that run routes through bare H3.
export function withNuxtJsonBody(h3: typeof import('h3')) {
  return {
    ...h3,
    readBody: async (event: H3Event) => {
      if (event.req.headers.get('content-type') === 'application/json') {
        return destr(await event.req.text(), { strict: true })
      }
      return h3.readBody(event)
    },
  }
}
