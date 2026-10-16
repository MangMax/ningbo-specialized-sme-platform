import { getJobSpec, registerJob } from './job-runner'
import { ocrSpec } from './jobs/ocr'
import { reconcileSpec } from './jobs/reconcile'
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
 *
 * ── `reconcile` 也走完了同一条路(RL-03 收尾切片)─────────────────────────
 * 票 16 登记它时给的理由是「要跨仓把 pipeline 的 CLI 搬进来」,所以留了 `todo`。
 * 现在核心逻辑在 `server/utils/platform-reconcile.ts`(app 自己的模块,不反向依赖
 * 项目外 `pipeline`),`server/utils/jobs/reconcile.ts` 只是它的入口 —— 同样**只换实现**:
 * 这一次注册表本身也只改了这两行 import 与一个 `registerJob`。
 */

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
