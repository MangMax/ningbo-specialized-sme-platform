/**
 * 平台适配层共用的**基础类型**。
 *
 * `PlatformRow` / `PlatformRdjb` 定义在 `adapter.ts`(解析器产出它们),这里只做一次转出,
 * 免得 `identity.ts` / `payload.ts` 各自再定义一遍。
 *
 * ⚠️ 平台接口的取值与联合类型(`PlatformInterface` / `PLATFORM_INTERFACE_VALUES`)**不在
 * 这里转出** —— 它们的唯一出处是 `layers/sme-roster/lib/labels.ts` 的枚举表(契约 §2.4),平台层内外一律
 * 直接 import 那里。少一层转出,就少一个「从哪儿取」的分叉。
 */
import type { PlatformInterface } from '../labels'

export type { PlatformRow, PlatformRawRow, PlatformJsonValue, PlatformRdjb, PlatformListResult } from './adapter'

/** 一次查询的身份:`哪个接口` × `查询键` × `rdjb`(契约 §1.3 的唯一键前缀)。 */
export interface PlatformQueryMeta {
  interface: PlatformInterface
  /** `business_list` 的 rdjb;`apply_list` 留空。 */
  rdjb?: string
  /** 查询键:统一社会信用代码,或 `name:<nameNorm>`。 */
  queryKey: string
}
