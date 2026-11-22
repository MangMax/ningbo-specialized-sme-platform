import { credentialContext, resolveCredential } from '../../../core/server/utils/credential-state'
import { validateReceiptRuntimeContext, type ReceiptRuntimeContext } from './receipt-runtime-context'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
type Db = BetterSQLite3Database<typeof schema>
import { receiptRedactor, type ReceiptRedactor, type RedactionOptions } from './import-receipt-redaction'

export function importReceiptRedactor(db: Db, options: RedactionOptions = {}, receiptRuntime?: ReceiptRuntimeContext): ReceiptRedactor {
  const runtime = receiptRuntime === undefined ? (typeof useRuntimeConfig === 'function' ? useRuntimeConfig() : undefined) : validateReceiptRuntimeContext(receiptRuntime)
  const context = receiptRuntime === undefined ? { ...credentialContext(), db } : { db, ocrToken: runtime?.ocrToken }
  const secrets = [...(options.additionalSecrets ?? []), runtime?.apiToken, runtime?.mcpToken, process.env.NUXT_API_TOKEN, process.env.NUXT_MCP_TOKEN, resolveCredential('sme-roster.miitCookie', context).value, resolveCredential('core.ocrToken', context).value]
  return receiptRedactor(secrets)
}
