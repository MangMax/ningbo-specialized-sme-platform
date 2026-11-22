import { expect, it } from 'vitest'
import { decisionHistory102, internalDecisionCommand102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle/contract'
import {
  currentPostgresDecisions102, historyPostgresDecision102, readPostgresDecision102,
  readPostgresQualificationDecisionHeads,
} from '../../../layers/sme-roster/server/utils/decision-lifecycle/postgres-reads'
import { savePostgresDecision102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle/postgres-writes'

import { enterprise } from '../fixtures/postgres-tables'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'

const createDb = useIsolatedPostgresCases()

it('keeps withdrawn decision versions and original scope order in PostgreSQL', async () => {
  const db = createDb()
  await db.insert(enterprise).values({ id: 7, name: 'Synthetic enterprise', nameNorm: 'synthetic-enterprise' })
  const scope = { enterpriseId: 7, titleCode: 'specialized_sme', direction: 'missing_in_miit' } as const
  const empty = { ...scope, direction: 'extra_in_miit' } as const
  const command = internalDecisionCommand102.parse({
    ...scope, action: 'replace', expectedCurrentId: null, idempotencyKey: 'decision-create',
    actor: { type: 'agent', id: 'fixture-agent' }, basis: '已核对合成证据', ruleVersion: 'fixture-v1', effectiveAt: '2026-11-10T01:02:03Z',
    decision: { status: 'confirmed_no_diff', measureCode: 'none', verificationStatus: 'confirmed' },
  })
  const created = await savePostgresDecision102(db, command)
  const id = created.versionId as number
  expect(id).toBeTypeOf('number')
  expect(await savePostgresDecision102(db, command)).toEqual(created)
  expect(await currentPostgresDecisions102(db, [empty, scope, empty])).toEqual([
    { ...empty, versionId: null, current: null },
    { ...scope, versionId: id, current: expect.objectContaining({
      id, isCurrent: true, actor: command.actor, status: 'confirmed_no_diff',
      evidenceQueryId: null, evidenceRelationId: null,
    }) },
    { ...empty, versionId: null, current: null },
  ])
  const withdraw = internalDecisionCommand102.parse({
    ...command, action: 'withdraw', expectedCurrentId: id, idempotencyKey: 'decision-withdraw', decision: undefined,
  })
  const withdrawn = await savePostgresDecision102(db, withdraw)
  expect(withdrawn).toMatchObject({ action: 'withdraw', previousId: id, currentId: null })
  expect(await currentPostgresDecisions102(db, [scope])).toEqual([{ ...scope, versionId: withdrawn.versionId, current: null }])
  expect(await readPostgresQualificationDecisionHeads(db, 7, ['specialized_sme'])).toEqual([
    expect.objectContaining({ id: withdrawn.versionId, lifecycleAction: 'withdraw' }),
  ])
  expect(await readPostgresDecision102(db, id)).toMatchObject({ id, isCurrent: false })
  expect(await historyPostgresDecision102(db, decisionHistory102.parse({ id, page: 1, pageSize: 1 }))).toMatchObject({
    total: 2, page: 1, pageSize: 1, rows: [{ id: withdrawn.versionId, isCurrent: true, lifecycleAction: 'withdraw' }],
  })
}, 20_000)
