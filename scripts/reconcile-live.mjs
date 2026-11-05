#!/usr/bin/env node
/**
 * **平台证据采集与待核写回 —— 无头长跑入口**(RL-03 实施切片 ③)。
 *
 * ── 它是什么、不是什么 ────────────────────────────────────────────────────
 * 这是 `kind: 'reconcile'` 那个异步任务的**第二个入口**,不是第二份逻辑:
 * 两者都调用 `server/utils/platform-reconcile.ts` 的 `runPlatformReconcile`,
 * 而它就是那条链的唯一一份实现
 * (取差异集合 → 实查两接口 → 落证据 → 交代理查证原因与措施 → 经统一 API 写回)。
 * 之所以另开一个脚本入口:一次全量实查是分钟到小时级(平台实测 0.3–1.1 秒/次),
 * 长跑要能脱离 HTTP 请求/服务器进程,也要能把 JSON 报告落到文件。
 *
 * ── 两种运行模式 ──────────────────────────────────────────────────────────
 *  1. **默认(进程内)**:直接开库、直接实查、直接走统一导入 API 的核心函数写回。
 *     无需 app 在跑。适合本机全量长跑。
 *  2. `--base-url <url>`:**把同一个 job 提交给正在运行的 app** 并轮询到结束
 *     (`POST /api/jobs` → `GET /api/jobs/:id?view=summary` → 终态读取完整详情)。适合对着部署好的实例跑;
 *     token 从 `NUXT_API_TOKEN` 读(不进命令行,免得出现在 `ps` 里)。
 *
 * ── 凭据 ──────────────────────────────────────────────────────────────────
 * 独立脚本可通过 `MIIT_COOKIE` 提供平台会话凭据,凭据不进日志、不进仓库。
 *
 * 用法:
 *   node scripts/reconcile-live.mjs [选项]
 *
 * 选项:
 *   --db <路径>            数据库(默认 NUXT_DB_PATH,再默认 data/roster.db)
 *   --titles a,b           只处理这些称号(如 specialized_sme,little_giant)
 *   --directions a,b       只处理这些方向(missing_in_miit / extra_in_miit)
 *   --usccs a,b            只查这几个统一社会信用代码(小样本实查 / 复现用)
 *   --limit N              最多处理多少个差异目标(与 --offset 配成分页)
  --offset N             跳过前 N 个差异目标(分批长跑用;与 --offset 配成分页)
 *   --offset N             跳过前 N 个差异目标(分页的第二片起)
 *   --concurrency N        并发上限,1–12(默认 4)
 *   --freshness-hours N    复用新鲜查询与判定的窗口(默认 24)
 *   --dry-run              只采集预览、不回写
 *   --out <路径>           把报告 JSON 写到文件
 *   --base-url <url>       提交 job 给正在运行的 app 并轮询(需要 NUXT_API_TOKEN)
 *   --poll-seconds N       轮询间隔(默认 3)
 *   --help
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 为什么要重新起一次自己 ────────────────────────────────────────────────
// Node 自带的类型剥离有**两种模式**:`strip`(默认)只删类型、遇到枚举 / 命名空间 /
// 构造器参数属性这类「需要真编译」的语法直接报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`,
// 而本仓的 `server/utils/roster-import.ts` 里就有一个构造器参数属性。要加载它就得开
// `--experimental-transform-types`(真编译)。该开关**只能由命令行给**,运行时读不到,
// 所以这里把进程自己重启一次并带上它 —— 只重启一次(`execArgv` 里已有就不再重启)。
if (!process.execArgv.includes('--experimental-transform-types')) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  process.exit(result.status ?? 1)
}

// 让本脚本能 import 本仓的 `.ts` 核心(见 hooks 文件里为什么需要它)。
register(new URL('./lib/ts-resolve-hooks.mjs', import.meta.url), import.meta.url)

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const has = (name) => args.includes(`--${name}`)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}
const list = (name) => {
  const value = flag(name, null)
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : undefined
}

const HELP = `平台证据采集与待核写回 —— 无头长跑入口(RL-03)

用法: node scripts/reconcile-live.mjs [选项]

  --db <路径>            数据库(默认 NUXT_DB_PATH,再默认 data/roster.db)
  --titles a,b           只处理这些称号
  --directions a,b       只处理这些方向(missing_in_miit / extra_in_miit)
  --usccs a,b            只查这几个统一社会信用代码(小样本实查 / 复现用)
  --limit N              最多处理多少个差异目标(与 --offset 配成分页)
  --offset N             跳过前 N 个差异目标
  --concurrency N        并发上限,1–12(默认 4)
  --freshness-hours N    复用新鲜查询与判定的窗口(默认 24)
  --dry-run              只采集预览、不回写
  --out <路径>           把报告 JSON 写到文件
  --base-url <url>       提交 job 给正在运行的 app 并轮询(需要 NUXT_API_TOKEN)
  --poll-seconds N       轮询间隔(默认 3)
  --help                 显示本说明

凭据:独立脚本可从 MIIT_COOKIE 读取平台会话(不进日志、不进仓库)。
`

if (has('help')) {
  process.stdout.write(HELP)
  process.exit(0)
}

const dbPath = flag('db', process.env.NUXT_DB_PATH ?? resolve(ROOT, 'data/roster.db'))
const titles = list('titles')
const directions = list('directions')
const usccs = list('usccs')
const limit = flag('limit', null)
const offset = flag('offset', null)
const concurrency = flag('concurrency', null)
const freshnessHours = flag('freshness-hours', null)
const dryRun = has('dry-run')
const out = flag('out', null)
const baseUrl = flag('base-url', null)
const pollSeconds = Number(flag('poll-seconds', '3'))
const token = process.env.NUXT_API_TOKEN ?? ''

/** 数字参数:给了必须是正整数,否则直接退出(不静默用默认值把长跑跑偏)。 */
function positiveInt(name, raw) {
  if (raw == null) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    process.stderr.write(`✗ --${name} 必须是正整数,收到:${raw}\n`)
    process.exit(2)
  }
  return value
}

/** `offset` 允许 0(等于不跳),其余同上。 */
function nonNegativeInt(name, raw) {
  if (raw == null) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    process.stderr.write(`✗ --${name} 必须是 0 或正整数,收到:${raw}\n`)
    process.exit(2)
  }
  return value
}

const jobParams = {
  ...(titles ? { titles } : {}),
  ...(directions ? { directions } : {}),
  ...(usccs ? { usccs } : {}),
  ...(limit != null ? { limit: positiveInt('limit', limit) } : {}),
  ...(offset != null ? { offset: nonNegativeInt('offset', offset) } : {}),
  ...(concurrency != null ? { concurrency: positiveInt('concurrency', concurrency) } : {}),
  ...(freshnessHours != null ? { freshnessHours: positiveInt('freshness-hours', freshnessHours) } : {}),
  ...(dryRun ? { write: false } : {}),
}

// ---------------------------------------------------------------------------
// 模式 2:提交给正在运行的 app 并轮询
// ---------------------------------------------------------------------------

async function runRemote() {
  if (!token) {
    process.stderr.write('✗ --base-url 模式需要 NUXT_API_TOKEN(只从环境读,不进命令行)。\n')
    process.exit(2)
  }
  const base = baseUrl.replace(/\/+$/, '')
  const created = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ kind: 'reconcile', params: jobParams }),
  })
  const accepted = await created.json().catch(() => null)
  if (!created.ok) {
    process.stderr.write(`✗ 提交任务失败(${created.status}):${JSON.stringify(accepted)}\n`)
    process.exit(1)
  }
  const jobId = accepted.jobId
  process.stdout.write(`▶ 已提交 job ${jobId}(轮询 ${base}/api/jobs/${jobId})\n`)
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000))
    const response = await fetch(`${base}/api/jobs/${jobId}?view=summary`, {
      headers: { authorization: `Bearer ${token}` },
    })
    let job = await response.json().catch(() => null)
    if (!response.ok || !job) {
      process.stderr.write(`✗ 读取任务失败(${response.status})\n`)
      process.exit(1)
    }
    process.stdout.write(`  ${job.state} ${job.progress?.done ?? 0}/${job.progress?.total ?? '?'}\n`)
    if (['done', 'failed', 'cancelled'].includes(job.state)) {
      // A stored result may be only a checkpoint. Read the authoritative full
      // receipt/error once at termination, never hydrate each progress poll.
      const detail = await fetch(`${base}/api/jobs/${jobId}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      job = await detail.json().catch(() => null)
      if (!detail.ok || !job) {
        process.stderr.write(`✗ 读取任务详情失败(${detail.status})\n`)
        process.exit(1)
      }
      // A domain retry can reopen the same job between the two reads.
      if (!['done', 'failed', 'cancelled'].includes(job.state)) continue
      if (job.state !== 'done') {
        process.stderr.write(`✗ 任务 ${job.state}:${job.error ?? ''}\n`)
        if (job.result) writeReport(job.result)
        process.exit(1)
      }
      return job.result
    }
  }
}

// ---------------------------------------------------------------------------
// 模式 1:进程内(默认)
// ---------------------------------------------------------------------------

async function runLocal() {
  if (!existsSync(dbPath)) {
    process.stderr.write(`✗ 数据库不存在:${dbPath}(用 --db 指定)\n`)
    process.exit(2)
  }
  const { initializeDb } = await import('../db/client.ts')
  const { runPlatformReconcile } = await import('../server/utils/platform-reconcile.ts')
  const { resolveCookie } = await import('../lib/platform/client.ts')
  const db = initializeDb({ dbPath })
  return runPlatformReconcile({
    db,
    cookie: () => resolveCookie(undefined),
    titles,
    directions,
    usccs,
    limit: jobParams.limit,
    offset: jobParams.offset,
    concurrency: jobParams.concurrency,
    freshnessMs: jobParams.freshnessHours != null ? jobParams.freshnessHours * 3600_000 : undefined,
    write: !dryRun,
    onProgress: (done, total) => {
      if (done === 0 || done === total || done % 10 === 0) {
        process.stdout.write(`  查询进度 ${done}/${total}\n`)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

function writeReport(report) {
  if (!out) return
  const target = resolve(out)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`  报告已写入 ${target}\n`)
}

const REASON_LABELS = {
  moved_out: '外迁',
  deregistered: '注销',
  renamed: '更名',
  platform_stale: '平台未更新',
  moved_in: '迁入',
  other: '其他',
}

function printReport(report) {
  const { counts, queries } = report
  const reasons = Object.entries(counts.byReason)
    .map(([code, value]) => `${REASON_LABELS[code] ?? code} ${value}`)
    .join('、')
  process.stdout.write(
    [
      '',
      '平台证据采集与待核写回 —— 完成',
      `  差异目标 ${counts.total}(可直查 ${report.targetCount - counts.notQueried},无统代无法直查 ${counts.notQueried})`,
      `  实查 USCC ${report.usccCount}:网络请求 ${queries.network} 次(业务 ${queries.byInterface.business_list ?? 0} / 申报 ${queries.byInterface.apply_list ?? 0}),复用新鲜查询 ${queries.reused} 槽位`,
      `  平台关系 ${report.relations} 条`,
      `  已查并确认 ${counts.confirmed}${reasons ? `(${reasons})` : ''}`,
      `  无记录 ${counts.noRecord}`,
      `  待人工 ${counts.needsReview}`,
      `  查询失败 ${counts.queryFailed}`,
      `  无法直查(无统代) ${counts.notQueried}`,
      `  复用处理状态/保留已确认结论 ${counts.reusedFresh}`,
      `  曾用名 ${report.aliases} 条`,
      report.mergeCandidates.length
        ? `  可能是一次归并(仅提示,未自动做)${report.mergeCandidates.length} 处:${report.mergeCandidates
            .map((item) => `${item.fromName}(id ${item.fromEnterpriseId})→${item.intoName}(id ${item.intoEnterpriseId})`)
            .join('、')}`
        : '  可能是一次归并(仅提示,未自动做)0 处',
      report.write
        ? `  写回:批次 ${report.write.batchId} ${report.write.status}(written ${report.write.written} / skipped ${report.write.skipped})`
        : '  写回:未执行(试跑或没有需要写回的证据/状态)',
      '',
    ].join('\n'),
  )
}

try {
  const report = baseUrl ? await runRemote() : await runLocal()
  printReport(report)
  writeReport(report)
  process.exit(0)
} catch (error) {
  process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
