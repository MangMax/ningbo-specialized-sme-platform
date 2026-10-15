/**
 * 平台接口适配层(RL-03)的公开入口。
 *
 * - {@link ./adapter}:纯解析 + 四态归类(可离线单测);
 * - {@link ./client}:可注入 fetch 的薄客户端,`rdjb=1/2/3` 全查;
 * - {@link ./identity}:关系分组与曾用名候选(**只呈现证据,不推测**);
 * - {@link ./payload}:契约 §8.3 的统一写入载荷构造;
 * - {@link ./write}:经统一 API 提交(不直写 SQL);
 * - {@link ./read}:`GET /api/platform/queries` 的读模型。
 */
export * from './adapter'
export * from './client'
export * from './identity'
export * from './payload'
export type { PlatformQueryMeta } from './types'
