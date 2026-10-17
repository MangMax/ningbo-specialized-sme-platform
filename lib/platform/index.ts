/**
 * 平台接口适配层(RL-03)的公开入口。
 *
 * - {@link ./adapter}:纯解析 + 四态归类(可离线单测);
 * - {@link ./client}:可注入 fetch 的薄客户端,`rdjb=1/2/3` 全查;
 * - {@link ./identity}:关系分组与曾用名候选(**只呈现证据,不推测**);
 * - {@link ./payload}:契约 §8.3 的写入载荷构造(类型直接用 RL-11 的
 *   `lib/roster-import-client.ts`,不另定义一套);
 * - {@link ./reconcile}:差异原因与后置动作的**判定引擎**(纯函数、只依显式证据);
 * - {@link ./read}:`GET /api/platform/queries` 的读模型。
 *
 * **提交**走 RL-11 的统一客户端(`createRosterImportClient`,契约 §8)——
 * 本模块不自带写客户端(那是同一条路的第二份实现)。
 */
export * from './adapter'
export * from './client'
export * from './identity'
export * from './payload'
export * from './reconcile'
export type { PlatformQueryMeta } from './types'
