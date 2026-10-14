import { getJobSpec, registerJob, type JobSpec } from './job-runner'
import { ocrSpec } from './jobs/ocr'
import { renderPagesSpec } from './jobs/render-pages'

/**
 * **任务种类注册表** —— 本票的扩展点。
 *
 * 加一个新 kind 只需两步:写一个 `JobSpec`(参数校验 + run),在这里登记一行。
 * 路由、鉴权、队列、进度、取消、持久化**都不用改** —— 那些是执行面的事
 * (见 `server/utils/job-runner.ts`),与具体做什么无关。
 *
 * ── `ocr` 已从 `todo` 变成 `ready`(票 14)──────────────────────────────
 * 票 19 登记它时给的理由是「**结果无处可放**」:票 14 的 OCR 结果表还没建。
 * 表落地之后,`ocr` 的实现搬进了 `server/utils/jobs/ocr.ts`(与 `render-pages` 同级),
 * 这里只是把它登记进来 —— 注册表、路由、练习器一行都没动,
 * 这正是当初「登记成 todo 而不是删掉」想要的效果:能力接上时**只换实现**。
 */

/**
 * 平台核查(工信部 businessList / applyList 两个接口)。
 *
 * 没接的原因与 OCR 不同:票 16 **已经做完了**,但它是 `../pipeline` 里的 **CLI**
 * (`pnpm reconcile`),产出是一份 JSON 缓存(app 只读,见 `lib/reconcile.ts`)。
 * 把它变成任务,需要把 pipeline 的那段逻辑搬进来或做成子进程 —— 那是跨仓的结构决定,
 * 不在本票范围内。这里的登记是给它留位。
 */
const reconcileSpec: JobSpec = {
  kind: 'reconcile',
  status: 'todo',
  summary: '批量平台核查(工信部 businessList / applyList)',
  note: '尚未接入:票 16 目前是 pipeline 的 CLI(`pnpm reconcile`),产出 JSON 缓存供 app 只读。',
  parse: (raw) => ({ ok: true, params: raw }),
}

/**
 * 登记全部 kind。**幂等**(按已登记的 kind 判,不用模块级布尔 —— 那会让测试里
 * `clearJobSpecs()` 之后的重新登记被静默跳过),可以被多个路由重复调用。
 */
export function registerJobSpecs(): void {
  if (getJobSpec(renderPagesSpec.kind)) return
  registerJob(renderPagesSpec)
  registerJob(ocrSpec)
  registerJob(reconcileSpec)
}
