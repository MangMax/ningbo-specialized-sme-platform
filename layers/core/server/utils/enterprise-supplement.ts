import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { EnterpriseSource, ReviewedSubject } from './enterprise-contract'
import { EnterpriseKernelError } from './enterprise-contract'
import {
  attachReviewedEnterprise, createReviewedEnterprise, lockReviewedEnterpriseBatch, registerEnterpriseSource,
} from './enterprise-directory-postgres-write'

type Transaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

/**
 * 手动单向补充的**命名契约**（见 ADR 2026-11-18「手动单向补充」）：在发起方事务内按行
 * 完成身份锁定、新建/附着企业与资料字段显式修订，并在全部行落定后登记来源关联。
 *
 * 模块各自的业务行记账、来源事实整理与流程编排仍归模块；契约只管「进入企业基础库」
 * 这段共享序列。两行之间的差异通过显式参数表达，不允许隐式改变任何一方的行为：
 *
 * - `lock`：进入逐行处理前一次性取齐的身份锁。`enterpriseIds` 为需要行锁的企业
 *   （含已落定行的既有归属），`fields` 为本次新建/修订涉及的名称与统代。
 * - `subjects`：核对后的逐行决定。`create`/`attach` 由内核原语直接执行；
 *   `attach` 必须携带审计上下文（幂等键、请求哈希、操作者、依据）。
 * - `source`：可选的来源登记输入。全部行解析完成后，以全部归属企业 ID（按行序去重）
 *   一次性登记 enterprise_source 与 enterprise_source_link。
 * - `hooks`：模块特有且必须保持在逐行序列原位的步骤——
 *   `beforeResolve` 在每行解析前（如附着目标的来源身份预核），
 *   `resolve` 处理契约外的行类型（如引用前一行结果的 same_subject 或幂等重放行），
 *   `afterResolve` 在每行归属确定后（如模块业务行回写、来源身份复核）。
 */
export interface ReviewedSupplementHooks<S extends { action: string }> {
  beforeResolve?(tx: Transaction, subject: S, index: number): Promise<void>
  resolve?(tx: Transaction, subject: S, index: number, owners: ReadonlyMap<number, number>): Promise<number | undefined>
  afterResolve?(tx: Transaction, subject: S, index: number, owner: number): Promise<void>
}

export interface ReviewedSupplementInput<S extends { action: string }> {
  lock?: { enterpriseIds?: readonly number[]; fields?: readonly { name?: string; uscc?: string | null }[] }
  subjects: readonly S[]
  hooks?: ReviewedSupplementHooks<S>
  source?: EnterpriseSource
}

export async function applyReviewedEnterpriseSupplement<S extends { action: string }>(
  tx: Transaction, input: ReviewedSupplementInput<S>,
) {
  if (input.lock) await lockReviewedEnterpriseBatch(tx, input.lock.enterpriseIds ?? [], input.lock.fields ?? [])
  const owners = new Map<number, number>()
  const created = new Set<number>()
  for (const [index, subject] of input.subjects.entries()) {
    await input.hooks?.beforeResolve?.(tx, subject, index)
    let owner = await input.hooks?.resolve?.(tx, subject, index, owners)
    if (owner === undefined) {
      const reviewed = subject as unknown as ReviewedSubject
      if (reviewed.action === 'create') {
        owner = await createReviewedEnterprise(tx, reviewed.fields)
        created.add(owner)
      } else if (reviewed.action === 'attach') {
        owner = (await attachReviewedEnterprise(tx, reviewed)).id
      } else {
        throw new EnterpriseKernelError(422, 'invalid_subject_action', 'A reviewed supplement row must create or attach an enterprise')
      }
    }
    owners.set(index, owner)
    await input.hooks?.afterResolve?.(tx, subject, index, owner)
  }
  const sourceId = input.source === undefined ? null
    : await registerEnterpriseSource(tx, input.source, [...new Set(owners.values())])
  return { owners, created, sourceId }
}
