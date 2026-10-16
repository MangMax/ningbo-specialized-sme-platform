/**
 * 平台适配层共用的**基础类型**。
 *
 * `PlatformRow` / `PlatformRdjb` 定义在 `adapter.ts`(解析器产出它们),这里只做一次转出;
 * 平台接口的**取值与联合类型**定义在 `lib/labels.ts`(契约 §2.4 的枚举表所在处),这里同样转出
 * —— 于是 `identity.ts` / `payload.ts` / `client.ts` / `read.ts` 只从这一个模块取类型,
 * 谁都不再自己拼一遍。
 */
import { PLATFORM_INTERFACE_VALUES, type PlatformInterface } from '../labels'

export type { PlatformRow, PlatformRdjb, PlatformListResult } from './adapter'
export { PLATFORM_INTERFACE_VALUES, type PlatformInterface }

/** 一次查询的身份:`哪个接口` × `查询键` × `rdjb`(契约 §1.3 的唯一键前缀)。 */
export interface PlatformQueryMeta {
  interface: PlatformInterface
  /** `business_list` 的 rdjb;`apply_list` 留空。 */
  rdjb?: string
  /** 查询键:统一社会信用代码,或 `name:<nameNorm>`(与 `lib/reconcile.ts` 同构)。 */
  queryKey: string
}
