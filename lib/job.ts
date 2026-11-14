/**
 * 异步任务的**纯规则**:状态取值、进度形状、任务 id 的生成与校验、参数归一。
 *
 * 分工沿用本仓已有分法(见 `lib/pdf-page.ts` 顶部):`lib/job.ts` 放**规则**,
 * `server/utils/job-store.ts` 放**库读写**,`server/utils/job-runner.ts` 放**执行**。
 * 规则这一层零依赖、可单测 —— 任务 id 的形状、进度的取整、状态的终态判定
 * 都是「错了就很难在集成测试里看出来」的东西(比如 `percent` 少取一次整会让
 * 99% 永远不到 100),单独成文件是为了能在纯函数层面钉住。
 *
 */

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/**
 * 任务的五个状态。**顺序即生命周期**:`queued → running → done|failed|cancelled`。
 * 常规执行只前进一步(markRunning / finish 都只从非终态出发)。平台批次专用的显式重试可重开同一任务,由独立的有界重试入口校验。
 */
export const JOB_STATES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const

export type JobState = (typeof JOB_STATES)[number]

/** 是否已结束。终态的任务不再被 runner 碰,也不接受取消。 */
export function isTerminalJobState(state: JobState): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled'
}

// ---------------------------------------------------------------------------
// 进度
// ---------------------------------------------------------------------------

/**
 * 进度:**已做/总数**这一对数字,不是 0–100 的百分比。
 *
 * 为什么存 `{done,total}` 而不是百分数:百分数是**派生量**,四舍五入过就没法反推
 * 「还剩几份」。批量任务里 `3/7` 比 `42%` 有用得多 —— 代理据此估算还要等多久,
 * 百分比只够画个进度条。百分数由 `progressPercent` 现算,不落库。
 */
export interface JobProgress {
  done: number
  total: number
}

/** Explicit `view=summary` read contract. Bodies stay at the unqualified detail URL. */
export interface JobSummaryDto {
  id: string
  kind: string
  state: JobState
  progress: JobProgress
  percent: number | null
  /** Fixed notice when an error exists; full sanitized error is in detail. */
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  resultSummary: { available: boolean }
  detailUrl: string
  /** Eligibility only; cancellation still requires the existing write token. */
  capabilities: { cancel: boolean }
}

/** 进度初值:`total` 未知或非法时按 1 算(通用任务就是 0% → 100% 两档)。 */
export function makeProgress(done: number, total: number): JobProgress {
  const d = Number.isFinite(done) && done > 0 ? Math.floor(done) : 0
  const t = Number.isFinite(total) && total > 0 ? Math.floor(total) : 1
  return { done: Math.min(d, t), total: t }
}

/**
 * 百分比(整数 0–100)。`total` 为 0(空批量)时返回 0 —— 不做 `done/total` 的除法。
 *
 * 取整用 `Math.floor` 而**不是** `round`:`round` 会让 `done=99,total=100` 报 99、
 * `done=199,total=200` 也报 100(99.5 → 100),界面上就会出现「进度条满了但任务还在跑」。
 * `floor` 只会在真正做完时到 100。
 */
export function progressPercent(progress: JobProgress): number {
  if (progress.total <= 0) return 0
  return Math.max(0, Math.min(100, Math.floor((progress.done / progress.total) * 100)))
}

// ---------------------------------------------------------------------------
// 任务 id
// ---------------------------------------------------------------------------

/** Crockford base32(去掉了 I / L / O / U,避免与 1 / 0 混淆,也不拼出脏词)。 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RANDOM_LEN = 16

/** 任务 id 的形状:26 位 Crockford base32。 */
export const JOB_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** 形状校验。**只判形状**,不查库 —— 路由用它区分「id 写错了」(400)与「查无此任务」(404)。 */
export function isJobId(value: unknown): value is string {
  return typeof value === 'string' && JOB_ID_RE.test(value)
}

/**
 * 生成一个 **ULID**:48 位毫秒时间戳(10 字符)+ 80 位随机(16 字符)= 26 字符。
 *
 * 为什么不用随手一个自增整数:任务 id 会**出现在 URL 里**(`GET /api/jobs/:id`),
 * 自增整数等于把「一共提交过多少任务」公开出去,也让代理能顺手枚举别人的任务。
 *
 * 为什么用 ULID 而不是 UUID:ULID **前半段是时间**,所以字典序 == 提交序 ——
 * `order by id` 就等价于 `order by created_at`,列表默认顺序不依赖另一列,
 * 分页游标也只带一个字段。(uuid v4 是纯随机,排序得靠 `created_at` 兜。)
 *
 * `now` / `random` 可注入,是为了让测试能拿到**确定**的 id 与确定的排序;
 * 生产调用不带参,时间取 `Date.now()`、随机取 CSPRNG。
 */
export function newJobId(now: number = Date.now(), random?: Uint8Array): string {
  return encodeTime(now) + encodeRandom(random ?? randomBytes(RANDOM_LEN))
}

function encodeTime(ms: number): string {
  const t = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0
  let out = ''
  let rest = t
  for (let i = 0; i < TIME_LEN; i += 1) {
    out = ENCODING[rest % 32]! + out
    rest = Math.floor(rest / 32)
  }
  return out
}

function encodeRandom(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    // `& 31` 与 `% 32` 等价(取低 5 位):一个字节低 5 位若是均匀的,
    // 结果就均匀 —— 这里不引入偏差,而 `% 32` 在 8 位字节上本来也没有偏差(256 整除 32)。
    out += ENCODING[(bytes[i] ?? 0) & 31]!
  }
  return out
}

/**
 * 取随机字节。用 `globalThis.crypto`(Node 19+ 与浏览器都有)而**不是**
 * `node:crypto` —— 少一个 node 专属 import,这个文件就还能在客户端被引用。
 */
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

// ---------------------------------------------------------------------------
// 参数归一
// ---------------------------------------------------------------------------

/** 归一结果:成功带**干净的**对象,失败带一句中文原因(路由直接当 400 的文案)。 */
export type JobParamsResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; message: string }

/**
 * 把请求体里的 `params` 归成一个**普通对象**。
 *
 * 数组与标量一律拒掉:任务是「带着参数去做一件事」,参数不是列表本身。
 * 缺省(未给 / `null`)当成空对象 —— 「不需要参数的任务」是正常的,不是错误。
 */
export function normalizeJobParams(raw: unknown): JobParamsResult {
  if (raw === undefined || raw === null) return { ok: true, params: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'params 必须是对象(JSON object)' }
  }
  return { ok: true, params: { ...(raw as Record<string, unknown>) } }
}
