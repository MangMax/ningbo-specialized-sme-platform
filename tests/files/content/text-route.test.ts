import { createRuntimeSchema } from '../../../db/create-runtime'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../db/schema'
import { afterEach, expect, it, vi } from 'vitest'
const sqlite = new Database(':memory:')
const db = drizzle(sqlite, { schema })
sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
vi.mock('@db', () => ({ useDb: () => db }))
const root = mkdtempSync(join(tmpdir(), 'preview-text-47-'))
afterEach(() => { vi.unstubAllGlobals(); sqlite.close(); rmSync(root, { recursive: true, force: true }) })
it('serves explicit text as inert text and rejects hidden sensitive files', async () => {
  writeFileSync(join(root, 'source.html'), '<script>alert(1)</script>')
  writeFileSync(join(root, '.secret.json'), '{"secret":true}')
  let path = 'source.html'
  let sent: import('node:fs').ReadStream | undefined
  const headers = new Map<string, string>()
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: root }))
  vi.stubGlobal('getRouterParam', (_event: unknown, key: string) => key === 'id' ? path : undefined)
  vi.stubGlobal('createError', (error: unknown) => error)
  vi.stubGlobal('setHeader', (_: unknown, name: string, value: string) => headers.set(name, value))
  vi.stubGlobal('getRequestHeader', () => undefined)
  vi.stubGlobal('sendStream', (_: unknown, stream: import('node:fs').ReadStream) => { sent = stream; return 'stream' })
  const route = (await import('../../../layers/core/server/api/files/[id].get')).default
  expect(await route({} as never)).toBe('stream')
  expect(headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(headers.get('x-content-type-options')).toBe('nosniff')
  expect(headers.get('content-security-policy')).toContain("default-src 'none'")
  await new Promise<void>((resolve, reject) => { sent!.on('end', resolve).on('error', reject).resume() })
  path = '.secret.json'
  await expect(route({} as never)).rejects.toThrow(expect.objectContaining({ statusCode: 415 }))
})
