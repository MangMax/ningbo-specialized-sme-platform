import { resolveUploadPlacement } from '../../../server/utils/stored-files'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTus, TUS_PATH } from '../../../layers/core/server/utils/tus'
import {
  parseUploadDeclaration,
  registerStoredFile,
} from '../../../server/modules/sme-roster/file-upload'
import { UploadRegistrationError } from '../../../layers/core/server/utils/file-store'
import { listStoredFiles } from '../../../server/utils/stored-files'

/**
 * 票 10 —— 上传完成后的**登记**。
 *
 * 分三块:
 *  1. 请求体解析(只收声明,不收磁盘事实);
 *  2. `registerStoredFile` 的校验与写入(白名单 / 四位年份 / 正整数批次 / 路径锁根 /
 *     声明与实际落位必须一致 / 磁盘事实由服务端读);
 *  3. **协议端到端**:真走一遍 tus(创建 → 分片 → 落位),再拿响应头里的
 *     `X-Upload-Path` 登记,断言 `stored_file` 那一行与磁盘**对得上**。
 *
 * 第 3 块是「上传成功后库里有新行」这条验收的直接对应物:它用的是**生产同一套**
 * `createTus()` 与 `registerStoredFile()`,只把两个目录指向临时路径。
 */

const BASE = 'http://localhost'

let dir: string
let filesDir: string
let incomingDir: string
let useDb: (typeof import('../../../db'))['useDb']
let schema: typeof import('../../../db')['schema']

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-upload-reg-'))
  filesDir = join(dir, 'files')
  incomingDir = join(dir, '.incoming')
  await mkdir(filesDir, { recursive: true })
  // tus 的工作目录在生产里由 runtimeConfig 指过来且已存在;这里也先建好,
  // 免得 FileStore 初始化与测试目录生命周期抢跑。
  await mkdir(incomingDir, { recursive: true })
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  ;({ useDb } = await import('../../../db'))
  const { initializeDb } = await import('../../../db/client')
  initializeDb({ create: true })
  schema = (await import('../../../db')).schema
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** 在文件库里放一个真的文件,返回它的库内相对路径。 */
async function putFile(relPath: string, content: string): Promise<string> {
  const abs = join(filesDir, relPath)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, content)
  return relPath
}

function rows() {
  return useDb().select().from(schema.storedFile).all()
}

it.each([
  ['入库培育.pdf', null, 'nurture', '文件名含「入库培育」—— 培育对象不构成称号,按 lib/file-store-scope.ts 排除'],
  ['名单.doc', '名单.docx', 'duplicate-doc', '同目录已有同名 .docx(可预览的转出件)—— 重复的旧版 .doc 不入库'],
  ['识别.docx', '识别.pdf', 'human-ocr-docx', '同目录已有同名 .pdf —— 该 .docx 是人工 OCR 产物,PDF 才是权威原件'],
])('rejects %s at upload registration using the file admission policy', async (name, sibling, reason, detail) => {
  const directory = 'jxj/announcement/2026/1'
  const relPath = await putFile(`${directory}/${name}`, 'synthetic file')
  if (sibling) await putFile(`${directory}/${sibling}`, 'synthetic sibling')
  const input = parseUploadDeclaration({ relPath, source: 'jxj', kind: 'announcement', year: 2026, batch: 1 })

  await expect(registerStoredFile(useDb(), filesDir, input)).rejects.toMatchObject({ statusCode: 400, reason, message: detail })
  expect(rows().some(file => file.relPath === relPath)).toBe(false)
})

it('rolls back the file row when classification cannot be created', async () => {
  const relPath = await putFile('jxj/announcement/2025/atomic.pdf', 'synthetic source')
  const db = useDb()
  const input = parseUploadDeclaration({ relPath, source: 'jxj', kind: 'announcement', year: 2025 })
  db.$client.exec(`CREATE TEMP TRIGGER reject_classification
    BEFORE INSERT ON roster_file_classification
    BEGIN SELECT RAISE(ABORT, 'synthetic classification failure'); END`)
  try {
    await expect(registerStoredFile(db, filesDir, input)).rejects.toThrow('synthetic classification failure')
    expect(rows().some(file => file.relPath === relPath)).toBe(false)
  } finally {
    db.$client.exec('DROP TRIGGER reject_classification')
  }
  await expect(registerStoredFile(db, filesDir, input)).resolves.toMatchObject({
    created: true, row: { relPath, source: 'jxj', year: 2025, categoryState: 'set', parseState: 'unparsed' },
  })
})

// ---------------------------------------------------------------------------
// 1. 请求体解析
// ---------------------------------------------------------------------------

describe('parseUploadDeclaration', () => {
  it('只留下声明的五个键,空串当「没填」', () => {
    expect(
      parseUploadDeclaration({
        relPath: 'jxj/announcement/2024/1/a.pdf',
        source: 'jxj',
        kind: 'announcement',
        year: '2024',
        batch: ' 1 ',
      }),
    ).toEqual({
      relPath: 'jxj/announcement/2024/1/a.pdf',
      source: 'jxj',
      kind: 'announcement',
      year: '2024',
      batch: '1',
    })

    expect(
      parseUploadDeclaration({
        relPath: 'jxj/announcement/a.pdf',
        source: '',
        kind: '',
        year: '',
        batch: '',
      }),
    ).toMatchObject({ source: null, kind: null, year: null, batch: null })
  })

  it('缺少 relPath / 不是对象 → 400', () => {
    for (const bad of [null, [], 'x', {}, { relPath: '' }, { relPath: '   ' }]) {
      expect(() => parseUploadDeclaration(bad)).toThrow(UploadRegistrationError)
      expect(() => parseUploadDeclaration(bad)).toThrow()
    }
  })

  it('**不接受**磁盘事实键(大小 / 哈希 / 文件名由服务端从盘上读)', () => {
    for (const key of ['bytes', 'sha256', 'filename', 'ext', 'rel_path']) {
      expect(() => parseUploadDeclaration({ relPath: 'a/b.pdf', [key]: 'x' })).toThrow(
        `不可提交的字段:${key}`,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// 2. registerStoredFile 的校验与写入
// ---------------------------------------------------------------------------

describe('registerStoredFile', () => {
  it('填了元数据 → 行与所填一致,磁盘事实由服务端算', async () => {
    const rel = await putFile('jxj/announcement/2024/1/甲.pdf', 'hello')
    const before = rows().length

    const { row, created } = await registerStoredFile(useDb(), filesDir, {
      relPath: rel,
      source: 'jxj',
      kind: 'announcement',
      year: '2024',
      batch: '1',
    })

    expect(created).toBe(true)
    expect(rows()).toHaveLength(before + 1)
    expect(row).toMatchObject({
      relPath: rel,
      filename: '甲.pdf',
      ext: 'pdf',
      bytes: 5,
      sha256: createHash('sha256').update('hello').digest('hex'),
      source: 'jxj',
      kind: 'announcement',
      year: 2024,
      batch: 1,
      categoryState: 'set',
    })
  })

  it('未填元数据 → 行存在,分类为空且 `unset`(交票 12 回写)', async () => {
    const rel = await putFile('jxj/announcement/未定.pdf', 'x')

    const { row } = await registerStoredFile(useDb(), filesDir, {
      relPath: rel,
      source: null,
      kind: null,
      year: null,
      batch: null,
    })

    expect(row).toMatchObject({
      relPath: rel,
      source: null,
      kind: null,
      year: null,
      batch: null,
      categoryState: 'unset',
    })
  })

  it('公布文件填了来源类别但没年份 → `unset`(不硬填年份)', async () => {
    // 路径也要与声明一致:没有 year/batch 段,就是 `jxj/announcement/乙.pdf`。
    const rel = await putFile('jxj/announcement/乙.pdf', 'x')

    const { row } = await registerStoredFile(useDb(), filesDir, {
      relPath: rel,
      source: 'jxj',
      kind: 'announcement',
      year: null,
      batch: null,
    })

    expect(row).toMatchObject({ year: null, categoryState: 'unset' })
  })

  it('导出表无年份批次也算已分类(与票 09 同一套规则)', async () => {
    const rel = await putFile('miit/export/导出.xlsx', 'x')
    const { row } = await registerStoredFile(useDb(), filesDir, {
      relPath: rel,
      source: 'miit',
      kind: 'export',
      year: null,
      batch: null,
    })
    expect(row).toMatchObject({ source: 'miit', kind: 'export', categoryState: 'set' })
  })

  it('来源不在白名单 / 年份非四位 / 批次非正整数 → 400,**不落库**', async () => {
    const rel = await putFile('jxj/announcement/bad.pdf', 'x')
    const before = rows().length

    const bad: Parameters<typeof registerStoredFile>[2][] = [
      { relPath: rel, source: 'evil', kind: 'announcement', year: null, batch: null },
      { relPath: rel, source: 'jxj', kind: 'evil', year: null, batch: null },
      { relPath: rel, source: 'jxj', kind: 'announcement', year: '24', batch: null },
      { relPath: rel, source: 'jxj', kind: 'announcement', year: '2024', batch: '0' },
      { relPath: rel, source: 'jxj', kind: 'announcement', year: '2024', batch: '-1' },
      { relPath: rel, source: 'jxj', kind: 'announcement', year: null, batch: '1' },
    ]
    for (const input of bad) {
      await expect(registerStoredFile(useDb(), filesDir, input)).rejects.toBeInstanceOf(
        UploadRegistrationError,
      )
    }
    expect(rows()).toHaveLength(before)
  })

  it('只给来源不给类别(或反之)→ 400', async () => {
    const rel = await putFile('jxj/announcement/half.pdf', 'x')
    await expect(
      registerStoredFile(useDb(), filesDir, {
        relPath: rel,
        source: 'jxj',
        kind: null,
        year: null,
        batch: null,
      }),
    ).rejects.toThrow('来源与类别要么都给,要么都不给')
    await expect(
      registerStoredFile(useDb(), filesDir, {
        relPath: rel,
        source: null,
        kind: null,
        year: '2024',
        batch: null,
      }),
    ).rejects.toThrow('未定来源与类别时不能单独给年份或批次')
  })

  it('声明与实际落位不一致 → 400(路径是服务端算的,不接受改了声明)', async () => {
    // 文件落在 2024/1,却声称是 2025/2。
    const rel = await putFile('jxj/announcement/2024/1/丙.pdf', 'x')
    await expect(
      registerStoredFile(useDb(), filesDir, {
        relPath: rel,
        source: 'jxj',
        kind: 'announcement',
        year: '2025',
        batch: '2',
      }),
    ).rejects.toThrow('声明与实际落位不符')
  })

  it('路径越界 / 文件不存在 → 400', async () => {
    await expect(
      registerStoredFile(useDb(), filesDir, {
        relPath: 'jxj/../../etc/passwd',
        source: null,
        kind: null,
        year: null,
        batch: null,
      }),
    ).rejects.toBeInstanceOf(UploadRegistrationError)

    await expect(
      registerStoredFile(useDb(), filesDir, {
        relPath: 'jxj/announcement/2024/1/不存在.pdf',
        source: 'jxj',
        kind: 'announcement',
        year: '2024',
        batch: '1',
      }),
    ).rejects.toThrow('落位文件不存在')
  })

  it('重复登记同内容**幂等**:保留身份,不产生第二行', async () => {
    const rel = await putFile('jxj/announcement/2024/2/丁.pdf', 'one')
    await registerStoredFile(useDb(), filesDir, {
      relPath: rel,
      source: 'jxj',
      kind: 'announcement',
      year: '2024',
      batch: '2',
    })
    const afterFirst = rows().length

    const { row, created } = await registerStoredFile(useDb(), filesDir, {
      relPath: rel,
      source: 'jxj',
      kind: 'announcement',
      year: '2024',
      batch: '2',
    })

    expect(created).toBe(false)
    expect(rows()).toHaveLength(afterFirst)
    expect(row.bytes).toBe(3)
    expect(row.sha256).toBe(createHash('sha256').update('one').digest('hex'))
  })

  it('重新登记已移出库的文件 → 清掉 `removed_at`,回到列表', async () => {
    const rel = await putFile('jxj/announcement/2023/1/戊.pdf', 'x')
    const { row } = await registerStoredFile(useDb(), filesDir, {
      relPath: rel,
      source: 'jxj',
      kind: 'announcement',
      year: '2023',
      batch: '1',
    })
    useDb()
      .update(schema.storedFile)
      .set({ removedAt: new Date().toISOString() })
      .where(eq(schema.storedFile.id, row.id))
      .run()

    const again = await registerStoredFile(useDb(), filesDir, {
      relPath: rel,
      source: 'jxj',
      kind: 'announcement',
      year: '2023',
      batch: '1',
    })
    expect(again.row.id).toBe(row.id)
    expect(again.row.removedAt).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. 协议端到端:真走 tus,再登记
// ---------------------------------------------------------------------------

describe('tus 上传 → 登记(端到端)', () => {
  // 复用同一个 `Server`:它每次创建都会初始化 datastore,别在测试目录的生命周期里反复重建。
  let tus: ReturnType<typeof createTus>

  beforeAll(() => {
    tus = createTus({ filesDir, incomingDir, landing: resolveUploadPlacement, allowedOrigins: [BASE] })
  })

  /** 把声明的 metadata 编成 tus 的 `Upload-Metadata` 头值(base64 值)。 */
  function encodeMetadata(meta: Record<string, string>): string {
    return Object.entries(meta)
      .map(([k, v]) => `${k} ${Buffer.from(v, 'utf8').toString('base64')}`)
      .join(',')
  }

  /** 通过 tus 协议传完一个文件,返回响应头里的 `X-Upload-Path`(解码后)。 */
  async function upload(
    tus: ReturnType<typeof createTus>,
    meta: Record<string, string>,
    bytes: Uint8Array,
  ): Promise<{ path: string; status: number }> {
    const headers = { 'Tus-Resumable': '1.0.0' }
    const created = await tus.handleWeb(
      new Request(`${BASE}${TUS_PATH}`, {
        method: 'POST',
        headers: { ...headers, 'Upload-Length': String(bytes.length), 'Upload-Metadata': encodeMetadata(meta) },
      }),
    )
    const id = (created.headers.get('location') ?? '').split('/').filter(Boolean).pop() ?? ''

    const patched = await tus.handleWeb(
      new Request(`${BASE}${TUS_PATH}/${id}`, {
        method: 'PATCH',
        headers: {
          ...headers,
          'Upload-Offset': '0',
          'Content-Type': 'application/offset+octet-stream',
        },
        body: bytes as unknown as BodyInit,
      }),
    )
    const raw = patched.headers.get('x-upload-path')
    return { path: raw ? decodeURIComponent(raw) : '', status: patched.status }
  }

  it('传完登记 → `stored_file` 出现一行,`rel_path` 与磁盘一致', async () => {
    const payload = Buffer.from('PDF-ish bytes 专精特新')
    const meta = {
      source: 'jxj',
      kind: 'announcement',
      year: '2026',
      batch: '1',
      filename: '甬经信中小〔2026〕99号端到端.pdf',
    }

    const { path, status } = await upload(tus, meta, payload)
    expect(status).toBe(204)
    // 落位路径由服务端算出并经响应头回报。
    expect(path).toBe(`jxj/announcement/2026/1/${meta.filename}`)
    // 磁盘上真的有这个文件。
    expect(existsSync(join(filesDir, path))).toBe(true)
    expect(Buffer.compare(await readFile(join(filesDir, path)), payload)).toBe(0)

    const { row, created } = await registerStoredFile(useDb(), filesDir, {
      ...parseUploadDeclaration({
        relPath: path,
        source: meta.source,
        kind: meta.kind,
        year: meta.year,
        batch: meta.batch,
      }),
    })

    expect(created).toBe(true)
    expect(row).toMatchObject({
      relPath: path,
      filename: meta.filename,
      bytes: payload.length,
      source: 'jxj',
      kind: 'announcement',
      year: 2026,
      batch: 1,
      categoryState: 'set',
    })
    // 行里的 rel_path 就是磁盘上的那条路径。
    expect(existsSync(join(filesDir, row.relPath))).toBe(true)
  })

  it('同名再传落 ` (n)`,登记的也是**实际**那一条路径', async () => {
    const meta = {
      source: 'miit',
      kind: 'export',
      filename: '导出-同名.xlsx',
    }
    const { path: first } = await upload(tus, meta, Buffer.from('a'))
    const { path: second } = await upload(tus, meta, Buffer.from('b'))

    expect(first).toBe('miit/export/导出-同名.xlsx')
    expect(second).toBe('miit/export/导出-同名 (1).xlsx')

    const { row } = await registerStoredFile(useDb(), filesDir, {
      ...parseUploadDeclaration({ relPath: second, source: 'miit', kind: 'export' }),
    })
    expect(row.relPath).toBe(second)
    expect(row.bytes).toBe(1)
  })

  it('元数据非法时 tus 那一步就 400,**根目录下不留任何落位文件**', async () => {
    const headers = { 'Tus-Resumable': '1.0.0' }
    const res = await tus.handleWeb(
      new Request(`${BASE}${TUS_PATH}`, {
        method: 'POST',
        headers: {
          ...headers,
          'Upload-Length': '3',
          'Upload-Metadata': encodeMetadata({
            source: 'evil',
            kind: 'announcement',
            filename: 'x.pdf',
          }),
        },
      }),
    )
    expect(res.status).toBe(400)
    expect(existsSync(join(filesDir, 'evil'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. 列表里能看到(端到端)—— ticket 10 验收的最后一条
// ---------------------------------------------------------------------------

describe('登记完能在 `/api/files` 的列表里查到', () => {
  it('`listStoredFiles` 按票 09 的筛选/分页口径查得到这一行', async () => {
    // 用**生产同一套**查询层(票 09 的 `listStoredFiles`),而不是直接读表:
    // 直接读表会漏掉 `removed_at IS NULL`、排序、分页、字段投影这些口径 ——
    // 那些正是「列表看不看得见」真正依赖的东西。
    const rel = await putFile('jxj/announcement/2020/3/列表可见.pdf', 'list')
    const { row } = await registerStoredFile(useDb(), filesDir, {
      relPath: rel,
      source: 'jxj',
      kind: 'announcement',
      year: '2020',
      batch: '3',
    })

    const listed = listStoredFiles(useDb(), { q: '列表可见' })
    expect(listed.total).toBe(1)
    expect(listed.rows.map((r) => r.id)).toContain(row.id)
    expect(listed.rows[0]).toMatchObject({
      relPath: rel,
      source: 'jxj',
      kind: 'announcement',
      year: 2020,
      batch: 3,
      categoryState: 'set',
      parseState: 'unparsed',
    })
  })

  it('未填元数据的行也在列表里,分类状态为「待分类」', async () => {
    const rel = await putFile('jxj/announcement/2020/3/列表待分类.pdf', 'x')
    await registerStoredFile(useDb(), filesDir, {
      relPath: rel,
      source: null,
      kind: null,
      year: null,
      batch: null,
    })

    const listed = listStoredFiles(useDb(), { q: '列表待分类' })
    expect(listed.rows[0]).toMatchObject({ categoryState: 'unset', source: null })
    // 分类状态筛选能按 `unset` 命中它(票 12 的「待分类 N 件」入口依赖这条)。
    expect(listStoredFiles(useDb(), { q: '列表待分类', categoryState: ['unset'] }).total).toBe(1)
  })
})
