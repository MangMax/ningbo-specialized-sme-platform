/** Complete typed exclusion fixture through the same preflight/commit contract as users. */
export async function confirmCurrentExportExclusion(baseUrl: string, headers: Record<string,string>, enterpriseId: number, key: string, kind: 'moved_out'|'cancelled' = 'moved_out') {
  const root = `${baseUrl}/api/roster/enterprises/${enterpriseId}/facts`
  const read = await fetch(root, { headers })
  if (read.status !== 200) throw new Error('typed exclusion fixture read failed: ' + read.status)
  let version = (await read.json()).version
  async function commit(change: object, suffix: string) {
    const request = { expectedVersion: version, idempotencyKey: `${key}-${suffix}`, actor: { type: 'agent', id: 'synthetic-export' }, basis: '合成正式通知逐项核实', ...change }
    const preflight = await fetch(root+'/preflight', {method:'POST',headers,body:JSON.stringify(request)})
    if (preflight.status !== 200) throw new Error('typed exclusion fixture preflight failed: ' + preflight.status)
    const plan = await preflight.json()
    const response = await fetch(root+'/commit', {method:'POST',headers,body:JSON.stringify({request,planHash:plan.planHash})})
    if (response.status !== 200) throw new Error('typed exclusion fixture commit failed: ' + response.status)
    const result = await response.json()
    const updated = await fetch(root, {headers})
    if (updated.status !== 200) throw new Error('typed exclusion fixture readback failed: ' + updated.status)
    version = (await updated.json()).version
    return result
  }
  const asserted = await commit({action:'assert',fact:{kind,source:{reference:'synthetic:export:'+key,statement:kind === 'moved_out' ? '正式通知明确迁出宁波' : '正式通知明确注销'},observed:{precision:'day',value:'2026-01-01'},effective:{precision:'day',value:'2025-01-01'},...(kind === 'moved_out' ? {city:null} : {})}},'assert')
  await commit({action:'confirm',factId:asserted.factId},'confirm')
  return asserted.factId as number
}
