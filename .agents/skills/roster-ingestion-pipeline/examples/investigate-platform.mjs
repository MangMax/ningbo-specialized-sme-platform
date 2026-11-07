/** App-only investigation workflow. Callers supply queries and app task authorization;
 * platform credentials are resolved by the server and are never read by this agent. */
async function appJson(baseUrl, path, { method = 'GET', body, apiToken } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method, cache: 'no-store', headers: { 'content-type': 'application/json', ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`App request failed (${response.status})`)
  return response.json()
}
export async function querySingle({ baseUrl, query }) {
  return appJson(baseUrl, '/api/platform/query', { method: 'POST', body: query })
}
function validateCheckpoint(batchId, checkpoint = {}) {
  const pending = [checkpoint]
  const visited = new Set()
  while (pending.length) {
    const current = pending.pop()
    if (!current || visited.has(current)) continue
    visited.add(current)
    for (const observation of [current.receipt, current.lastBatch, current.previousBatch]) {
      if (observation && observation.batchId !== batchId) throw new Error('Checkpoint batchId mismatch')
      if (observation?.checkpoint) pending.push(observation.checkpoint)
    }
  }
}
export async function collectBatch({ baseUrl, batchId, maxPolls = 480, pollIntervalMs = 250, checkpoint = {} }) {
  validateCheckpoint(batchId, checkpoint)
  const saved = { ...checkpoint, receipt: checkpoint.receipt ?? null, lastBatch: checkpoint.lastBatch ?? null }
  for (let count = 0; count < maxPolls; count++) {
    const batch = await appJson(baseUrl, `/api/platform/batches/${encodeURIComponent(batchId)}`)
    saved.lastBatch = batch
    if (!['queued', 'running'].includes(batch.state)) {
      // Route by stable ID, never by a platform row's name/code or output order.
      const items = await Promise.all(batch.itemIds.map(itemId => appJson(baseUrl, `/api/platform/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}`)))
      return { ...batch, items }
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  return { ...saved.lastBatch, batchId, itemIds: saved.lastBatch?.itemIds ?? saved.receipt?.itemIds ?? [],
    state: 'poll_limit', completeness: 'partial', serverState: saved.lastBatch?.state ?? saved.receipt?.state ?? null,
    items: saved.lastBatch?.items ?? [], checkpoint: saved }
}
export async function investigatePlatform({ baseUrl, apiToken, queries, limits, ...polling }) {
  await appJson(baseUrl, '/api/platform/capabilities')
  const receipt = await appJson(baseUrl, '/api/platform/batches', { method: 'POST', apiToken, body: { items: queries.map(query => ({ query })), ...(limits ? { limits } : {}) } })
  return collectBatch({ ...polling, baseUrl, batchId: receipt.batchId, checkpoint: { receipt, lastBatch: null } })
}
export async function retryUnfinishedBatch({ baseUrl, apiToken, batch, itemIds, ...polling }) {
  validateCheckpoint(batch.batchId, batch.checkpoint)
  if (['poll_limit', 'queued', 'running'].includes(batch.state)) {
    return collectBatch({ ...polling, baseUrl, batchId: batch.batchId, checkpoint: batch.checkpoint })
  }
  if (!['done', 'failed', 'cancelled'].includes(batch.state) || !Array.isArray(batch.items)
    || !Array.isArray(batch.itemIds) || batch.itemIds.some(id => !batch.items.some(item => item.itemId === id))
    || batch.items.some(item => !['complete', 'partial', 'not_queried'].includes(item.completeness))) {
    throw new Error('Retry requires terminal batch with item data')
  }
  const selected = batch.items.filter(item => item.completeness !== 'complete' && (!itemIds || itemIds.includes(item.itemId))).map(item => item.itemId)
  if (!selected.length) return batch
  // An expired session needs server-side maintenance before this explicit action.
  const receipt = await appJson(baseUrl, `/api/platform/batches/${encodeURIComponent(batch.batchId)}/retry`, { method: 'POST', apiToken, body: { itemIds: selected } })
  return collectBatch({ ...polling, baseUrl, batchId: batch.batchId, checkpoint: { receipt, lastBatch: null, previousBatch: batch } })
}
