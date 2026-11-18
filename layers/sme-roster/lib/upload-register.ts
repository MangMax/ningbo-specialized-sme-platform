import type { UploadMetadata } from './upload'

/**
 * 上传面板与「登记进库」之间的**契约**。
 *
 * 面板(`layers/sme-roster/app/components/upload/UploadPanel.vue`)只负责传字节;传完之后由**外面的容器**
 * 决定怎么登记。两者之间传的就是这里定义的 `UploadedFile` —— 一处定义、两边引用,
 * 加一个字段不会各改一份。
 *
 * `meta` 是**发出请求那一刻的快照**,不是「当下的表单值」:同一批文件可以边传边改
 * 落位信息,回读表单会把 B 文件的声明按到 A 文件的登记上(票 10 的一个静默出错点)。
 */

/** 一份**已经传完**的文件。 */
export interface UploadedFile {
  /** 原文件名(含扩展名)。 */
  name: string
  /** 库内相对路径,取自 tus 响应头 `X-Upload-Path`(**服务端算的**,不重推)。 */
  relPath: string
  size: number
  /** 这次请求实际声明的落位信息(发出瞬间的快照)。 */
  meta: UploadMetadata
}

/** 一个文本字段:`null` / 空串 / 纯空白一律当「没填」。 */
export function blankToNull(value: string | null | undefined): string | null {
  const v = (value ?? '').trim()
  return v === '' ? null : v
}

/**
 * 登记请求体:把 `UploadedFile` 摊成 `/api/files/register` 收的那五个键。
 * **只有声明** —— 磁盘事实(大小 / 哈希)由服务端从盘上读。
 */
export function toRegisterBody(file: UploadedFile): {
  relPath: string
  source: string | null
  kind: string | null
  year: string | null
  batch: string | null
} {
  return {
    relPath: file.relPath,
    source: blankToNull(file.meta.source),
    kind: blankToNull(file.meta.kind),
    year: blankToNull(file.meta.year),
    batch: blankToNull(file.meta.batch),
  }
}
