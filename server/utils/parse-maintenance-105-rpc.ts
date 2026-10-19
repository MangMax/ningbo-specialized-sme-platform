import { parseHistory105, parseRead105, parseSave105 } from './parse-maintenance-105'
/** Validate original arguments before the toolkit strips unknown fields. */
export function parseRpcError105(body: unknown): Response | null {
  for (const entry of Array.isArray(body) ? body : [body]) {
    if (!entry || typeof entry !== 'object' || entry.method !== 'tools/call') continue
    const contracts = { save_parse_result: parseSave105, get_file_parse_result: parseRead105, get_file_parse_history: parseHistory105 }
    const name = entry.params?.name
    if (!Object.hasOwn(contracts, name ?? '')) continue
    if (!contracts[name as keyof typeof contracts].safeParse(entry.params?.arguments).success) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: entry.id ?? null, error: { code: -32602, message: 'Invalid or unsupported parse-result parameters' } }), { status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    }
  }
  return null
}
