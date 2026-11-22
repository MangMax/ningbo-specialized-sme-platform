import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNitro } from 'nitropack'
import {
  JOB_ID_RE,
  JOB_STATES,
  isJobId,
  isTerminalJobState,
  makeProgress,
  newJobId,
  normalizeJobParams,
  progressPercent,
  type JobState,
} from '../../../layers/core/lib/job'
import {
  readApiToken,
  resolveApiAuth,
  specLeaksToken,
  unauthorizedApiMessage,
} from '../../../layers/core/server/utils/api-auth'
import { clearJobSpecs, getJobSpec, jobSpecs, registerJob } from '../../../layers/core/server/utils/job-spec-registry'
import type { JobSpec } from '../../../layers/core/server/utils/job-contract'
import type { PostgresJobContext } from '../../../layers/core/server/utils/job-runner-postgres'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { parseCsvQuery } from '../../../layers/core/lib/csv'
import { parseRenderPagesParams, renderPagesSpec } from '../../../layers/core/server/utils/jobs/render-pages'
import { shouldHideOpenApiPath } from '../../../layers/core/server/utils/openapi-guard'
import { registerJobSpecs } from '../../../server/utils/job-specs'
import { minimalPdf } from '../../support/minimal-pdf'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

describe('lib/job 纯规则', () => {
  it('状态只有五个,终态是 done / failed / cancelled', () => {
    expect([...JOB_STATES]).toEqual(['queued', 'running', 'done', 'failed', 'cancelled'])
    expect(isTerminalJobState('queued')).toBe(false)
    expect(isTerminalJobState('running')).toBe(false)
    for (const s of ['done', 'failed', 'cancelled'] as JobState[]) {
      expect(isTerminalJobState(s)).toBe(true)
    }
  })

  it('进度是 {done,total} 而不是百分数 —— 百分数由 progressPercent 现算', () => {
    expect(makeProgress(0, 3)).toEqual({ done: 0, total: 3 })
    // total 缺失 / 非法按 1 算(通用任务是 0% → 100% 两档)。
    expect(makeProgress(0, 0)).toEqual({ done: 0, total: 1 })
    expect(makeProgress(0, Number.NaN)).toEqual({ done: 0, total: 1 })
    // done 被夹在 total 之内(进度不会超过分母)。
    expect(makeProgress(9, 3)).toEqual({ done: 3, total: 3 })
    expect(makeProgress(-1, 3)).toEqual({ done: 0, total: 3 })
  })

  it('百分比**向下**取整 —— 只有真做完才是 100', () => {
    expect(progressPercent({ done: 0, total: 3 })).toBe(0)
    expect(progressPercent({ done: 1, total: 3 })).toBe(33)
    expect(progressPercent({ done: 2, total: 3 })).toBe(66)
    expect(progressPercent({ done: 3, total: 3 })).toBe(100)
    // 这两条正是不能用 round 的原因:99.5% 与 99.75% 都会被 round 成 100。
    expect(progressPercent({ done: 199, total: 200 })).toBe(99)
    expect(progressPercent({ done: 399, total: 400 })).toBe(99)
    // 空批量不做除法。
    expect(progressPercent({ done: 0, total: 0 })).toBe(0)
  })

  it('任务 id 是 26 位 Crockford base32,且**字典序 == 时间序**', () => {
    const id = newJobId()
    expect(id).toHaveLength(26)
    expect(JOB_ID_RE.test(id)).toBe(true)
    // Crockford 去掉了 I / L / O / U —— 它们不出现,免得与 1 / 0 混。
    expect(/[ILOU]/.test(id)).toBe(false)

    // 时间前缀让 id 可排序:同一毫秒的随机部分不影响「后生成的更大」。
    const t = 1_800_000_000_000
    const early = newJobId(t)
    const late = newJobId(t + 1)
    expect(early < late).toBe(true)
    expect(early.slice(0, 10)).toBe(newJobId(t).slice(0, 10))
  })

  it('id 形状校验只判形状(查无此任务是另一回事)', () => {
    expect(isJobId(newJobId())).toBe(true)
    expect(isJobId('01M4X446940XV2D8N0KBDQ2YCN')).toBe(true)
    for (const bad of ['', 'abc', '01M4X446940XV2D8N0KBDQ2YC', '01M4X446940XV2D8N0KBDQ2YCN!', 42, null, undefined]) {
      expect(isJobId(bad)).toBe(false)
    }
  })

  it('params 归一:缺省 = 空对象;数组与标量一律拒', () => {
    expect(normalizeJobParams(undefined)).toEqual({ ok: true, params: {} })
    expect(normalizeJobParams(null)).toEqual({ ok: true, params: {} })
    expect(normalizeJobParams({ a: 1 })).toEqual({ ok: true, params: { a: 1 } })
    expect(normalizeJobParams([1, 2]).ok).toBe(false)
    expect(normalizeJobParams('x').ok).toBe(false)
    expect(normalizeJobParams(3).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. render-pages 的参数校验(提交时就跑,错了得到同步 400)
// ---------------------------------------------------------------------------

describe('render-pages 参数校验', () => {
  const ok = (raw: Record<string, unknown>) => {
    const r = parseRenderPagesParams(raw)
    if (!r.ok) throw new Error(`本应通过:${r.message}`)
    return r.params
  }
  const fail = (raw: Record<string, unknown>) => {
    const r = parseRenderPagesParams(raw)
    if (r.ok) throw new Error('本应失败')
    return r.message
  }

  it('files 必须是非空数组,每项是非空字符串的 PDF 路径', () => {
    expect(fail({})).toContain('非空数组')
    expect(fail({ files: [] })).toContain('非空数组')
    expect(fail({ files: 'a.pdf' })).toContain('非空数组')
    expect(fail({ files: [1] })).toContain('非空字符串')
    expect(fail({ files: ['   '] })).toContain('非空字符串')
    expect(fail({ files: ['jxj/announcement/2024/1/a.xlsx'] })).toContain('不是 PDF')
    // 路径两端的空白被修掉(代理拼字符串时常带)。
    expect(ok({ files: ['  a.pdf '] }).files).toEqual(['a.pdf'])
  })

  it('dpi 走票 13 的同一套校验(越界抛错,不静默纠正)', () => {
    expect(ok({ files: ['a.pdf'] }).dpi).toBe(300)
    expect(ok({ files: ['a.pdf'], dpi: 400 }).dpi).toBe(400)
    expect(fail({ files: ['a.pdf'], dpi: 10 })).toContain('分辨率')
    expect(fail({ files: ['a.pdf'], dpi: 'abc' })).toContain('分辨率')
  })

  it('force 只收布尔', () => {
    expect(ok({ files: ['a.pdf'] }).force).toBe(false)
    expect(ok({ files: ['a.pdf'], force: true }).force).toBe(true)
    expect(fail({ files: ['a.pdf'], force: 'yes' })).toContain('布尔')
  })
})

// ---------------------------------------------------------------------------
// 3. 注册表
// ---------------------------------------------------------------------------

describe('任务种类注册表', () => {
  beforeEach(() => clearJobSpecs())

  it('登记后可查、可列出(按名字排序)', () => {
    registerJob({ kind: 'b', status: 'todo', summary: 'b', parse: (r) => ({ ok: true, params: r }) })
    registerJob({ kind: 'a', status: 'todo', summary: 'a', parse: (r) => ({ ok: true, params: r }) })
    expect(getJobSpec('a')?.kind).toBe('a')
    expect(jobSpecs().map((s) => s.kind)).toEqual(['a', 'b'])
    expect(getJobSpec('nope')).toBeUndefined()
  })

  it('同名重复登记**抛错**(静默覆盖会让「注册了但跑的是另一个」很难查)', () => {
    const spec: JobSpec = { kind: 'x', status: 'todo', summary: 'x', parse: (r) => ({ ok: true, params: r }) }
    registerJob(spec)
    expect(() => registerJob(spec)).toThrow(/重复登记/)
  })

  it('启动登记完整任务目录，可重复调用且保留已登记的 spec', () => {
    registerJobSpecs()
    const kinds = jobSpecs()
    expect(kinds.map((s) => s.kind)).toEqual(['current-roster-export', 'difference-snapshot', 'lead-lists-version-export', 'ocr', 'platform-query-batch', 'render-pages', 'roster_export_cleanup'])
    for (const k of ['render-pages', 'ocr']) {
      expect(getJobSpec(k)!.status).toBe('ready')
      expect(getJobSpec(k)!.postgres?.run).toBeTypeOf('function')
    }
    // 「怎么拼 params」是给代理看的,不能只报名字。
    expect(getJobSpec('difference-snapshot')!.parse({})).toMatchObject({ ok: false, message: expect.stringContaining('dedicated') })
    expect(() => registerJobSpecs()).not.toThrow()
    clearJobSpecs()
    registerJob({ kind: 'render-pages', status: 'todo', summary: 'synthetic', parse: params => ({ ok: true, params }) })
    registerJobSpecs()
    expect(getJobSpec('render-pages')?.summary).toBe('synthetic')
    expect(jobSpecs().map(spec => spec.kind)).toEqual(kinds.map(spec => spec.kind))
  })
})

describe('lib/csv —— 多值查询参数的解析规则(抽出来的那一份)', () => {
  it('逗号分隔与重复参数都认,空项剔除', () => {
    expect(parseCsvQuery('a,b')).toEqual(['a', 'b'])
    expect(parseCsvQuery(['a', 'b'])).toEqual(['a', 'b'])
    expect(parseCsvQuery(['a,b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(parseCsvQuery(' a , b ')).toEqual(['a', 'b'])
  })

  it('没有有效项时返回 undefined —— 「没筛」与「筛了个空的」不是一回事', () => {
    expect(parseCsvQuery(undefined)).toBeUndefined()
    expect(parseCsvQuery(null)).toBeUndefined()
    expect(parseCsvQuery('')).toBeUndefined()
    expect(parseCsvQuery('  ')).toBeUndefined()
    expect(parseCsvQuery(',,')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 6. 鉴权(HTTP 面的头名)
// ---------------------------------------------------------------------------

describe('api-auth 鉴权判据', () => {
  it('readApiToken 认 Bearer / 裸 token / X-API-Token;取不到给 null', () => {
    expect(readApiToken({ authorization: 'Bearer abc' })).toBe('abc')
    expect(readApiToken({ authorization: 'bearer abc' })).toBe('abc')
    expect(readApiToken({ authorization: 'abc' })).toBe('abc')
    expect(readApiToken({ 'x-api-token': 'abc' })).toBe('abc')
    expect(readApiToken({ authorization: 'Bearer abc', 'x-api-token': 'zzz' })).toBe('abc')
    for (const h of [undefined, {}, { authorization: '' }, { authorization: '  ' }, { authorization: 'Bearer' }]) {
      expect(readApiToken(h as never)).toBeNull()
    }
  })

  it('resolveApiAuth 把「没配 / 没带 / 带错 / 带对」分得开', () => {
    expect(resolveApiAuth({ given: null, configured: '' }).reason).toBe('no-token-configured')
    expect(resolveApiAuth({ given: null, configured: undefined }).reason).toBe('no-token-configured')
    expect(resolveApiAuth({ given: null, configured: 's' }).reason).toBe('token-missing')
    expect(resolveApiAuth({ given: 'wrong', configured: 's' }).reason).toBe('token-invalid')
    expect(resolveApiAuth({ given: 's', configured: 's' })).toEqual({ writeAuthorized: true, reason: 'authorized' })
    // 反向默认:服务端没配 = 写/任务类整体关闭,即便请求带了 token。
    expect(resolveApiAuth({ given: 'anything', configured: '' }).writeAuthorized).toBe(false)
    // 「配了个空串」不等于「人人可写」。
    expect(resolveApiAuth({ given: '', configured: '' }).writeAuthorized).toBe(false)
  })

  it('拒绝文案说清是哪一种没带', () => {
    expect(unauthorizedApiMessage('no-token-configured')).toContain('NUXT_API_TOKEN')
    expect(unauthorizedApiMessage('token-missing')).toContain('未带 token')
    expect(unauthorizedApiMessage('token-invalid')).toContain('不匹配')
  })

  it('★ 密钥不进 spec:specLeaksToken 能判出来,且对占位文案不误报', () => {
    const secret = 'super-secret-token-value'
    // 泄露了:spec 里出现了真 token。
    expect(specLeaksToken({ paths: { '/x': { get: { example: secret } } } }, secret)).toBe(true)
    expect(specLeaksToken(JSON.stringify({ a: { b: secret } }), secret)).toBe(true)
    // 没泄露:只有**占位文案**(头名与「<token>」这种说明),这是 spec 里应该有的样子。
    const placeholderSpec = {
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', description: '`NUXT_API_TOKEN` 的值。' },
        },
      },
    }
    expect(specLeaksToken(placeholderSpec, secret)).toBe(false)
    // 未配置 / 空 token:一律不报(空串在 JSON 里到处都是,拿它比全是误报)。
    expect(specLeaksToken(placeholderSpec, '')).toBe(false)
    expect(specLeaksToken(placeholderSpec, null)).toBe(false)
    expect(specLeaksToken(placeholderSpec, undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. OpenAPI 的暴露面(开发注册 / 生产不注册)
// ---------------------------------------------------------------------------

/** 路由文件的目录(测试从 cwd 跑,与 vitest.config.ts 的 root 一致)。 */
const ROUTE_DIR = join(process.cwd(), 'layers/sme-roster/server/api')
const CORE_ROUTE_DIR = join(process.cwd(), 'layers/core/server/api')

describe('Nitro 内建 OpenAPI 的暴露面', () => {
  /** 按当前 nuxt.config 的口径问 nitro:它注册了哪些路由。 */
  async function openApiRoutes(dev: boolean): Promise<string[]> {
    // `{ dev }` 作为**第一参**传(nitro 从 config 里读 dev);第二参 `LoadConfigOptions`
    // 只收 watch / c12 / compatibilityDate / dotenv,不接受 dev。
    const nitro = await createNitro({
      rootDir: process.cwd(),
      compatibilityDate: '2026-10-14',
      dev,
      // 与 nuxt.config.ts 的 `nitro` 段逐字一致。
      experimental: { openAPI: true },
      openAPI: { meta: { title: 't', version: '1' }, ui: { swagger: false } },
    })
    const routes = nitro.options.handlers.map((h) => h.route ?? '')
    await nitro.close()
    return routes
  }

  it('★ 开发环境注册 /_openapi.json 与 /_scalar', async () => {
    const routes = await openApiRoutes(true)
    expect(routes).toContain('/_openapi.json')
    expect(routes).toContain('/_scalar')
    // swagger UI 显式关掉(与 scalar 同一份 spec 的两种渲染,留一个就够)。
    expect(routes).not.toContain('/_swagger')
  }, 60_000)

  it('★ 生产构建**不注册** —— 于是那两个端点在生产下是 404', async () => {
    // 本票不开生产。这条断言钉死这个默认:谁把 `openAPI.production` 打开了,
    // 这里就会红,而打开它必须同时自己加一道保护(见 .env.example 的警告)。
    const routes = await openApiRoutes(false)
    expect(routes).not.toContain('/_openapi.json')
    expect(routes).not.toContain('/_scalar')
  }, 60_000)

  it('nuxt.config 里确实是「开发开、生产不开」的那组设置', async () => {
    const cfg = (await import('../../../nuxt.config')).default as {
      nitro?: { experimental?: { openAPI?: boolean }; openAPI?: { production?: unknown; meta?: Record<string, string> } }
    }
    expect(cfg.nitro?.experimental?.openAPI).toBe(true)
    // 不设 production(而不是设成 false 之外的值)—— nitro 的判据是
    // `!dev && !production` 就 return,所以「不设」才是生产关闭。
    expect(cfg.nitro?.openAPI?.production).toBeUndefined()
    expect(cfg.nitro?.openAPI?.meta?.title).toBeTruthy()
    expect(cfg.nitro?.openAPI?.meta?.version).toBeTruthy()
  })

  it('★ 票面点名的公开路由**都带了** `defineRouteMeta` —— 这是 spec 的全部输入', async () => {
    // spec 的唯一来源就是各路由文件里的那个字面量块(nitro 的 handlers-meta 插件
    // 按 AST 抽)。所以「spec 含不含某条路由」等价于「那个路由文件里有没有那个块」。
    // 真正的 spec 内容(路径齐全、没有密钥)在**真实服务**上量过,见票 19 的交付记录。
    const routes = [
      'records.get.ts',
      'enterprises/[id].get.ts',
      'export.get.ts',
      'files/index.get.ts',
      'files/[id].patch.ts',
      'files/[id].delete.ts',
      'files/[...path].get.ts',
      'pdf-pages.get.ts',
      'pdf-pages.post.ts',
      'health.get.ts',
      'jobs/index.post.ts',
      'jobs/index.get.ts',
      'jobs/[id].get.ts',
      'jobs/[id].delete.ts',
      'jobs/kinds.get.ts',
    ]
    for (const rel of routes) {
      const source = await readFile(join(/^(?:(?:jobs|files)\/|pdf-pages\.)/.test(rel) ? CORE_ROUTE_DIR : rel === 'health.get.ts' ? join(process.cwd(), 'server/api') : ROUTE_DIR, rel), 'utf8')
      expect(source, rel).toContain('defineRouteMeta({')
      // 宏必须写在**顶层**(nitro 只认顶层 ExpressionStatement),所以别塞进函数里。
      expect(/^defineRouteMeta\(/m.test(source), rel).toBe(true)
    }
  })

  it('生产守卫:那三条路径在生产回 404,在开发放行', () => {    // nitro 的「不注册」在 SPA(ssr:false)下的可观测结果是 **200 + index.html**
    // (兜底页),而不是 404 —— 守卫把「这里没有」说清楚。真实构建下的 404 见票 19
    // 的实测记录;这里是那条行为的判据本身。
    for (const p of ['/_openapi.json', '/_scalar', '/_swagger']) {
      expect(shouldHideOpenApiPath(p, { dev: false })).toBe(true)
      expect(shouldHideOpenApiPath(p, { dev: true })).toBe(false)
    }
    // 精确匹配,不是前缀 —— SPA 里真有别的页也不误伤。
    expect(shouldHideOpenApiPath('/api/health', { dev: false })).toBe(false)
    expect(shouldHideOpenApiPath('/_scalar/extra', { dev: false })).toBe(false)
    expect(shouldHideOpenApiPath('/', { dev: false })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 8. render-pages 的 handler:一份失败不停批(用真夹具 PDF)
// ---------------------------------------------------------------------------

describe('render-pages 的 run(真 pdfium + sharp)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-batch-pg-'))
  let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  beforeAll(async () => {
    runtime = await postgresRuntimeFixture({ dir })
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', runtime.url)
    vi.stubEnv('NUXT_DB_READONLY', '0')
  }, 20_000)
  afterAll(async () => {
    try {
      await closePostgresDirectoryDb()
      runtime?.close()
    } finally {
      vi.unstubAllEnvs()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  async function seedFile(root: string, relPath: string) {
    const bytes = await readFile(join(root, relPath))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await usePostgresDirectoryDb().execute(sql`
      INSERT INTO business.stored_file (rel_path, filename, ext, bytes, sha256, created_at)
      VALUES (${relPath}, ${relPath.split('/').at(-1)}, 'pdf', ${bytes.length}, ${sha256}, '2026-11-22')
    `)
  }

  async function run(root: string, params: Record<string, unknown>, hooks: Pick<PostgresJobContext, 'progress' | 'cancelled'>) {
    const db = usePostgresDirectoryDb()
    const handler = renderPagesSpec.postgres!
    const snapshot = await db.transaction(tx => handler.prepare!(tx, params))
    return handler.run({
      db, jobId: 'render-test', filesDir: root, signal: new AbortController().signal, logContext: {},
      checkpoint: async () => undefined, trackSubmissions: async task => task(() => undefined),
      ...hooks,
    }, params, snapshot)
  }

  it('批量渲染遇到坏文件后仍继续并逐份报告结果', async () => {
    const root = mkdtempSync(join(dir, 'spztx-render-batch-'))
    const rel = 'jxj/announcement/2024/1/fixture.pdf'
    const badRel = 'jxj/announcement/2024/1/broken.pdf'
    await mkdir(join(root, 'jxj/announcement/2024/1'), { recursive: true })
    await writeFile(join(root, rel), minimalPdf({ pages: 3 }))
    // 一份不是 PDF 的「PDF」:pdfium 打不开 → 这一项失败,但不该拖垮整批。
    await writeFile(join(root, badRel), Buffer.from('这不是 PDF'))
    await seedFile(root, rel)
    await seedFile(root, badRel)

    const parsed = renderPagesSpec.parse({ files: [badRel, rel], dpi: 100 })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const seen: Array<[number, number]> = []
    const completion = await run(root, parsed.params, {
      progress: async (done, total) => { seen.push([done, total]) },
      cancelled: async () => false,
    })

    const result = completion.result as {
      files: Array<{ file: string; ok: boolean; pageCount?: number; error?: string }>
      total: number
      ok: number
      failed: number
    }
    expect(result.total).toBe(2)
    expect(result.ok).toBe(1)
    expect(result.failed).toBe(1)
    // 好的那份渲染到位。
    expect(result.files[1]!.ok).toBe(true)
    expect(result.files[1]!.pageCount).toBe(3)
    // 坏的那份**有原因**,且是逐项的。
    expect(result.files[0]!.ok).toBe(false)
    expect(result.files[0]!.error).toBeTruthy()
    // 整体记 failed(状态诚实),但明细在 result 里(信息完整)。
    expect(completion.error).toContain('1 份渲染失败')

    // 进度按份报:2 份 → 两次回调,分母都是 2。
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ])
    // 页图真的落盘了(3 页)。
    const pagesDir = join(root, 'jxj/announcement/2024/1/.fixture.pdf.pages')
    expect((await readdir(pagesDir)).filter((n) => /^p\d+\.png$/.test(n))).toHaveLength(3)

    rmSync(root, { recursive: true, force: true })
  }, 60_000)

  it('取消时**带着部分产出**收尾,而不是丢掉明细', async () => {
    const root = mkdtempSync(join(dir, 'spztx-render-cancel-'))
    const a = 'jxj/announcement/2024/1/a.pdf'
    const b = 'jxj/announcement/2024/1/b.pdf'
    await mkdir(join(root, 'jxj/announcement/2024/1'), { recursive: true })
    await writeFile(join(root, a), minimalPdf({ pages: 2 }))
    await writeFile(join(root, b), minimalPdf({ pages: 2 }))
    await seedFile(root, a)
    await seedFile(root, b)

    const parsed = renderPagesSpec.parse({ files: [a, b], dpi: 100 })
    if (!parsed.ok) throw new Error('参数本应通过')

    // 第一份渲染完之后再置取消标记 —— 模拟「处理完这份才发现被取消」。
    // 计数挂在 progress 上:handler 每做完一份报一次,于是第二份**开工前**
    // 的检查点就会看到 cancelled。
    let renders = 0
    const completion = await run(root, parsed.params, {
      progress: async () => { renders += 1 },
      cancelled: async () => renders > 0,
    })

    const result = completion.result as { files: unknown[]; done?: number; cancelled?: boolean; total: number }
    expect(completion.cancelled).toBe(true)
    expect(result.cancelled).toBe(true)
    expect(result.total).toBe(2)
    // 只做了第一份,但那一份的明细**在**。
    expect(result.files).toMatchObject([{ file: a, ok: true, written: 2 }])
    expect(result.done).toBe(1)

    rmSync(root, { recursive: true, force: true })
  }, 60_000)

  it('幂等:同一份渲染两次,第二次 written=0', async () => {
    const root = mkdtempSync(join(dir, 'spztx-render-idem-'))
    const rel = 'jxj/announcement/2024/1/idem.pdf'
    await mkdir(join(root, 'jxj/announcement/2024/1'), { recursive: true })
    await writeFile(join(root, rel), minimalPdf({ pages: 2 }))
    await seedFile(root, rel)

    const parsed = renderPagesSpec.parse({ files: [rel], dpi: 100 })
    if (!parsed.ok) throw new Error('参数本应通过')
    const hooks = {
      progress: async () => undefined,
      cancelled: async () => false,
    }
    const first = (await run(root, parsed.params, hooks)).result as {
      files: Array<{ written: number; skipped: number; rendered: number }>
    }
    expect(first.files[0]!.written).toBe(2)
    const second = (await run(root, parsed.params, hooks)).result as {
      files: Array<{ written: number; skipped: number; rendered: number }>
    }
    expect(second.files[0]!.written).toBe(0)
    expect(second.files[0]!.skipped).toBe(2)

    // 页图目录里没有多余的临时文件残留。
    const pagesDir = join(root, 'jxj/announcement/2024/1/.idem.pdf.pages')
    const names = await readdir(pagesDir)
    expect(names.filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
    expect(names.sort()).toEqual(['.pages.json', 'p001.png', 'p002.png'])
    // 清单里的源哈希与磁盘一致(幂等判据的载体)。
    const manifest = JSON.parse(await readFile(join(pagesDir, '.pages.json'), 'utf8')) as {
      sourceSha256: string
      dpi: number
    }
    expect(manifest.dpi).toBe(100)
    expect(manifest.sourceSha256).toMatch(/^[0-9a-f]{64}$/)

    rmSync(root, { recursive: true, force: true })
  }, 60_000)
})
