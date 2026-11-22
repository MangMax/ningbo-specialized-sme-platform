import { summarizePostgresReconcileJobs } from './reconcile-summary-postgres'
import { resolvePostgresCredential } from '../../../../core/server/utils/credential-state-postgres'
import type { ComparisonDirection } from '../../../lib/comparison'
import { TITLE_ORDER } from '../../../lib/labels'
import type { ReconcileReport } from '../platform-reconcile'
import { runPostgresPlatformReconcile } from '../platform-reconcile-postgres'
import type { JobCompletion, JobParseResult, JobSpec } from '../../../../core/server/public'

const TITLE_CODES = new Set(TITLE_ORDER)
const DIRECTIONS = new Set<ComparisonDirection>(['missing_in_miit', 'extra_in_miit'])

function stringList(value: unknown, field: string): { ok: true; value: string[] | undefined } | { ok: false; message: string } {
  if (value == null) return { ok: true, value: undefined }
  const parts = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const part of parts) {
    for (const item of String(part).split(',')) {
      const trimmed = item.trim()
      if (trimmed) out.push(trimmed)
    }
  }
  if (!out.length) return { ok: false, message: `${field} 不能是空列表` }
  return { ok: true, value: out }
}

function positiveInt(value: unknown, field: string, max: number): { ok: true; value: number } | { ok: false; message: string } {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > max) {
    return { ok: false, message: `${field} 必须是 1–${max} 的整数,收到:${String(value)}` }
  }
  return { ok: true, value: n }
}

function parseReconcileParams(raw: Record<string, unknown>): JobParseResult {
  const params: Record<string, unknown> = {}

  const titles = stringList(raw.titles, 'titles')
  if (!titles.ok) return { ok: false, message: titles.message }
  if (titles.value) {
    const unknown = titles.value.filter((code) => !TITLE_CODES.has(code))
    if (unknown.length) {
      return { ok: false, message: `titles 含未知称号:${unknown.join('、')}。可用:${[...TITLE_CODES].join('、')}` }
    }
    params.titles = titles.value
  }

  const directions = stringList(raw.directions, 'directions')
  if (!directions.ok) return { ok: false, message: directions.message }
  if (directions.value) {
    const unknown = directions.value.filter((code) => !DIRECTIONS.has(code as ComparisonDirection))
    if (unknown.length) {
      return { ok: false, message: `directions 含未知方向:${unknown.join('、')}。可用:${[...DIRECTIONS].join('、')}` }
    }
    params.directions = directions.value
  }

  const usccs = stringList(raw.usccs, 'usccs')
  if (!usccs.ok) return { ok: false, message: usccs.message }
  if (usccs.value) {
    // 统一社会信用代码是 18 位大写字母数字;不在这里做校验位判断(那是 #6 的口径),
    // 但明显不是就不该让一个注定查不到的任务跑起来。
    const malformed = usccs.value.filter((code) => !/^[0-9A-Z]{18}$/.test(code))
    if (malformed.length) {
      return { ok: false, message: `usccs 含非法统一社会信用代码:${malformed.join('、')}(应为 18 位大写字母数字)` }
    }
    params.usccs = usccs.value
  }

  if (raw.limit != null) {
    const limit = positiveInt(raw.limit, 'limit', 100_000)
    if (!limit.ok) return { ok: false, message: limit.message }
    params.limit = limit.value
  }
  if (raw.offset != null) {
    // 与 `limit` 配成分页;`offset` 可以为 0(等于不跳),所以单独判。
    const offset = Number(raw.offset)
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
      return { ok: false, message: `offset 必须是 0–100000 的整数,收到:${String(raw.offset)}` }
    }
    params.offset = offset
  }
  if (raw.concurrency != null) {
    const concurrency = positiveInt(raw.concurrency, 'concurrency', 12)
    if (!concurrency.ok) return { ok: false, message: concurrency.message }
    params.concurrency = concurrency.value
  }
  if (raw.freshnessHours != null) {
    const hours = positiveInt(raw.freshnessHours, 'freshnessHours', 24 * 365)
    if (!hours.ok) return { ok: false, message: hours.message }
    params.freshnessHours = hours.value
  }
  if (raw.write != null) {
    if (typeof raw.write !== 'boolean') return { ok: false, message: 'write 必须是布尔值' }
    params.write = raw.write
  }
  return { ok: true, params }
}

function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  return typeof value === 'number' ? value : undefined
}

export const reconcileSpec: JobSpec = {
  openAPIParams: {
    order: 50,
    description: '`reconcile`:`{ titles?: string[](称号代号), directions?: ("missing_in_miit"|"extra_in_miit")[], usccs?: string[](只查这几个统一社会信用代码), limit?: number(最多处理多少个差异目标), concurrency?: 1–12(默认 4), freshnessHours?: number(保留既有待核处理状态的时限（默认 24 小时）), write?: boolean(默认 true;false = 只采集预览不回写) }` —— 需要配置页保存 Cookie 或服务端配好 `MIIT_COOKIE`,未配时任务**明确失败且一行不写**(不产出一片「未查询」的假证据)。',
  },
  kind: 'reconcile',
  status: 'ready',
  summary: '现场批量查询工信部 businessList / applyList，保存核查结果，原因由代理核实',
  paramsHint:
    '可选:{ titles?: string[](称号代号,如 specialized_sme/innovative_sme/little_giant);' +
    ' directions?: ("missing_in_miit"|"extra_in_miit")[]; usccs?: string[](只查这几个统一社会信用代码,小样本实查用);' +
    ' limit?: number(最多处理多少个差异目标,分批长跑用);offset?: number(跳过前 N 个,与 limit 配成分页);' +
    ' concurrency?: 1–12(默认 4);freshnessHours?: number(保留既有待核处理状态的时限（默认 24 小时）);' +
    ' write?: boolean(默认 true;false = 只采集预览不回写) }',
  note: '通过配置页 Cookie 或 MIIT_COOKIE 查询，有统代的差异才能实查。',
  parse: parseReconcileParams,
  postgres: {
    taskCenter: { summaries: summarizePostgresReconcileJobs },
    async run(ctx, params) {
      const cookie = (await resolvePostgresCredential(ctx.db, 'sme-roster.miitCookie')).value
      const report = await runPostgresPlatformReconcile(ctx.db, {
        ...reconcileOptions(params),
        cookie,
        onProgress: (done, total) => ctx.progress(done, total),
        shouldCancel: () => ctx.cancelled(),
        isWriteCancelled: () => ctx.cancelled(),
      })
      return reconcileCompletion(report)
    },
  },
}

export function reconcileOptions(params: Record<string, unknown>) {
  const freshnessHours = numberParam(params, 'freshnessHours')
  return {
    titles: params.titles as string[] | undefined,
    directions: params.directions as ComparisonDirection[] | undefined,
    usccs: params.usccs as string[] | undefined,
    limit: numberParam(params, 'limit'),
    offset: numberParam(params, 'offset'),
    concurrency: numberParam(params, 'concurrency'),
    freshnessMs: freshnessHours != null ? freshnessHours * 60 * 60 * 1000 : undefined,
    write: params.write !== false,
  }
}

export function reconcileCompletion(report: ReconcileReport): JobCompletion {
  return report.cancelled ? { result: report, cancelled: true } : { result: report }
}
