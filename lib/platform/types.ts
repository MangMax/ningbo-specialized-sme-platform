/**
 * 平台适配层共用的**基础类型**。
 *
 * `PlatformRow` 定义在 `adapter.ts`(解析器产出它),这里只做一次转出 + 补上
 * 「哪次查询」的元信息,免得 `identity.ts` / `payload.ts` 各自再定义一遍。
 */
export type { PlatformRow, PlatformRdjb, PlatformListResult } from './adapter'

/** 一次查询的身份:`哪个接口` × `查询键` × `rdjb`(契约 §1.3 的唯一键前缀)。 */
export interface PlatformQueryMeta {
  interface: 'business_list' | 'apply_list'
  /** `business_list` 的 rdjb;`apply_list` 留空。 */
  rdjb?: string
  /** 查询键:统一社会信用代码,或 `name:<nameNorm>`(与 `lib/reconcile.ts` 同构)。 */
  queryKey: string
}
