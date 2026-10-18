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
export async function collectBatch({ baseUrl, batchId, maxPolls = 480, pollIntervalMs = 250 }) {
  for (let count = 0; count < maxPolls; count++) {
    const batch = await appJson(baseUrl, `/api/platform/batches/${encodeURIComponent(batchId)}`)
    if (!['queued', 'running'].includes(batch.state)) {
      // Route by stable ID, never by a platform row's name/code or output order.
      const items = await Promise.all(batch.itemIds.map(itemId => appJson(baseUrl, `/api/platform/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}`)))
      return { ...batch, items }
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  return { batchId, state: 'poll_limit', completeness: 'partial', items: [] }
}
export async function investigatePlatform({ baseUrl, apiToken, queries, limits, ...polling }) {
  await appJson(baseUrl, '/api/platform/capabilities')
  const receipt = await appJson(baseUrl, '/api/platform/batches', { method: 'POST', apiToken, body: { items: queries.map(query => ({ query })), ...(limits ? { limits } : {}) } })
  return collectBatch({ baseUrl, batchId: receipt.batchId, ...polling })
}
export async function retryUnfinishedBatch({ baseUrl, apiToken, batch, itemIds, ...polling }) {
  const selected = batch.items.filter(item => item.completeness !== 'complete' && (!itemIds || itemIds.includes(item.itemId))).map(item => item.itemId)
  if (!selected.length) return batch
  // An expired session needs server-side maintenance before this explicit action.
  await appJson(baseUrl, `/api/platform/batches/${encodeURIComponent(batch.batchId)}/retry`, { method: 'POST', apiToken, body: { itemIds: selected } })
  return collectBatch({ baseUrl, batchId: batch.batchId, ...polling })
}
