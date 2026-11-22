import { createRuntimeSchema } from '../../../db/create-runtime'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '../../../db/schema'
import { registerStoredFile, parseUploadDeclaration } from '../../../layers/sme-roster/server/modules/sme-roster/file-upload-sqlite'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { usePostgresDirectoryDb, closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { storedFile } from '../../../db/postgresql/file-tables'
import { registerPostgresFile } from '../../../layers/core/server/utils/file-store-postgres'

let root: string
const fixtureDir = mkdtempSync(join(tmpdir(), 'read-identity-'))
let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>>
let db: ReturnType<typeof usePostgresDirectoryDb>
let locator = 'notice.txt'
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
beforeAll(async () => { runtime = await postgresRuntimeFixture({ dir: fixtureDir }) })
afterAll(async () => {
  try { await closePostgresDirectoryDb(); runtime?.close() }
  finally { rmSync(fixtureDir, { recursive: true, force: true }) }
})
beforeEach(() => {
  root = mkdtempSync(join(fixtureDir, 'files-'))
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', runtime.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  db = usePostgresDirectoryDb()
  runtime.psql(['-c', 'TRUNCATE business.stored_file CASCADE'])
  locator = 'notice.txt'
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: root }))
  vi.stubGlobal('getRouterParam', () => locator)
  vi.stubGlobal('getRequestHeader', () => undefined)
  vi.stubGlobal('getQuery', () => ({}))
  vi.stubGlobal('createError', (error: object) => Object.assign(new Error('read denied'), error))
  vi.stubGlobal('setResponseStatus', () => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

it('raw path and stable ID reject same-size replacement and allow exact original recovery', async () => {
  writeFileSync(join(root, locator), 'abc')
  const { row } = await registerPostgresFile(db, root, { relPath: locator }, {})
  const headers = new Map<string, unknown>()
  vi.stubGlobal('setHeader', (_: unknown, key: string, value: unknown) => headers.set(key, value))
  vi.stubGlobal('sendStream', async (_: unknown, stream: import('node:fs').ReadStream) => { let text = ''; for await (const chunk of stream) text += chunk; return text })
  const route = (await import('../../../layers/core/server/api/files/[id].get')).default
  expect(await route({} as never)).toBe('abc')
  expect(headers.get('cache-control')).toContain('no-store')
  expect(headers.get('x-file-id')).toBe(String(row.id))
  expect(headers.get('x-file-sha256')).toBe(ABC)
  writeFileSync(join(root, locator), 'xyz')
  await expect(route({} as never)).rejects.toMatchObject({ statusCode: 409, data: { code: 'file_content_conflict', fileId: row.id, registered: { sha256: ABC, bytes: 3 } } })
  locator = String(row.id)
  await expect(route({} as never)).rejects.toMatchObject({ statusCode: 409 })
  writeFileSync(join(root, 'notice.txt'), 'abc')
  expect(await route({} as never)).toBe('abc')
})

it('unregistered legacy paths stay readable with explicitly unknown history', async () => {
  writeFileSync(join(root, locator), 'legacy bytes')
  const headers = new Map<string, unknown>()
  vi.stubGlobal('setHeader', (_: unknown, key: string, value: unknown) => headers.set(key, value))
  vi.stubGlobal('sendStream', async (_: unknown, stream: import('node:fs').ReadStream) => { let text = ''; for await (const chunk of stream) text += chunk; return text })
  const route = (await import('../../../layers/core/server/api/files/[id].get')).default
  expect(await route({} as never)).toBe('legacy bytes')
  expect(headers.get('x-file-content-status')).toBe('unknown')
  expect(headers.get('x-file-historical-identity')).toBe('unknown')
  expect(headers.has('x-file-id')).toBe(false)
  expect(await db.select().from(storedFile)).toEqual([])
})

it('raw page URLs reject foreign lineage and retain unknown legacy pages without accepting source replacement', async () => {
  writeFileSync(join(root, 'notice.pdf'), 'abc')
  const { row } = await registerPostgresFile(db, root, { relPath: 'notice.pdf' }, {})
  mkdirSync(join(root, '.notice.pdf.pages'))
  writeFileSync(join(root, '.notice.pdf.pages/p001.png'), 'png')
  locator = '.notice.pdf.pages/p001.png'
  const manifest = { version: 2, file: 'notice.pdf', sourceBytes: 3, sourceSha256: '3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282', pages: [{ relPath: locator, bytes: 3 }] }
  writeFileSync(join(root, '.notice.pdf.pages/.pages.json'), JSON.stringify(manifest))
  const headers = new Map<string, unknown>()
  vi.stubGlobal('setHeader', (_: unknown, key: string, value: unknown) => headers.set(key, value))
  vi.stubGlobal('sendStream', async (_: unknown, stream: import('node:fs').ReadStream) => { let text = ''; for await (const chunk of stream) text += chunk; return text })
  const route = (await import('../../../layers/core/server/api/files/[id].get')).default
  await expect(route({} as never)).rejects.toMatchObject({ statusCode: 409, data: { code: 'file_content_conflict', fileId: row.id, reason: 'page_source_mismatch' } })
  writeFileSync(join(root, '.notice.pdf.pages/.pages.json'), JSON.stringify({ ...manifest, file: 'another.pdf', sourceSha256: ABC }))
  await expect(route({} as never)).rejects.toMatchObject({ statusCode: 409, data: { code: 'file_content_conflict', fileId: row.id, reason: 'page_source_mismatch' } })
  rmSync(join(root, '.notice.pdf.pages/.pages.json'))
  expect(await route({} as never)).toBe('png')
  expect(headers.get('x-file-content-status')).toBe('unknown')
  expect(headers.get('x-file-historical-identity')).toBe('unknown')
  writeFileSync(join(root, 'notice.pdf'), 'xyz')
  await expect(route({} as never)).rejects.toMatchObject({ statusCode: 409, data: { code: 'file_content_conflict', fileId: row.id } })
})

it('range requests cannot return replaced registered bytes', async () => {
  writeFileSync(join(root, locator), 'abc')
  await registerPostgresFile(db, root, { relPath: locator }, {})
  writeFileSync(join(root, locator), 'xyz')
  vi.stubGlobal('getRequestHeader', () => 'bytes=0-0')
  vi.stubGlobal('setHeader', () => {})
  vi.stubGlobal('sendStream', async (_: unknown, stream: import('node:fs').ReadStream) => { for await (const _chunk of stream) { /* Drain denied baseline reads before fixture teardown. */ } return 'unexpected range' })
  const route = (await import('../../../layers/core/server/api/files/[id].get')).default
  await expect(route({} as never)).rejects.toMatchObject({ statusCode: 409, data: { code: 'file_content_conflict' } })
})


it('official source reads expose registered identity while keeping historical binding unknown', async () => {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
  const db = drizzle(sqlite, { schema })
  try {
    writeFileSync(join(root, locator), 'abc')
    const { row } = await registerStoredFile(db, root, parseUploadDeclaration({ relPath: locator }))
    const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', path: locator, title: 'official fixture' }).returning().get()
    const { readOfficialSourceDocuments } = await import('../../../layers/sme-roster/server/utils/official-source-directory')
    const before = db.select().from(schema.sourceDocument).all()
    expect(readOfficialSourceDocuments(db, [doc.id])[0]).toMatchObject({ id: doc.id, path: locator, contentIdentity: { status: 'unknown', historical: 'unknown', registered: { fileId: row.id, sha256: ABC, bytes: 3 } } })
    writeFileSync(join(root, locator), 'xyz')
    expect(readOfficialSourceDocuments(db, [doc.id])[0]!.contentIdentity.historical).toBe('unknown')
    expect(db.select().from(schema.sourceDocument).all()).toEqual(before)
  } finally { sqlite.close() }
})
