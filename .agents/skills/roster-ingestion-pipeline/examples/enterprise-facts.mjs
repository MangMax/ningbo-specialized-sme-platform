/** Bounded MCP examples. `call(name, args)` must reject transport/tool errors and
 * return the decoded tool result. Each invocation is an explicit caller action.
 * Keep prepared commands and receipts outside Git before sending a write. */
export async function prepareFactCommand(call, { enterpriseId, ...command }) {
  const before = await call('get_enterprise_facts', { enterpriseId })
  const request = structuredClone({ ...command, expectedVersion: before.version })
  const plan = await call('preflight_enterprise_fact', { enterpriseId, request })
  return structuredClone({ enterpriseId, request, planHash: plan.planHash })
}

export async function commitPreparedFact(call, prepared) {
  const { enterpriseId, request, planHash } = structuredClone(prepared)
  const receipt = await call('commit_enterprise_fact', { enterpriseId, request: { request, planHash } })
  const readback = await call('get_enterprise_facts', { enterpriseId })
  if (!readback.facts.some(row => row.factId === receipt.factId)) throw new Error('Fact receipt missing from readback')
  // A concurrent later command or replay can legitimately move the current version.
  // The complete history remains available for independent source/audit checking.
  return { receipt, readback, currentVersionMatchesReceipt: readback.version === receipt.version }
}

export function confirmedFactReferences(readback, factIds) {
  if (new Set(factIds).size !== factIds.length) throw new Error('Duplicate fact selection')
  return factIds.map(factId => {
    const row = readback.facts.find(f => f.factId === factId)
    if (!row || row.status !== 'confirmed') throw new Error('Selected fact must be currently confirmed')
    return { enterpriseId: readback.enterpriseId, factId, revision: row.revision, kind: row.fact.kind }
  })
}

export async function saveReferencedDecision(call, command) {
  // The caller supplies the exact current decision ID, explicit business judgment
  // and pins reviewed together. Never refresh a stale pin during a retry.
  const request = structuredClone(command)
  const receipt = await call('save_difference_decision', request)
  const version = await call('get_difference_decision', { id: receipt.versionId })
  if (JSON.stringify(version.factReferences ?? []) !== JSON.stringify(request.decision?.factReferences ?? [])) {
    throw new Error('Decision fact pins differ from submitted pins')
  }
  return { receipt, version }
}
