import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { inArray, sql } from 'drizzle-orm'
import { initializeDb } from '../../../db/client'
import { rosterFileClassification, storedFile } from '../../../db/schema'
import { createFileStore, sha256Of, type FileCategoryServer, type FileStoreDb, type FileQueryFilters, type RegistrationWriter } from '../../../server/utils/file-store'
import { extendFileOpenApi } from '../../../server/utils/file-openapi'
import { rosterFileServerCategory } from '../../../server/modules/sme-roster/files'
import { createTus, TUS_PATH } from '../../../server/utils/tus'

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'file-categories-')) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const isCatalogPath = (path: string) => path.startsWith('catalog/')
const catalog = {
  id: 'catalog',
  filters: [{
    key: 'collection', label: '馆藏', placeholder: '全部馆藏', width: 'w-28',
    options: [{ value: 'local', label: '本地' }, { value: 'remote', label: '外部' }],
    description: '馆藏,多值:`local` / `remote`。',
  }],
  readFields(db: FileStoreDb, ids: readonly number[]) {
    return new Map(db.all<{ file_id: number; collection: string }>(sql`
      select file_id, collection from collection_file where file_id in ${ids}
    `).map(({ file_id, collection }) => [file_id, { collection }]))
  },
  constraint(db: FileStoreDb, filters: FileQueryFilters) {
    if (!filters.collection?.length) return
    const matching = db.all<{ file_id: number }>(sql`
      select file_id from collection_file where collection in ${filters.collection}
    `)
    return inArray(storedFile.id, matching.map(row => row.file_id))
  },
  prepareBackfill(path: string) {
    if (!isCatalogPath(path)) return null
    return (db: FileStoreDb, id: number) => {
      db.run(sql`insert into collection_file values (${id}, 'local')`)
    }
  },
  landing: (metadata: Record<string, string | null | undefined>) => ['catalog', metadata.filename!],
  registration: {
    matchesPath: isCatalogPath,
    prepare(input: Record<string, unknown>): RegistrationWriter {
      // The fixture owns the catalog layout and classification, just as it does for backfill.
      const relPath = String(input.relPath)
      const write = catalog.prepareBackfill(relPath)
      if (!/^catalog\/[^/]+\.pdf$/.test(relPath) || !write || Object.keys(input).length !== 1) {
        throw h3.createError({ statusCode: 400 })
      }
      return async (db, { filename, abs, bytes }) => {
        const sha256 = await sha256Of(abs)
        return db.transaction(tx => {
          const row = tx.insert(storedFile).values({ relPath, filename, ext: 'pdf', bytes, sha256 }).returning().get()
          write(tx, row.id)
          return { row: { ...row, displayName: filename, collection: 'local' }, created: true }
        })
      }
    },
  },
  metadata: {
    properties: { collection: { type: 'string' } },
    parse: (input: Record<string, unknown>) => ({ collection: String(input.collection) }),
    write(db: FileStoreDb, id: number, patch: Record<string, unknown>) {
      return db.run(sql`update collection_file set collection = ${patch.collection} where file_id = ${id}`).changes === 1
    },
  },
}
const categories = [rosterFileServerCategory, catalog] as const

function createDb(name: string) {
  const db = initializeDb({ create: true, dbPath: join(dir, name + '.sqlite') })
  db.run(sql`create table collection_file (file_id integer primary key, collection text)`)
  return db
}

it('composes a second registered category for backfill, fields, filters, placement and metadata', () => {
  const db = createDb('backfill')
  const files = createFileStore(categories)
  const list = { parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }] }
  extendFileOpenApi({ paths: { '/api/files': { get: list } } }, categories)
  expect(list.parameters.map(parameter => parameter.name))
    .toEqual(['source', 'categoryState', 'parseState', 'collection', 'q'])
  const scan = (relPath: string, filename: string) => ({ relPath, filename, bytes: 3, ext: 'pdf', sha256: 'a'.repeat(64) })
  expect(files.backfillStoredFiles(db, [
    scan('jxj/announcement/2024/notice.pdf', 'notice.pdf'),
    scan('catalog/guide.pdf', 'guide.pdf'),
  ])).toMatchObject({ inserted: 2, skipped: [] })

  const { rows, total } = files.listStoredFiles(db, { collection: 'local' })
  expect(total).toBe(1)
  const [guide] = rows
  expect(guide).toMatchObject({ filename: 'guide.pdf', collection: 'local' })
  expect(files.getStoredFile(db, guide!.id)).toMatchObject({ collection: 'local' })
  expect(files.listStoredFiles(db, { source: 'jxj', collection: 'local' }).total).toBe(0)

  expect(files.resolveUploadPlacement({ fileCategory: 'catalog', filename: 'guide.pdf' }).segments).toEqual(['catalog', 'guide.pdf'])
  expect(files.resolveUploadPlacement({ source: 'jxj', kind: 'announcement', filename: 'notice.pdf' }).segments)
    .toEqual(['jxj', 'announcement', 'notice.pdf'])

  const notice = files.listStoredFiles(db, { q: 'notice' }).rows[0]!
  // A combined patch may reach more than one owner. A declined write rolls back all changes.
  const mixedPatch = files.parseMetadataPatch({ year: '2026', collection: 'remote' })
  expect(mixedPatch).toEqual({ year: 2026, collection: 'remote' })
  expect(files.updateStoredFile(db, notice.id, mixedPatch)).toBeNull()
  expect(files.getStoredFile(db, notice.id)).toMatchObject({ year: 2024 })
  expect(files.updateStoredFile(db, guide!.id, files.parseMetadataPatch({ collection: 'remote' })))
    .toMatchObject({ collection: 'remote' })
  expect(files.listStoredFiles(db, { collection: ['remote', 'local'] }).total).toBe(1)
})

async function uploadAndRegisterFixture(name: string, installed: readonly FileCategoryServer[] = categories, db = createDb(name)) {
  const filesDir = join(dir, name)
  const tus = createTus({
    filesDir, incomingDir: join(dir, name + '-incoming'), allowedOrigins: [],
    landing: createFileStore(installed).resolveUploadPlacement,
  })
  // Install the second module at the application composition boundary. HTTP handlers,
  // tus protocol, file-store dispatch and SQLite run unchanged.
  vi.resetModules()
  vi.doMock('../../../server/file-category-modules', () => ({ serverFileCategories: installed }))
  vi.doMock('@db', () => ({ useDb: () => db }))
  for (const key of ['defineEventHandler', 'createError', 'readBody', 'setResponseStatus', 'getQuery', 'setHeader', 'getRouterParam'] as const) {
    vi.stubGlobal(key, h3[key])
  }
  vi.stubGlobal('useRuntimeConfig', () => ({ filesDir }))
  const base = 'http://localhost'
  const registerRoute = (await import('../../../server/api/files/register.post')).default
  const listRoute = (await import('../../../server/api/files/index.get')).default
  const detailRoute = (await import('../../../server/api/files/[id]/maintenance.get')).default
  const router = h3.createRouter()
    .post('/api/files/register', registerRoute)
    .get('/api/files', listRoute)
    .get('/api/files/:id/maintenance', detailRoute)
  const errors: string[] = []
  const app = h3.createApp({ onError: error => { errors.push(error.message) } })
  const http = h3.toWebHandler(app.use(router))
  async function uploadResponse(metadata: Record<string, string>) {
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
      body: 'abc',
    }))
  }
  return {
    db,
    errors,
    uploadResponse,
    async upload(metadata: Record<string, string>) {
      const finish = await uploadResponse(metadata)
      expect(finish.status).toBe(204)
      return decodeURIComponent(finish.headers.get('X-Upload-Path')!)
    },
    async request(path: string, input?: Record<string, unknown>) {
      const response = await http(new Request(base + path, input && {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }))
      return { status: response.status, body: await response.json() }
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('../../../server/file-category-modules')
  vi.doUnmock('@db')
})

function expectNoRegistrationRows(db: FileStoreDb) {
  expect(db.select().from(storedFile).all()).toEqual([])
  expect(db.select().from(rosterFileClassification).all()).toEqual([])
  expect(db.all(sql`select * from collection_file`)).toEqual([])
}

it('rejects a category with a placement and writer but no path routing declaration', async () => {
  const name = 'no-matcher'
  const db = createDb(name)
  const registration = { ...catalog.registration }
  // Simulate a declaration that reaches composition without static type checking.
  Reflect.deleteProperty(registration, 'matchesPath')
  try {
    const attempt = async () => {
      const { upload, request } = await uploadAndRegisterFixture(name, [
        rosterFileServerCategory, { ...catalog, registration },
      ], db)
      const relPath = await upload({ fileCategory: 'catalog', filename: 'guide.pdf' })
      expect(relPath).toBe('catalog/guide.pdf')
      return request('/api/files/register', { relPath })
    }
    await expect(attempt()).rejects.toThrow('catalog: registration requires matchesPath')
    expectNoRegistrationRows(db)
  } finally {
    db.$client.close()
  }
})

it('rejects overlapping registration path claims without choosing a writer', async () => {
  const { db, uploadResponse, request } = await uploadAndRegisterFixture('ambiguous', [
    ...categories, { ...catalog, id: 'other-catalog' },
  ])
  try {
    const upload = await uploadResponse({ fileCategory: 'catalog', filename: 'guide.pdf' })
    expect(upload.status).toBe(400)
    expect(await upload.text()).toContain('落位路径匹配多个上传分类')
    const relPath = 'catalog/guide.pdf'
    expect((await request('/api/files/register', { relPath })).status).toBe(400)
    expect((await request('/api/files/register', { relPath, fileCategory: 'catalog' })).status).toBe(400)
    expect(await request('/api/files')).toMatchObject({ status: 200, body: { total: 0, rows: [] } })
    expectNoRegistrationRows(db)
  } finally {
    db.$client.close()
  }
})

it('rejects a collision suffix that would route the landed file to a different writer', async () => {
  const { db, upload, uploadResponse } = await uploadAndRegisterFixture('collision', [
    rosterFileServerCategory,
    { ...catalog, registration: { ...catalog.registration, matchesPath: path => path === 'catalog/guide.pdf' } },
  ])
  try {
    expect(await upload({ fileCategory: 'catalog', filename: 'guide.pdf' })).toBe('catalog/guide.pdf')
    const second = await uploadResponse({ fileCategory: 'catalog', filename: 'guide.pdf' })
    expect(second.status).toBe(400)
    expect(second.headers.get('X-Upload-Path')).toBeNull()
    expect(await second.text()).toContain('上传分类与实际落位不符')
    expect(readdirSync(join(dir, 'collision', 'catalog'))).toEqual(['guide.pdf'])
    expectNoRegistrationRows(db)
  } finally {
    db.$client.close()
  }
})

it.each([true, false])('registers only the catalog classification after tus upload (explicit selector: %s)', async explicit => {
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
    expect(db.select().from(rosterFileClassification).all()).toEqual([])
    expect(await request('/api/files?collection=local')).toMatchObject({ status: 200, body: { total: 1, rows: [file] } })
    expect(await request('/api/files?categoryState=unset')).toMatchObject({ status: 200, body: { total: 0, rows: [] } })
    expect(await request(`/api/files/${file.id}/maintenance`)).toMatchObject({ status: 200, body: { file } })
  } finally {
    db.$client.close()
  }
})

it.each([true, false])('rejects catalog admission before either writer persists (explicit selector: %s)', async explicit => {
  const name = explicit ? 'denied-explicit' : 'denied-implicit'
  const { db, errors, upload, request } = await uploadAndRegisterFixture(name, [
    rosterFileServerCategory,
    {
      ...catalog,
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
    expectNoRegistrationRows(db)
  } finally {
    db.$client.close()
  }
})

it.each([
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
      expectNoRegistrationRows(db)
    }
    expect(errors).toEqual([detail, detail])
  } finally {
    db.$client.close()
  }
})

it('rejects unknown and mismatched selectors and preserves legacy no-selector registration', async () => {
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
    db.$client.close()
  }
})
