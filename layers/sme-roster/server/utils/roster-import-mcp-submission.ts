import { appLog } from '../../../core/lib/logging'
import { rosterImportMcpContext } from './roster-import-mcp-context'
import { logImportFailure } from './roster-import-logging'
import { asyncImportReceiptMcpResult } from './import-receipt-model'
import { validateNativeImportRequest } from './roster-import-model'
import { runPostgresMixedImport } from './roster-mixed-import-postgres'

/** The two import tools share only submission. Schemas and authorization stay on the tools. */
export function submitRosterImportMcp(action: 'preflight' | 'commit', input: {
  idempotencyKey: string; sourceKind: 'announcement' | 'platform_export' | 'platform_archive' | 'alias_evidence'
  sourceIdentity: string; sourceSha256?: string; payload: Record<string, unknown>
}) {
  const context = rosterImportMcpContext.getStore() ?? {}
  return asyncImportReceiptMcpResult(async () => {
    const validated = validateNativeImportRequest({
      idempotencyKey: input.idempotencyKey,
      sourceKind: input.sourceKind,
      sourceIdentity: input.sourceIdentity,
      sourceSha256: input.sourceSha256 ?? null,
      payload: input.payload,
    })
    if (!validated.ok) {
      appLog({ module: 'sme-roster', source: 'import', operation: `import.submission.${action}`, outcome: 'denied', errorCode: 'invalid_import_request' }, context)
      throw createError({ statusCode: validated.status, message: validated.message })
    }
    try {
      return await runPostgresMixedImport(action, validated.value, useRuntimeConfig().filesDir, context)
    } catch (error) {
      logImportFailure(`import.submission.${action}`, error, context)
      throw error
    }
  })
}
