import { initializeDb } from '../../../db/client'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema, useDb } from '../../../db'
import { fileUrl } from '../../../lib/preview'
import { pageImageRelPath } from '../../../lib/pdf-page'
import { normalizeName } from '../../../lib/domain'
import { handleStoredFilePatchRequest } from '../../../server/utils/stored-file-patch-http'
import { renderPdfPages } from '../../../server/utils/pdf-pages'
import { listStoredFiles, resolveInsideRoot } from '../../../server/utils/stored-files'
import { registerStoredFile } from '../../../server/utils/stored-files-upload'
import { startHttpFixture, type HttpFixture } from '../../support/http'
import { minimalPdf } from '../../support/minimal-pdf'

const tempRoot = mkdtempSync(join(tmpdir(), 'spztx-display-name-api-'))
const filesRoot = join(tempRoot, 'files')
const sourceFile = 'jxj/announcement/2024/1/original-notice.pdf'
const sourceAbs = join(filesRoot, sourceFile)
const dirs = [tempRoot]
let db: ReturnType<typeof useDb>
let fileId: number
let pageImageAbs: string
let api: HttpFixture

async function getJson(path: string) {
  const response = await fetch(`${api.baseUrl}${path}`)
  return { status: response.status, body: await response.json() }
}

async function patchFile(body: unknown, id = fileId) {
  const response = await fetch(`${api.baseUrl}/api/files/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

async function previewBytes(): Promise<Buffer> {
  const response = await getJson(fileUrl(sourceFile))
  expect(response.status).toBe(200)
  return Buffer.from(response.body.contentBase64, 'base64')
}

beforeAll(async () => {
  mkdirSync(join(sourceAbs, '..'), { recursive: true })
  writeFileSync(sourceAbs, minimalPdf({ pages: 2 }))
  db = initializeDb({ create: true, dbPath: join(tempRoot, 'roster.db') })

  const registered = await registerStoredFile(db, filesRoot, {
    relPath: sourceFile,
    source: 'jxj',
    kind: 'announcement',
    year: '2024',
    batch: '1',
  })
  fileId = registered.row.id
  await renderPdfPages(filesRoot, sourceFile, { dpi: 72 })
  pageImageAbs = resolveInsideRoot(filesRoot, pageImageRelPath(sourceFile, 1))!

  const enterpriseId = db
    .insert(schema.enterprise)
    .values({ name: '改名验收企业', nameNorm: normalizeName('改名验收企业') })
    .returning({ id: schema.enterprise.id })
    .get().id
  const recordId = db
    .insert(schema.record)
    .values({ enterpriseId, titleCode: 'specialized_sme', source: 'jxj' })
    .returning({ id: schema.record.id })
    .get().id
  const eventId = db
    .insert(schema.recordEvent)
    .values({ recordId, eventType: 'award', year: 2024, batchSeq: 1 })
    .returning({ id: schema.recordEvent.id })
    .get().id
  db.insert(schema.recordEvidence)
    .values({ recordEventId: eventId, sourceFile, attachment: '附件1', listNo: 1, page: 2 })
    .run()
  db.insert(schema.ocrResult)
    .values({
      fileId,
      pageNo: 1,
      pageRelPath: pageImageRelPath(sourceFile, 1),
      markdown: 'fixture OCR stays attached to the same page',
      channel: 'upload',
    })
    .run()
  db.insert(schema.storedFilePart)
    .values({ fileId, titleCode: 'specialized_sme', eventKind: 'award', year: 2024, batch: 1, attachment: '附件1', rowCount: 1, origin: 'agent' })
    .run()

  api = await startHttpFixture({
    routes: Object.fromEntries([fileId, fileId + 1].map((id) => [`/api/files/${id}`, (request) => {
      const result = handleStoredFilePatchRequest(request.method, id, request.body, db)
      return { status: result.status, body: result.body }
    }])),
    getRoutes: {
      '/api/files': (request) => ({
        status: 200,
        body: listStoredFiles(db, {
          pageSize: 200,
          q: typeof request.query.q === 'string' ? request.query.q : undefined,
        }),
      }),
      [fileUrl(sourceFile)]: () => {
        const abs = resolveInsideRoot(filesRoot, sourceFile)
        if (!abs || !existsSync(abs)) return { status: 404, body: { message: '文件不存在' } }
        return { status: 200, body: { contentBase64: readFileSync(abs).toString('base64') } }
      },
    },
  })
})

afterAll(async () => {
  await api?.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('PATCH /api/files/:id 用户显示名称', () => {
  it('真实 HTTP 改名只改显示字段并追加审计,文件、页图、OCR、出处与预览字节保持不变', async () => {
    const beforeFile = db.select().from(schema.storedFile).where(eq(schema.storedFile.id, fileId)).get()!
    const beforeOcr = db.select().from(schema.ocrResult).where(eq(schema.ocrResult.fileId, fileId)).all()
    const beforeParts = db.select().from(schema.storedFilePart).where(eq(schema.storedFilePart.fileId, fileId)).all()
    const beforeEvidence = db.select().from(schema.recordEvidence).all()
    const beforePage = readFileSync(pageImageAbs)
    const beforePreview = await previewBytes()
    const diskFilename = sourceFile.split('/').at(-1)!

    const firstRename = await patchFile({ displayName: '用户显示名.pdf' })
    expect(firstRename.status).toBe(200)
    expect(firstRename.body).toMatchObject({
      id: fileId,
      displayName: '用户显示名.pdf',
      filename: diskFilename,
      relPath: sourceFile,
      bytes: beforeFile.bytes,
      sha256: beforeFile.sha256,
    })

    const afterFile = db.select().from(schema.storedFile).where(eq(schema.storedFile.id, fileId)).get()!
    expect(afterFile).toMatchObject({
      id: beforeFile.id,
      relPath: beforeFile.relPath,
      filename: beforeFile.filename,
      ext: beforeFile.ext,
      bytes: beforeFile.bytes,
      sha256: beforeFile.sha256,
      displayName: '用户显示名.pdf',
    })
    expect(db.select().from(schema.ocrResult).where(eq(schema.ocrResult.fileId, fileId)).all()).toEqual(beforeOcr)
    expect(db.select().from(schema.storedFilePart).where(eq(schema.storedFilePart.fileId, fileId)).all()).toEqual(beforeParts)
    expect(db.select().from(schema.recordEvidence).all()).toEqual(beforeEvidence)
    expect(readFileSync(pageImageAbs).equals(beforePage)).toBe(true)
    expect(readFileSync(sourceAbs).equals(beforePreview)).toBe(true)
    expect(await previewBytes()).toEqual(beforePreview)
    expect(existsSync(sourceAbs)).toBe(true)

    const fileList = await getJson('/api/files')
    expect(fileList.body.rows.find((row: { id: number }) => row.id === fileId)).toMatchObject({
      displayName: '用户显示名.pdf',
      filename: diskFilename,
      relPath: sourceFile,
    })
    const byDisplayName = await getJson('/api/files?q=用户显示名')
    expect(byDisplayName.body.rows.map((row: { id: number }) => row.id)).toEqual([fileId])

    const firstAudit = db.select().from(schema.storedFileAudit).where(eq(schema.storedFileAudit.storedFileId, fileId)).all()
    expect(firstAudit).toHaveLength(1)
    expect(firstAudit[0]).toMatchObject({ oldDisplayName: diskFilename, newDisplayName: '用户显示名.pdf' })

    await patchFile({ displayName: '用户显示名.pdf' })
    expect(db.select().from(schema.storedFileAudit).where(eq(schema.storedFileAudit.storedFileId, fileId)).all()).toHaveLength(1)

    const secondRename = await patchFile({ displayName: '更正后的显示名.pdf' })
    expect(secondRename.status).toBe(200)
    const audit = db.select().from(schema.storedFileAudit).where(eq(schema.storedFileAudit.storedFileId, fileId)).all()
    expect(audit).toHaveLength(2)
    expect(audit.map(({ oldDisplayName, newDisplayName }) => [oldDisplayName, newDisplayName])).toEqual([
      [diskFilename, '用户显示名.pdf'],
      ['用户显示名.pdf', '更正后的显示名.pdf'],
    ])
    expect(() => db.update(schema.storedFileAudit).set({ newDisplayName: '篡改' }).run()).toThrow(/append-only/)
    expect(() => db.delete(schema.storedFileAudit).run()).toThrow(/append-only/)
    expect(db.select().from(schema.storedFile).where(eq(schema.storedFile.id, fileId)).get()?.relPath).toBe(sourceFile)
  })

  it('拒绝空名、混合元数据改名和未知文件 id,且不追加审计', async () => {
    const before = db.select().from(schema.storedFileAudit).where(eq(schema.storedFileAudit.storedFileId, fileId)).all()
    expect((await patchFile({ displayName: '   ' })).status).toBe(400)
    expect((await patchFile({ displayName: 42 })).status).toBe(400)
    expect((await patchFile({ displayName: 'bad\tname.pdf' })).status).toBe(400)
    expect((await patchFile({ displayName: `${'名'.repeat(256)}.pdf` })).status).toBe(400)
    expect((await patchFile({ displayName: 'new.pdf', source: 'jxj' })).status).toBe(400)
    expect((await patchFile({ displayName: 'unknown.pdf' }, fileId + 1)).status).toBe(404)
    expect(db.select().from(schema.storedFileAudit).where(eq(schema.storedFileAudit.storedFileId, fileId)).all()).toEqual(before)
  })
})

describe('文件管理 rename OpenAPI contract', () => {
  it('PATCH 路由文档说明 displayName 只改显示名并写审计,不改磁盘路径', async () => {
    const { readFile } = await import('node:fs/promises')
    const route = await readFile(join(process.cwd(), 'server/api/files/[id].patch.ts'), 'utf8')
    expect(route).toContain('displayName')
    expect(route).toContain('审计')
    expect(route).toContain('stored_file.id')
    expect(route).toContain('relPath')
  })
})
