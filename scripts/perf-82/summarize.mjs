import { readFileSync, writeFileSync } from 'node:fs'
const [output, ...inputs] = process.argv.slice(2)
if (!output || !inputs.length) throw new Error('Usage: node summarize.mjs OUTPUT_JSON RUN_JSONL...')
const runs = inputs.map(path => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse))
const percentile = (values, q) => { const xs = values.filter(Number.isFinite).sort((a, b) => a - b); return xs[Math.max(0, Math.ceil(xs.length * q) - 1)] ?? null }
const quantiles = xs => ({ p50: percentile(xs, .5), p95: percentile(xs, .95), p99: percentile(xs, .99), max: percentile(xs, 1) })
const summaries = []
const publicSummaries = []
for (let i = 0; i < runs.length; i++) {
  const groups = new Map()
  for (const item of runs[i].filter(x => x.type === 'batch')) {
    const key = `${item.scenario}/${item.concurrency}/${item.phase}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  for (const [key, batches] of groups) {
    const responses = batches.flatMap(b => b.responses)
    const ok = responses.filter(r => r.status >= 200 && r.status < 300 && r.server)
    const summary = { input: inputs[i].split('/').pop(), key, samples: responses.length, successes: ok.length,
      statuses: responses.map(r => r.status ?? r.error), elapsedMs: quantiles(ok.map(r => r.elapsedMs)),
      errorElapsedMs: quantiles(responses.filter(r => r.error).map(r => r.elapsedMs)),
      elapsedIncludingHttpErrorsMs: quantiles(responses.filter(r => r.status).map(r => r.elapsedMs)),
      ttfbMs: quantiles(ok.map(r => r.ttfbMs)), receiveBodyMs: quantiles(ok.map(r => r.receiveBodyMs)),
      loopP95Ms: percentile(batches.map(b => b.loop?.p95Ms), 1), loopMaxMs: percentile(batches.map(b => b.loop?.maxMs), 1),
      heartbeatDriftMaxMs: percentile(batches.map(b => b.loop?.heartbeatDriftMaxMs), 1),
      lifetimeMaxRssKiB: percentile(batches.map(b => b.loop?.lifetimeMaxRssKiB), 1) }
    for (const metric of ['sqlMs', 'sqlCalls', 'sqlRows', 'sqlBytes', 'jsonParseMs', 'jsonParseCalls', 'jsonParseBytes', 'serializationMs', 'logicResidualMs', 'heapPeak', 'rssPeak']) summary[metric] = quantiles(ok.map(r => r.server[metric]))
    summary.heapDeltaBytes = quantiles(ok.map(r => r.server.heapPeak - r.server.heapStart))
    summary.responseBytes = quantiles(ok.map(r => r.responseBytes))
    summary.receiptWritten = quantiles(ok.map(r => r.receipt?.written))
    summary.preflightAdded = quantiles(ok.map(r => r.receipt?.added))
    summary.dbBytes = percentile(batches.map(b => b.dbBytes), 1)
    summary.walBytes = percentile(batches.map(b => b.walBytes), 1)
    summaries.push(summary)
  }
  const publicGroups = new Map()
  for (const item of runs[i].filter(x => x.type === 'public-batch')) {
    const key = `${item.lane}/${item.concurrency}/${item.phase}`
    if (!publicGroups.has(key)) publicGroups.set(key, [])
    publicGroups.get(key).push(item)
  }
  for (const [key, batches] of publicGroups) {
    const responses = batches.flatMap(b => b.responses)
    publicSummaries.push({ input: inputs[i].split('/').pop(), key, samples: responses.length,
      statuses: responses.map(r => r.status), rpcErrors: responses.filter(r => r.rpcError).length,
      elapsedMs: quantiles(responses.map(r => r.elapsedMs)), ttfbMs: quantiles(responses.map(r => r.ttfbMs)),
      receiveBodyMs: quantiles(responses.map(r => r.receiveBodyMs)), responseBytes: quantiles(responses.map(r => r.responseBytes)),
      returnedRows: quantiles(responses.map(r => r.returnedRows)), total: quantiles(responses.map(r => r.total)),
      noStoreAll: responses.every(r => r.noStore), heapAfterBytes: quantiles(batches.map(b => b.observation?.memory?.heapUsed)),
      lifetimeMaxRssKiB: percentile(batches.map(b => b.observation?.maxRssKiB), 1),
      loopMaxMs: percentile(batches.map(b => b.observation?.loop?.maxMs), 1),
      heartbeatDriftMaxMs: percentile(batches.map(b => b.observation?.loop?.heartbeatDriftMaxMs), 1) })
  }
}
const result = { method: 'nearest-rank observed quantiles; tiny n does not estimate population tails; no unfinished requests treated as successes',
  environments: runs.map(r => r.find(x => x.type === 'environment')), summaries, publicSummaries,
  failures: runs.flatMap((r, i) => r.filter(x => x.type === 'failure').map(x => ({ input: inputs[i].split('/').pop(), ...x }))) }
writeFileSync(output, `{\n"method":${JSON.stringify(result.method)},\n${['environments', 'summaries', 'publicSummaries', 'failures'].map(key => `"${key}":[\n${result[key].map(x => JSON.stringify(x)).join(',\n')}\n]`).join(',\n')}\n}\n`)
console.log(JSON.stringify({ output, groups: summaries.length, failures: runs.reduce((n, r) => n + r.filter(x => x.type === 'failure').length, 0) }))
