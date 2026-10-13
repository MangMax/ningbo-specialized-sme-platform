import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTus, landingSegments, MAX_SIZE, TUS_PATH } from '../server/utils/tus'

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
})
