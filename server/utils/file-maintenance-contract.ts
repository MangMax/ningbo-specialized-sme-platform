import { z } from 'zod'
export const fileMaintenanceControlShape = {
  expectedRevision: z.number().int().nonnegative().describe('从维护状态读取的修订。旧修订返回冲突。'),
  idempotencyKey: z.string().trim().min(1).max(200).describe('重试键。同键同请求不重复写入，同键异请求拒绝。'),
  actor: z.string().trim().min(1).max(200).describe('调用者声明的操作者。不是 token 推断的身份。'),
  basis: z.string().trim().min(1).max(2000).describe('维护依据。'),
}

/** Existing set_file_category accepts its exact old payload; any modern controls form one unit. */
export const legacyFileMaintenanceControlShape = {
  expectedRevision: fileMaintenanceControlShape.expectedRevision.optional(),
  idempotencyKey: fileMaintenanceControlShape.idempotencyKey.optional(),
  actor: fileMaintenanceControlShape.actor.optional(),
  basis: fileMaintenanceControlShape.basis.optional(),
}
