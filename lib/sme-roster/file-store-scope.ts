/** 入库范围的唯一可执行规则。按库内相对路径及同目录兄弟名排除通知、入库培育和重复转换件。 */

import { baseName, extensionOf } from '../core/file-path'

/** 入库范围判定的**原因码**。`in-scope` 是唯一「入库」的取值。 */
export type StoreScopeReason =
  /** 在范围内 —— 入库。 */
  | 'in-scope'
  /** 文件名含「入库培育」:是**培育对象**,不构成称号 ⇒ 不入库。 */
  | 'nurture'
  /** `.doc` 且同目录有同名 `.docx`:重复的旧版二进制件,只保留**可预览的** `.docx`。 */
  | 'duplicate-doc'
  /** `.docx` 且同目录有同名 `.pdf`:人工 OCR 产物,PDF 才是权威原件且可内联预览。 */
  | 'human-ocr-docx'

/** 不入库判定的中文说明(逐条),给回填报告与验收输出直接用。 */
const DETAIL: Record<StoreScopeReason, string> = {
  'in-scope': '在入库范围内',
  nurture: '文件名含「入库培育」—— 培育对象不构成称号,按 lib/file-store-scope.ts 排除',
  'duplicate-doc': '同目录已有同名 .docx(可预览的转出件)—— 重复的旧版 .doc 不入库',
  'human-ocr-docx': '同目录已有同名 .pdf —— 该 .docx 是人工 OCR 产物,PDF 才是权威原件',
}

/** 判定结果。**判别联合**:`inScope` 判得动,`reason` 才收窄得到 —— 调用方不必做类型断言。 */
export type StoreScopeVerdict =
  | { inScope: true; reason: 'in-scope'; detail: string }
  | { inScope: false; reason: Exclude<StoreScopeReason, 'in-scope'>; detail: string }

/** 排除 **入库培育** 文件的关键词。与 `pipeline/src/files.ts` 的判据、`本模块同字面量。 */
export const NURTURE_KEYWORD = '入库培育'

/** 一份排除判定。 */
function exclude(reason: Exclude<StoreScopeReason, 'in-scope'>): StoreScopeVerdict {
  return { inScope: false, reason, detail: DETAIL[reason] }
}

/** 文件名去掉扩展名(保留点之前的全部内容,含中文书名号与文号)。 */
function stemOf(filename: string): string {
  const ext = extensionOf(filename)
  return ext === '' ? filename : filename.slice(0, filename.length - ext.length - 1)
}

/**
 * 判一份文件该不该进文件库。
 *
 * @param relPath 库内相对路径(`/` 分隔,与 `stored_file.rel_path` 同口径)。
 * @param siblings **同目录**下的全部文件名(含本文件自己)。缺省当成空集合 —— 此时
 *   「同名兄弟」两条判据自然不成立,即**没有兄弟就不算重复**,与语义一致。
 */
export function scopeOf(relPath: string, siblings?: ReadonlySet<string>): StoreScopeVerdict {
  const filename = baseName(relPath)

  // 1. 入库培育:文件名判据,与 pipeline / README 同一条(来源侧与库内都能判,故两处都留)。
  if (filename.includes(NURTURE_KEYWORD)) return exclude('nurture')

  const ext = extensionOf(filename)
  if (ext !== 'doc' && ext !== 'docx') return { inScope: true, reason: 'in-scope', detail: DETAIL['in-scope'] }

  const stem = stemOf(filename)
  // 2. 旧版二进制 `.doc` 与转出件并存 ⇒ 只留可预览的 `.docx`(用户 2026-10-16 口径)。
  if (ext === 'doc' && siblings?.has(`${stem}.docx`)) return exclude('duplicate-doc')
  // 3. `.docx` 与 PDF 同名 ⇒ 人工 OCR 产物;PDF 可内联预览且是权威原件。
  if (ext === 'docx' && siblings?.has(`${stem}.pdf`)) return exclude('human-ocr-docx')

  return { inScope: true, reason: 'in-scope', detail: DETAIL['in-scope'] }
}
