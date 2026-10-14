import { createError } from 'h3'

/**
 * OCR 结果的读写(**尚未启用**)—— 票 18 的 `get_ocr_result` / `save_ocr_result` 的落点。
 *
 * ── 为什么是空的 ────────────────────────────────────────────────────────
 * OCR 结果表属于**票 14**(`.scratch/ingest-pipeline/issues/14-ocr.md`),那张票还没做:
 * `db/schema.ts` 里没有 `ocr_result`,迁移里也没有。按票 18 的要求,这两个 tool 现在就
 * **留成明确报「尚未启用」**,而不是现造一张表 —— 现造的话,表结构(页码怎么挂?一段多页?
 * 一次识别多条通路怎么写?)会先于票 14 的设计定死,把那张票的选型提前锁进仓库。
 *
 * ── 为什么单独成文件而不是在 tool 里各写一段 ────────────────────────────
 * 票 14 落地时,要改的是**这里**(把真实读写写进这个模块),两个 tool 文件只是调用方,
 * 一行都不用动。顺带也保证两个 tool 报的是**同一句话**,不会文案漂移。
 *
 * ── 已经确定的口径(票 14 可参考,不是本票的承诺)──────────────────────
 * OCR 结果按 `(文件, 页码)` 挂,`page_no` 是权威(见票 13 的 `stored_page_image`/页图清单,
 * 页号从 1 连续);导出 markdown 时带页码。这三条写进 SPEC 了,票 14 直接按它做即可。
 */

/** 尚未存在的表名。票 14 建表后把这里和下面的函数一起换掉。 */
export const OCR_RESULT_TABLE = 'ocr_result'

/** 一句话说明为什么不可用 —— 两个 tool 用同一份,免得文案漂移。 */
export const OCR_DISABLED_MESSAGE =
  `OCR 结果尚未启用:票 14(OCR 三通路 + 结果入库)未实现,表 \`${OCR_RESULT_TABLE}\` 还不存在。` +
  '这不是本 tool 的临时缺陷,而是本票有意留的空位 —— 等票 14 建表后原样接上。' +
  '在那之前,页图可以用 list_page_images 取(票 13 已可用)。'

/**
 * 统一的「尚未启用」错误。
 *
 * 用 **501 Not Implemented** 而不是 404/400:这个能力**存在**(tool 出现在 `tools/list` 里,
 * 这是票 18 要求的「明确报」),只是还没做 —— 501 正是这个语义,客户端也不必把它当成
 * 「你参数给错了」去反复改参数重试。
 */
export function ocrNotEnabledError(): ReturnType<typeof createError> {
  return createError({ statusCode: 501, message: OCR_DISABLED_MESSAGE })
}
