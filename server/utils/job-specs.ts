import { getJobSpec, registerJob, type JobSpec } from './job-runner'
import { renderPagesSpec } from './jobs/render-pages'

/**
 * **任务种类注册表** —— 本票的扩展点。
 *
 * 加一个新 kind 只需两步:写一个 `JobSpec`(参数校验 + run),在这里登记一行。
 * 路由、鉴权、队列、进度、取消、持久化**都不用改** —— 那些是执行面的事
 * (见 `server/utils/job-runner.ts`),与具体做什么无关。
 *
 * ── 为什么 `ocr` / `reconcile` 也登记进来,哪怕还没接 ─────────────────────
 * 它们是**已知要去的地方**,不是不存在的 kind。登记成 `todo` 有两个好处:
 *  1. 代理提交它们会拿到一句明确的 **501 + 「还没接、接在哪张票上」**,
 *     而不是含混的 400「未知 kind」—— 后者会让代理以为是自己拼错了名字;
 *  2. `GET /api/jobs/kinds`(见 `server/api/jobs/kinds.get.ts`)能把整张表报出来,
 *     代理据此知道「现在能派什么活」,不用猜。
 * 不登记(直接当未知)也不是错,但那样「还没接」与「没这个东西」就分不出来了。
 */

/**
 * OCR 批量识别。
 *
 * 没接的原因很具体:**结果无处可放**。票 14 的 OCR 结果要按 `page_no` 落到
 * OCR 结果表上(`server/utils/ocr-result.ts` 现在是「尚未启用」的占位,见票 18),
 * 表还没建,任务跑完没有落点是比不跑更坏的结果。等票 14 的表落地后,这里补一个
 * `run` 即可 —— `parse` / `total` 的形状可以先按「批量:文件路径数组」设想。
 */
const ocrSpec: JobSpec = {
  kind: 'ocr',
  status: 'todo',
  summary: '批量 OCR(走 PaddleOCR API,结果按页码入库)',
  note: '尚未接入:等票 14 的 OCR 结果表(server/utils/ocr-result.ts 现为占位)。',
  // 未接入的 kind 不会被调用到 parse(路由先按 status 返回 501),给个透传占位。
  parse: (raw) => ({ ok: true, params: raw }),
}

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
