/**
 * 查询串里**多值参数**的解析规则 —— 纯函数,可单测。
 *
 * 口径(与 `/api/records`、`/api/files`、`/api/export` 现有三处一致):
 *
 *   - `title=a,b`(**逗号分隔**)与 `title=a&title=b`(**重复参数**)都认;
 *   - 每项去掉两端空白,**空项剔除**;
 *   - 一项都不剩(或压根没给)返回 `undefined` —— 「没筛」与「筛了个空的」是两回事,
 *     后者在调用方那里会变成「命中 0 条」,那是错的。
 *
 * ── 为什么现在才抽出来 ──────────────────────────────────────────────────
 * 这段逻辑在仓库里已经被**照抄四遍**(见上面那四条路由)。原先不抽是**有意的**:
 * 抽它要动那四张票的文件,而那些票当时各有会话在跑(见 `server/utils/pdf-pages.ts`
 * 的 `sha256Of` 与 `layers/sme-roster/lib/stored-file.ts` 里同样的说明)。本票要写第**五**个消费点时,
 * 抽的代价才终于小于抄的代价 —— 于是有了这个文件。
 *
 * 现存四处**没有一起改**:它们不在本票的改动范围里(另一批会话在动文件域),
 * 顺手改会把两票的改动绞在一起。谁下次碰那四条路由,顺手换成本函数即可。
 */

/** 把查询参数值解析成字符串数组;没有有效项时返回 `undefined`。 */
export function parseCsvQuery(value: unknown): string[] | undefined {
  if (value == null) return undefined
  const raw = Array.isArray(value) ? value.flatMap((v) => String(v).split(',')) : String(value).split(',')
  const list = raw.map((s) => s.trim()).filter(Boolean)
  return list.length ? list : undefined
}
