import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTus, landingSegments, MAX_SIZE, TUS_PATH, withTusObservation, type TusObservation } from '../../../server/utils/tus'

/**
 * tus 端点的**协议端到端**测试。
 *
 * 直接装配 `createTus()`(读注入的临时目录),用 Node 内建 `fetch` 走 tus 协议,
 * 全部请求经 `server.handleWeb(new Request(...))` —— 与生产里
 * `server/middleware/tus.ts` 调 `handleWeb(toWebRequest(event))` **走同一入口**,
 * 只是省去 h3 的 request/response 包装(测试环境无顶层 h3;Nitro 才提供它)。
 *
 * 覆盖:创建(带 metadata)→ 分片 → HEAD 查 offset → 中断/续传 → 落位,
 * 断言落位路径正确且与源**逐字节一致**;再断言非法 metadata 400、同名落 ` (n)`。
 */

const BASE = 'http://localhost'

/** 把声明的 metadata 编成 tus 的 `Upload-Metadata` 头值(base64 值)。 */
function encodeMetadata(meta: Record<string, string>): string {
  return Object.entries(meta)
    .map(([k, v]) => `${k} ${Buffer.from(v, 'utf8').toString('base64')}`)
    .join(',')
}

function tusHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'Tus-Resumable': '1.0.0', ...extra }
}

/** 走 tus 的 web 标准入口,和中间件里的调用是同一入口。 */
function request(
  tus: ReturnType<typeof createTus>,
  opts: RequestInit & { path: string; duplex?: 'half' },
) {
  return tus.handleWeb(new Request(`${BASE}${opts.path}`, opts))
}

/** 非流式请求(创建 / HEAD / DELETE)。 */
function call(
  tus: ReturnType<typeof createTus>,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: BodyInit,
) {
  return request(tus, { method, path, headers: tusHeaders(headers), body })
}

/** 创建上传,返回处理 URL 的后缀 id 与 `Location`。 */
async function createUpload(
  tus: ReturnType<typeof createTus>,
  meta: Record<string, string>,
  length: number,
) {
  const res = await call(tus, 'POST', TUS_PATH, {
    'Upload-Length': String(length),
    'Upload-Metadata': encodeMetadata(meta),
  })
  const location = res.headers.get('location') ?? ''
  const id = location.split('/').filter(Boolean).pop() ?? ''
  return { res, id, location }
}

/** HEAD 查当前 offset。 */
async function headOffset(tus: ReturnType<typeof createTus>, id: string): Promise<number> {
  const res = await call(tus, 'HEAD', `${TUS_PATH}/${id}`)
  expect(res.status).toBe(200)
  return Number(res.headers.get('upload-offset'))
}

/** PATCH 一段字节(从 offset 起),返回响应。 */
function patch(
  tus: ReturnType<typeof createTus>,
  id: string,
  offset: number,
  bytes: Uint8Array,
): Promise<Response> {
  return call(
    tus,
    'PATCH',
    `${TUS_PATH}/${id}`,
    { 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
    bytes as unknown as BodyInit,
  )
}

describe('tus 上传端点 + 落位规则', () => {
  let work: string
  let tus: ReturnType<typeof createTus>
  let filesDir: string
  let incomingDir: string

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'tus-e2e-'))
    filesDir = join(work, 'files')
    incomingDir = join(work, '.incoming')
    await mkdir(filesDir, { recursive: true })
    tus = createTus({ filesDir, incomingDir, allowedOrigins: ['http://localhost'] })
  })

  afterAll(async () => {
    await rm(work, { recursive: true, force: true })
  })

  // ── 落位规则(纯函数)────────────────────────────────────────────
  describe('landingSegments(纯函数)', () => {
    it('拼出完整段序列 source/kind/year/batch/filename', () => {
      expect(
        landingSegments({
          source: 'jxj',
          kind: 'announcement',
          year: '2024',
          batch: '1',
          filename: '甬经信中小〔2024〕72号.pdf',
        }),
      ).toEqual(['jxj', 'announcement', '2024', '1', '甬经信中小〔2024〕72号.pdf'])
    })

    it('year/batch 缺省时省略对应段(导出表)', () => {
      expect(
        landingSegments({ source: 'miit', kind: 'export', filename: '导出Excel.xlsx' }),
      ).toEqual(['miit', 'export', '导出Excel.xlsx'])
    })

    it('只有 year、无 batch 时省略 batch 段', () => {
      expect(
        landingSegments({ source: 'jxj', kind: 'announcement', year: '2021', filename: 'a.pdf' }),
      ).toEqual(['jxj', 'announcement', '2021', 'a.pdf'])
    })

    it('拒绝白名单外的 source/kind', () => {
      expect(() =>
        landingSegments({ source: 'evil', kind: 'announcement', filename: 'a.pdf' }),
      ).toThrow()
      expect(() => landingSegments({ source: 'jxj', kind: 'evil', filename: 'a.pdf' })).toThrow()
    })

    it('拒绝非四位 year 与 batch 无 year', () => {
      expect(() =>
        landingSegments({ source: 'jxj', kind: 'announcement', year: '24', filename: 'a.pdf' }),
      ).toThrow()
      expect(() =>
        landingSegments({ source: 'jxj', kind: 'announcement', batch: '1', filename: 'a.pdf' }),
      ).toThrow()
    })

    it('拒绝含路径分隔符 / `..` / 空 的 filename', () => {
      for (const bad of ['../../etc/passwd', 'a/b.pdf', 'a\\b.pdf', '..', '', '   ']) {
        expect(() =>
          landingSegments({ source: 'jxj', kind: 'announcement', filename: bad }),
        ).toThrow()
      }
    })
  })

  // ── 协议端到端 ─────────────────────────────────────────────────
  it('创建 → 分片 → HEAD → 续传 → 落位,内容逐字节一致', async () => {
    const meta = { source: 'jxj', kind: 'announcement', year: '2024', batch: '1', filename: 'e2e-分片.bin' }
    const data = randomBytes(300 * 1024) // 300KiB
    const { res, id } = await createUpload(tus, meta, data.length)
    expect(res.status).toBe(201)
    expect(id).not.toBe('')

    // 第一片:前 100KiB。
    const first = await patch(tus, id, 0, data.subarray(0, 100 * 1024))
    expect(first.status).toBe(204)
    expect(first.headers.get('upload-offset')).toBe(String(100 * 1024))

    // 模拟「中断」:不传了,先 HEAD 问 offset。
    expect(await headOffset(tus, id)).toBe(100 * 1024)

    // 从 100KiB 续传剩余。
    const second = await patch(tus, id, 100 * 1024, data.subarray(100 * 1024))
    expect(second.status).toBe(204)
    expect(second.headers.get('upload-offset')).toBe(String(data.length))

    // 落位:files/<source>/<kind>/<year>/<batch>/<filename>
    const target = join(filesDir, 'jxj', 'announcement', '2024', '1', 'e2e-分片.bin')
    expect(existsSync(target)).toBe(true)
    const landed = await readFile(target)
    expect(Buffer.compare(landed, data)).toBe(0) // 逐字节一致
  })

  it('中途断连不回滚已落盘进度,可从 HEAD 报出的 offset 续传,最终逐字节一致', async () => {
    const meta = { source: 'miit', kind: 'export', filename: 'e2e-中断.bin' }
    const data = randomBytes(400 * 1024)
    const { id } = await createUpload(tus, meta, data.length)

    // 先正常提交第一段(150KiB),这是「已落盘」的确定进度。
    const committed = 150 * 1024
    const first = await patch(tus, id, 0, data.subarray(0, committed))
    expect(first.status).toBe(204)
    expect(await headOffset(tus, id)).toBe(committed)

    // 第二段:发到一半让流**报错**(模拟掉线)。tus 会中止该 PATCH:
    // 或抛错、或回一个非 2xx(Connection: close)—— 两者都表示这次上传没成功。
    let sent = committed
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= committed + 100 * 1024) {
          controller.error(new Error('simulated disconnect'))
          return
        }
        const chunk = data.subarray(sent, Math.min(sent + 64 * 1024, committed + 100 * 1024))
        sent += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    let disconnected = false
    try {
      const res = await request(tus, {
        method: 'PATCH',
        path: `${TUS_PATH}/${id}`,
        headers: tusHeaders({
          'Upload-Offset': String(committed),
          'Content-Type': 'application/offset+octet-stream',
        }),
        body: body as unknown as BodyInit,
        // Node fetch 需要声明半双工才能发流式请求体。
        duplex: 'half',
      })
      disconnected = !res.ok
    } catch {
      disconnected = true
    }
    expect(disconnected).toBe(true)

    // 关键保证:失败的那次 PATCH **不回滚**已提交的 150KiB;
    // HEAD 报出的 offset 落在 [已提交, 总长) 之间,可据此续传。
    const headRes = await call(tus, 'HEAD', `${TUS_PATH}/${id}`)
    expect(headRes.headers.get('upload-offset'), `HEAD status=${headRes.status}`).toBeDefined()
    const partial = Number(headRes.headers.get('upload-offset'))
    expect(partial).toBeGreaterThanOrEqual(committed)
    expect(partial).toBeLessThan(data.length)

    // 从断点续传剩余部分,最终落位且逐字节一致。
    const rest = await patch(tus, id, partial, data.subarray(partial))
    expect(rest.status).toBe(204)
    // 落位后上传即「消费」掉:工作目录里的临时文件与元数据已清,HEAD 变 404。
    expect((await call(tus, 'HEAD', `${TUS_PATH}/${id}`)).status).toBe(404)

    const target = join(filesDir, 'miit', 'export', 'e2e-中断.bin')
    expect(existsSync(target)).toBe(true)
    expect(Buffer.compare(await readFile(target), data)).toBe(0)
  })

  it('非法 metadata 在创建阶段返回 400', async () => {
    const body = randomBytes(1024)
    for (const meta of [
      { source: 'evil', kind: 'announcement', filename: 'a.bin' },
      { source: 'jxj', kind: 'evil', filename: 'a.bin' },
      { source: 'jxj', kind: 'announcement', year: '24', filename: 'a.bin' },
      { source: 'jxj', kind: 'announcement', filename: '../../etc/passwd' },
      { source: 'jxj', kind: 'announcement' }, // 缺 filename
    ]) {
      const res = await call(tus, 'POST', TUS_PATH, {
        'Upload-Length': String(body.length),
        'Upload-Metadata': encodeMetadata(meta as Record<string, string>),
      })
      expect(res.status, `metadata=${JSON.stringify(meta)}`).toBe(400)
    }
  })

  it('同名第二次上传落到 ` (1)`,原文件不动', async () => {
    const meta = { source: 'jxj', kind: 'announcement', year: '2025', batch: '1', filename: '同名.bin' }
    const dir = join(filesDir, 'jxj', 'announcement', '2025', '1')

    const a = randomBytes(2048)
    const first = await createUpload(tus, meta, a.length)
    await patch(tus, first.id, 0, a)

    const b = randomBytes(2048)
    const second = await createUpload(tus, meta, b.length)
    await patch(tus, second.id, 0, b)

    expect(Buffer.compare(await readFile(join(dir, '同名.bin')), a)).toBe(0)
    expect(Buffer.compare(await readFile(join(dir, '同名 (1).bin')), b)).toBe(0)
  })

  it('超过 maxSize 的创建返回 413', async () => {
    const res = await call(tus, 'POST', TUS_PATH, {
      'Upload-Length': String(MAX_SIZE + 1),
      'Upload-Metadata': encodeMetadata({ source: 'jxj', kind: 'announcement', filename: 'big.bin' }),
    })
    expect(res.status).toBe(413)
  })

  // 落位路径要能回报给上传组件(它据此告诉用户「东西放哪了」)。
  // 头值是百分号编码的:HTTP 头是 ByteString(≤255),中文文件名不能直接放进去。
  it('落位后回报 X-Upload-Path(百分号编码),同名的第二次带上 (1) 后缀', async () => {
    const meta = { source: 'miit', kind: 'export', filename: '落位回报.xlsx' }
    const data = randomBytes(600)

    const first = await createUpload(tus, meta, data.length)
    const firstPatch = await patch(tus, first.id, 0, data)
    expect(decodeURIComponent(firstPatch.headers.get('x-upload-path') ?? '')).toBe(
      'miit/export/落位回报.xlsx',
    )

    const second = await createUpload(tus, meta, data.length)
    const secondPatch = await patch(tus, second.id, 0, data)
    // 预览算不出这个后缀,只能由服务端回报。
    expect(decodeURIComponent(secondPatch.headers.get('x-upload-path') ?? '')).toBe(
      'miit/export/落位回报 (1).xlsx',
    )
  })
})


describe('tus request-local observation (real @tus/server callbacks)', () => {
  let work: string, tus: ReturnType<typeof createTus>, filesDir: string, incomingDir: string

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'tus-observe-'))
    filesDir = join(work, 'files')
    incomingDir = join(work, '.incoming')
    await mkdir(filesDir, { recursive: true })
    tus = createTus({ filesDir, incomingDir, allowedOrigins: ['http://localhost'] })
  })
  afterAll(async () => { await rm(work, { recursive: true, force: true }) })

  async function observed(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: BodyInit,
  ): Promise<{ response: Response; observation: TusObservation }> {
    const observation: TusObservation = {}
    const { result } = await withTusObservation(
      () => tus.handleWeb(new Request(`${BASE}${path}`, { method, headers: tusHeaders(headers), body })),
      observation,
    )
    return { response: result, observation }
  }

  const createObserved = (length: number, meta: Record<string, string>) =>
    observed('POST', TUS_PATH, {
      'Upload-Length': String(length),
      'Upload-Metadata': encodeMetadata(meta),
    })

  it('uses the real server-generated id and separates create, progress and completed', async () => {
    const data = randomBytes(300)
    const meta = { source: 'jxj', kind: 'announcement', year: '2026', batch: '7', filename: 'observe.bin' }
    const created = await createObserved(data.length, meta)
    const id = (created.response.headers.get('location') ?? '').split('/').pop()!
    expect(id).toMatch(/^[a-f0-9]{32}$/)
    expect(created.observation).toMatchObject({
      uploadId: id, method: 'POST', size: data.length, offset: 0, created: true,
    })
    expect(created.observation.completed).toBeUndefined()

    const first = await observed('PATCH', `${TUS_PATH}/${id}`, {
      'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream',
    }, data.subarray(0, 100) as unknown as BodyInit)
    expect(first.response.status).toBe(204)
    // POST_RECEIVE is throttled and a short final chunk completes before its first tick;
    // the library only guarantees the final offset on onUploadFinish.
    expect(first.observation).toMatchObject({ uploadId: id, method: 'PATCH' })
    expect(first.observation.offset).toBeUndefined()
    expect(first.observation.created).toBeUndefined()
    expect(first.observation.completed).toBeUndefined()

    const second = await observed('PATCH', `${TUS_PATH}/${id}`, {
      'Upload-Offset': '100', 'Content-Type': 'application/offset+octet-stream',
    }, data.subarray(100) as unknown as BodyInit)
    expect(second.response.status).toBe(204)
    expect(second.observation).toMatchObject({
      uploadId: id, method: 'PATCH', size: data.length, offset: data.length, completed: true,
    })
  })

  it('marks zero-length and creation-with-upload as created+completed in the same request', async () => {
    const zero = await createObserved(0, { source: 'miit', kind: 'export', filename: 'zero.bin' })
    expect(zero.response.status).toBe(201)
    expect(zero.observation).toMatchObject({ size: 0, offset: 0, created: true, completed: true, method: 'POST' })

    const data = randomBytes(128)
    const one = await observed('POST', TUS_PATH, {
      'Upload-Length': String(data.length),
      'Upload-Metadata': encodeMetadata({ source: 'miit', kind: 'export', filename: 'one-shot.bin' }),
      'Content-Type': 'application/offset+octet-stream',
    }, data as unknown as BodyInit)
    expect(one.response.status).toBe(201)
    expect(one.observation).toMatchObject({
      size: data.length, offset: data.length, created: true, completed: true, method: 'POST',
    })
  })

  it('observes a deferred-length upload only when the library later knows the size', async () => {
    const created = await observed('POST', TUS_PATH, {
      'Upload-Defer-Length': '1',
      'Upload-Metadata': encodeMetadata({ source: 'jxj', kind: 'announcement', filename: 'deferred.bin' }),
    })
    const id = (created.response.headers.get('location') ?? '').split('/').pop()!
    expect(created.response.status).toBe(201)
    expect(created.observation).toMatchObject({ uploadId: id, offset: 0, created: true })
    expect(created.observation.size).toBeUndefined()
    const data = randomBytes(64)
    const final = await observed('PATCH', `${TUS_PATH}/${id}`, {
      'Upload-Offset': '0', 'Upload-Length': String(data.length), 'Content-Type': 'application/offset+octet-stream',
    }, data as unknown as BodyInit)
    expect(final.response.status).toBe(204)
    expect(final.observation).toMatchObject({ uploadId: id, size: data.length, offset: data.length, completed: true })
  })

  it('marks a rejected create as failed with the real id but never as created', async () => {
    const rejected = await createObserved(32, { source: 'evil', kind: 'announcement', filename: 'bad.bin' })
    expect(rejected.response.status).toBe(400)
    expect(rejected.observation.failed).toBe(true)
    expect(rejected.observation.created).toBeUndefined()
    expect(rejected.observation.uploadId).toMatch(/^[a-f0-9]{32}$/)
    expect(rejected.observation.method).toBe('POST')
  })

  it('keeps concurrent observations isolated', async () => {
    const [a, b] = await Promise.all([
      createObserved(100, { source: 'jxj', kind: 'announcement', filename: 'a.bin' }),
      createObserved(200, { source: 'miit', kind: 'export', filename: 'b.bin' }),
    ])
    expect(a.observation.uploadId).toBeTruthy()
    expect(b.observation.uploadId).toBeTruthy()
    expect(a.observation.uploadId).not.toBe(b.observation.uploadId)
    expect(a.observation.size).toBe(100)
    expect(b.observation.size).toBe(200)
  })

  it('does not call a successful HEAD or DELETE a completed upload', async () => {
    const created = await createObserved(10, { source: 'jxj', kind: 'announcement', filename: 'head.bin' })
    const id = (created.response.headers.get('location') ?? '').split('/').pop()!
    const head = await observed('HEAD', `${TUS_PATH}/${id}`)
    expect(head.response.status).toBe(200)
    expect(head.observation).toMatchObject({ uploadId: id, method: 'HEAD' })
    expect(head.observation.created).toBeUndefined()
    expect(head.observation.completed).toBeUndefined()
    const deleted = await observed('DELETE', `${TUS_PATH}/${id}`)
    expect(deleted.response.status).toBe(204)
    expect(deleted.observation).toMatchObject({ uploadId: id, method: 'DELETE' })
    expect(deleted.observation.completed).toBeUndefined()
  })
})
