import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { eq, inArray, sql } from 'drizzle-orm'
import { sha256Of, type FileCategoryServer, type FileQueryFilters, type RegistrationWriter } from '../../../layers/core/server/utils/file-store-contract'
import { rosterFileServerCategory } from '../../../layers/sme-roster/server/modules/sme-roster/files'
import { createTus, TUS_PATH } from '../../../layers/core/server/utils/tus'
import { libraryFileServerCategory } from '../../../layers/core/server/utils/library-file-category'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { lockOrRegisterPostgresFile } from '../../../layers/core/server/utils/file-store-postgres'
import { storedFile as postgresFile } from '../../../db/postgresql/file-tables'
import { rosterFileClassification as postgresClassification } from '../../../db/postgresql/roster-file-tables'
import { businessSchema } from '../../../db/postgresql/business-schema'
import { bigint, text } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { usePostgresDirectoryDb, closePostgresDirectoryDb } from '../../../db/postgresql/client'

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'file-categories-')) })
afterAll(() => {
  try { runtime?.close() }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

const isCatalogPath = (path: string) => path.startsWith('catalog/')
const catalog = {
  id: 'catalog',
  filters: [{
    key: 'collection', label: '馆藏', placeholder: '全部馆藏', width: 'w-28',
    options: [{ value: 'local', label: '本地' }, { value: 'remote', label: '外部' }],
    description: '馆藏,多值:`local` / `remote`。',
  }],
  landing: (metadata: Record<string, string | null | undefined>) => ['catalog', metadata.filename!],
  metadata: {
    properties: { collection: { type: 'string' } },
    parse: (input: Record<string, unknown>) => ({ collection: String(input.collection) }),
    async writePostgres(db: NodePgDatabase, file: { id: number }, patch: Record<string, unknown>) {
      const rows = await db.update(collectionFile).set({ collection: String(patch.collection) })
        .where(eq(collectionFile.fileId, file.id)).returning({ id: collectionFile.fileId })
      return rows.length === 1
    },
  },
}
const collectionFile = businessSchema.table('collection_file', {
  fileId: bigint('file_id', { mode: 'number' }).primaryKey(),
  collection: text().notNull(),
})
const postgresCatalog = {
  ...catalog,
  postgres: {
    async readFields(db: NodePgDatabase, ids: readonly number[]) {
      const rows = await db.select().from(collectionFile).where(inArray(collectionFile.fileId, [...ids]))
      return new Map(rows.map(({ fileId, collection }) => [fileId, { collection }]))
    },
    constraint(filters: FileQueryFilters) {
      if (!filters.collection?.length) return
      // Use a relational membership test so multiple category filters intersect.
      return sql`exists (select 1 from ${collectionFile} where ${collectionFile.fileId} = ${postgresFile.id} and ${inArray(collectionFile.collection, [...filters.collection])})`
    },
  },
  registration: {
    matchesPath: isCatalogPath,
    preparePostgres(input: Record<string, unknown>): RegistrationWriter<NodePgDatabase> {
      const relPath = String(input.relPath)
      if (!/^catalog\/[^/]+\.pdf ?$/.test(relPath) || Object.keys(input).length !== 1) {
        throw h3.createError({ statusCode: 400 })
      }
      return async (db, { filename, abs, bytes }) => {
        const sha256 = await sha256Of(abs)
        return db.transaction(async tx => {
          const result = await lockOrRegisterPostgresFile(tx, { relPath, filename, ext: 'pdf', bytes, sha256 })
          if (result.created) await tx.insert(collectionFile).values({ fileId: result.row.id, collection: 'local' })
          return { ...result, row: { ...result.row, collection: 'local' } }
        })
      }
    },
  },
}
const postgresCategories = [rosterFileServerCategory, postgresCatalog] as const

let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
const live = it.skipIf(!process.env.ROSTER_TEST_POSTGRES_BIN)

async function uploadAndRegisterFixture(name: string, installed: readonly FileCategoryServer[] = postgresCategories) {
  const filesDir = join(dir, name)
  runtime ??= await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', runtime.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  runtime.psql(['-c', 'TRUNCATE business.stored_file CASCADE; DROP TABLE IF EXISTS business.collection_file; CREATE TABLE business.collection_file (file_id bigint PRIMARY KEY, collection text NOT NULL)'])
  const db = usePostgresDirectoryDb()
  const registry = await import('../../../layers/core/server/utils/file-category-runtime')
  registry.configurePostgresFileCategories(installed)
  const tus = createTus({
    filesDir, incomingDir: join(dir, name + '-incoming'), allowedOrigins: [],
    landing: metadata => registry.postgresFileCategoryRules.resolveUploadPlacement(metadata),
  })
  for (const key of ['defineEventHandler', 'createError', 'readBody', 'setResponseStatus', 'getQuery', 'setHeader', 'getRouterParam'] as const) {
    vi.stubGlobal(key, h3[key])
  }
  vi.stubGlobal('useRuntimeConfig', () => ({ filesDir }))
  const base = 'http://localhost'
  const registerRoute = (await import('../../../layers/core/server/api/files/register.post')).default
  const listRoute = (await import('../../../layers/core/server/api/files/index.get')).default
  const libraryRoute = (await import('../../../layers/core/server/api/file-library.get')).default
  const rosterRoute = (await import('../../../layers/sme-roster/server/api/sme-roster/files.get')).default
  const patchRoute = (await import('../../../layers/core/server/api/files/[id].patch')).default
  const detailRoute = (await import('../../../layers/core/server/api/files/[id]/maintenance.get')).default
  const router = h3.createRouter()
    .post('/api/files/register', registerRoute)
    .get('/api/files', listRoute)
    .get('/api/file-library', libraryRoute)
    .get('/api/sme-roster/files', rosterRoute)
    .get('/api/files/:id/maintenance', detailRoute)
    .patch('/api/files/:id', patchRoute)
  const errors: string[] = []
  const app = h3.createApp({ onError: error => { errors.push(error.message) } })
  const http = h3.toWebHandler(app.use(router))
  async function uploadResponse(metadata: Record<string, string>, body = 'abc') {
    const headers = { 'Tus-Resumable': '1.0.0' }
    const create = await tus.handleWeb(new Request(base + TUS_PATH, {
      method: 'POST',
      headers: {
        ...headers,
        'Upload-Length': '3',
        'Upload-Metadata': Object.entries(metadata).map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`).join(','),
      },
    }))
    if (create.status !== 201) return create
    return tus.handleWeb(new Request(new URL(create.headers.get('location')!, base), {
      method: 'PATCH',
      headers: { ...headers, 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' },
      body,
    }))
  }
  return {
    db,
    errors,
    uploadResponse,
    async upload(metadata: Record<string, string>, body?: string) {
      const finish = await uploadResponse(metadata, body)
      expect(finish.status).toBe(204)
      return decodeURIComponent(finish.headers.get('X-Upload-Path')!)
    },
    async request(path: string, input?: Record<string, unknown>, method = 'POST') {
      const response = await http(new Request(base + path, input && {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }))
      return { status: response.status, body: await response.json() }
    },
  }
}

afterEach(async () => {
  await closePostgresDirectoryDb()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

live('uploads ordinary files without roster classification and lists shared originals by scope', async () => {
  const { upload, request, db } = await uploadAndRegisterFixture('library-and-roster', [libraryFileServerCategory, ...postgresCategories])
  const plain = await upload({ fileCategory: 'core', filename: '入库培育附件.txt' }, 'abc')
  expect(plain).toBe('uploads/入库培育附件.txt')
  const original = await request('/api/files/register', { fileCategory: 'core', relPath: plain })
  expect(original.status).toBe(201)
  expect(original.body).toMatchObject({ relPath: plain, filename: '入库培育附件.txt', bytes: 3 })
  expect(await request('/api/files/register', { fileCategory: 'core', relPath: plain })).toMatchObject({
    status: 200, body: { id: original.body.id },
  })

  const notice = await upload({ source: 'jxj', kind: 'announcement', year: '2024', filename: '正式名单.pdf' }, 'pdf')
  const registeredNotice = await request('/api/files/register', { relPath: notice, source: 'jxj', kind: 'announcement', year: '2024' })
  expect(registeredNotice.status).toBe(201)
  const global = await request('/api/file-library?source=miit')
  expect(global.status).toBe(200)
  expect(global.body.total).toBe(2)
  expect(global.body.rows.map((row: { id: number }) => row.id).sort()).toEqual([original.body.id, registeredNotice.body.id].sort())
  expect(global.body.rows.every((row: object) => !('categoryState' in row || 'referenceCount' in row || 'parts' in row))).toBe(true)
  expect(await request('/api/sme-roster/files?source=jxj')).toMatchObject({
    status: 200, body: { total: 1, rows: [{ id: registeredNotice.body.id, source: 'jxj', year: 2024, parts: [] }] },
  })
  expect(await request('/api/sme-roster/files?q=入库培育附件')).toEqual({ status: 200, body: { total: 0, rows: [] } })
  expect(await db.select({ id: postgresClassification.fileId }).from(postgresClassification)).toEqual([{ id: registeredNotice.body.id }])
}, 30_000)

live('updates contributed metadata and rolls back a patch rejected by another category', async () => {
  const { upload, request } = await uploadAndRegisterFixture('category-metadata')
  const catalogPath = await upload({ fileCategory: 'catalog', filename: 'guide.pdf' })
  const catalogFile = await request('/api/files/register', { relPath: catalogPath })
  expect(catalogFile.status).toBe(201)
  const noticePath = await upload({ source: 'jxj', kind: 'announcement', year: '2024', filename: 'notice.pdf' })
  const notice = await request('/api/files/register', { relPath: noticePath, source: 'jxj', kind: 'announcement', year: 2024 })
  expect(notice.status).toBe(201)

  expect(await request('/api/files?collection=local')).toMatchObject({
    status: 200, body: { total: 1, rows: [{ id: catalogFile.body.id, collection: 'local' }] },
  })
  expect(await request('/api/files?source=jxj&collection=local')).toMatchObject({
    status: 200, body: { total: 0, rows: [] },
  })
  expect(await request('/api/files/' + notice.body.id, { year: 2026, collection: 'remote' }, 'PATCH'))
    .toMatchObject({ status: 404 })
  expect(await request('/api/files?source=jxj')).toMatchObject({
    status: 200, body: { total: 1, rows: [{ id: notice.body.id, year: 2024 }] },
  })
  expect(await request('/api/files/' + catalogFile.body.id, { collection: 'remote' }, 'PATCH'))
    .toMatchObject({ status: 200, body: { id: catalogFile.body.id, collection: 'remote' } })
  expect(await request('/api/files?collection=remote')).toMatchObject({
    status: 200, body: { total: 1, rows: [{ id: catalogFile.body.id, collection: 'remote' }] },
  })
}, 20_000)

async function expectNoRegistrationRows(db: NodePgDatabase) {
  expect(await db.select().from(postgresFile)).toEqual([])
  expect(await db.select().from(postgresClassification)).toEqual([])
  expect(await db.select().from(collectionFile)).toEqual([])
}

live('rejects a category with a placement and writer but no path routing declaration', async () => {
  const name = 'no-matcher'
  const registration = { ...postgresCatalog.registration }
  // Simulate a declaration that reaches composition without static type checking.
  Reflect.deleteProperty(registration, 'matchesPath')
  try {
    const attempt = async () => {
      const { upload, request } = await uploadAndRegisterFixture(name, [
        rosterFileServerCategory, { ...postgresCatalog, registration },
      ])
      const relPath = await upload({ fileCategory: 'catalog', filename: 'guide.pdf' })
      expect(relPath).toBe('catalog/guide.pdf')
      return request('/api/files/register', { relPath })
    }
    await expect(attempt()).rejects.toThrow('catalog: registration requires matchesPath')
    await expectNoRegistrationRows(usePostgresDirectoryDb())
  } finally {
    await closePostgresDirectoryDb()
  }
})

live('rejects overlapping registration path claims without choosing a writer', async () => {
  const { db, uploadResponse, request } = await uploadAndRegisterFixture('ambiguous', [
    ...postgresCategories, { ...postgresCatalog, id: 'other-catalog' },
  ])
  try {
    const upload = await uploadResponse({ fileCategory: 'catalog', filename: 'guide.pdf' })
    expect(upload.status).toBe(400)
    expect(await upload.text()).toContain('落位路径匹配多个上传分类')
    const relPath = 'catalog/guide.pdf'
    expect((await request('/api/files/register', { relPath })).status).toBe(400)
    expect((await request('/api/files/register', { relPath, fileCategory: 'catalog' })).status).toBe(400)
    expect(await request('/api/files')).toMatchObject({ status: 200, body: { total: 0, rows: [] } })
    await expectNoRegistrationRows(db)
  } finally {
    await closePostgresDirectoryDb()
  }
})

live('rejects a collision suffix that would route the landed file to a different writer', async () => {
  const { db, upload, uploadResponse } = await uploadAndRegisterFixture('collision', [
    rosterFileServerCategory,
    { ...postgresCatalog, registration: { ...postgresCatalog.registration, matchesPath: path => path === 'catalog/guide.pdf' } },
  ])
  try {
    expect(await upload({ fileCategory: 'catalog', filename: 'guide.pdf' })).toBe('catalog/guide.pdf')
    const second = await uploadResponse({ fileCategory: 'catalog', filename: 'guide.pdf' })
    expect(second.status).toBe(400)
    expect(second.headers.get('X-Upload-Path')).toBeNull()
    expect(await second.text()).toContain('上传分类与实际落位不符')
    expect(readdirSync(join(dir, 'collision', 'catalog'))).toEqual(['guide.pdf'])
    await expectNoRegistrationRows(db)
  } finally {
    await closePostgresDirectoryDb()
  }
})

live.each([true, false])('registers only the catalog classification after tus upload (explicit selector: %s)', async explicit => {
  const { db, upload, request } = await uploadAndRegisterFixture(explicit ? 'explicit' : 'implicit')
  try {
    const relPath = await upload({ fileCategory: 'catalog', filename: 'guide.pdf' })
    expect(relPath).toBe('catalog/guide.pdf')
    const input = explicit ? { relPath, fileCategory: 'catalog' } : { relPath }
    const registered = await request('/api/files/register', input)
    expect(registered.status, JSON.stringify(registered.body)).toBe(201)
    const file = {
      id: registered.body.id, relPath, filename: 'guide.pdf', bytes: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      collection: 'local',
    }
    expect(registered.body).toMatchObject(file)
    expect(await db.select().from(postgresClassification)).toEqual([])
    expect(await request('/api/files?collection=local')).toMatchObject({ status: 200, body: { total: 1, rows: [file] } })
    expect(await request('/api/files?categoryState=unset')).toMatchObject({ status: 200, body: { total: 0, rows: [] } })
    expect(await request(`/api/files/${file.id}/maintenance`)).toMatchObject({ status: 200, body: { file } })
  } finally {
    await closePostgresDirectoryDb()
  }
})

live.each([true, false])('registers the exact landed path and bytes (explicit selector: %s)', async explicit => {
  const { db, upload, request } = await uploadAndRegisterFixture(`exact-path-${explicit}`)
  try {
    const sibling = await upload({ fileCategory: 'catalog', filename: 'guide.pdf' })
    const relPath = await upload({ fileCategory: 'catalog', filename: 'guide.pdf ' }, 'xyz')
    expect(sibling).toBe('catalog/guide.pdf')
    expect(relPath).toBe('catalog/guide.pdf ')
    const input = explicit ? { relPath, fileCategory: 'catalog' } : { relPath }
    expect(await request('/api/files/register', input)).toMatchObject({
      status: 201,
      body: { relPath, filename: 'guide.pdf ', sha256: '3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282' },
    })
    expect(await db.select({ relPath: postgresFile.relPath }).from(postgresFile)).toEqual([{ relPath }])
  } finally {
    await closePostgresDirectoryDb()
  }
})

live.each([true, false])('rejects catalog admission before either writer persists (explicit selector: %s)', async explicit => {
  const name = explicit ? 'denied-explicit' : 'denied-implicit'
  const { db, errors, upload, request } = await uploadAndRegisterFixture(name, [
    rosterFileServerCategory,
    {
      ...postgresCatalog,
      admission: (path, siblings) => path === 'catalog/guide.pdf' && siblings?.has('exclusion.pdf')
        ? { inScope: false, reason: 'catalog-denied', detail: 'catalog exclusion' }
        : { inScope: true, reason: 'in-scope', detail: 'catalog eligible' },
    },
  ])
  try {
    await upload({ fileCategory: 'catalog', filename: 'exclusion.pdf' })
    const relPath = await upload({ fileCategory: 'catalog', filename: 'guide.pdf' })
    const input = explicit ? { relPath, fileCategory: 'catalog' } : { relPath }
    const result = await request('/api/files/register', input)
    expect(result).toMatchObject({
      status: 400, body: { data: { reason: 'catalog-denied' } },
    })
    expect(errors).toEqual(['catalog exclusion'])
    expect(await request('/api/files')).toMatchObject({ status: 200, body: { total: 0, rows: [] } })
    await expectNoRegistrationRows(db)
  } finally {
    await closePostgresDirectoryDb()
  }
})

live.each([
  ['入库培育.pdf', null, 'nurture', '文件名含「入库培育」—— 培育对象不构成称号,按 lib/file-store-scope.ts 排除'],
  ['名单.doc', '名单.docx', 'duplicate-doc', '同目录已有同名 .docx(可预览的转出件)—— 重复的旧版 .doc 不入库'],
  ['识别.docx', '识别.pdf', 'human-ocr-docx', '同目录已有同名 .pdf —— 该 .docx 是人工 OCR 产物,PDF 才是权威原件'],
])('preserves the roster admission reason and message for %s', async (filename, sibling, reason, detail) => {
  const { db, errors, upload, request } = await uploadAndRegisterFixture(reason)
  try {
    const layout = { source: 'jxj', kind: 'announcement', year: '2024' }
    if (sibling) await upload({ ...layout, filename: sibling })
    const relPath = await upload({ ...layout, filename })
    for (const selector of [{}, { fileCategory: 'sme-roster' }]) {
      const result = await request('/api/files/register', { relPath, ...layout, ...selector })
      expect(result).toMatchObject({ status: 400, body: { data: { reason } } })
      await expectNoRegistrationRows(db)
    }
    expect(errors).toEqual([detail, detail])
  } finally {
    await closePostgresDirectoryDb()
  }
})

live('rejects unknown and mismatched selectors and preserves legacy no-selector registration', async () => {
  const { db, upload, request } = await uploadAndRegisterFixture('legacy')
  try {
    const relPath = await upload({ fileCategory: 'catalog', filename: 'guide.pdf' })
    for (const fileCategory of ['unknown', 'sme-roster']) {
      expect((await request('/api/files/register', { relPath, fileCategory })).status).toBe(400)
    }
    expect(await request('/api/files')).toMatchObject({ status: 200, body: { total: 0, rows: [] } })

    const legacy = await upload({ source: 'jxj', kind: 'announcement', year: '2024', batch: '1', filename: 'notice.pdf' })
    expect(legacy).toBe('jxj/announcement/2024/1/notice.pdf')
    const declared = await request('/api/files/register', { relPath: legacy, source: 'jxj', kind: 'announcement', year: 2024, batch: 1 })
    expect(declared).toMatchObject({ status: 201, body: { source: 'jxj', kind: 'announcement', year: 2024, batch: 1, categoryState: 'set' } })
    const unclassified = await upload({ source: 'miit', kind: 'export', filename: 'export.pdf' })
    const input = { relPath: unclassified }
    const result = await request('/api/files/register', input)
    expect(result).toMatchObject({ status: 201, body: { source: null, kind: null, year: null, batch: null, categoryState: 'unset' } })
    expect(await request('/api/files/register', input)).toMatchObject({ status: 200, body: { id: result.body.id } })
    expect(await request('/api/files?collection=local')).toMatchObject({ status: 200, body: { total: 0, rows: [] } })
  } finally {
    await closePostgresDirectoryDb()
  }
})
