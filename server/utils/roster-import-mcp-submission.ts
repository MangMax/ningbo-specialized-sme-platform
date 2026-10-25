import { useDb } from '@db'
import { appLog } from '../../lib/logging'
import { rosterImportMcpContext } from './roster-import-mcp-context'
import { logImportFailure } from './roster-import-logging'
import { importExecutor } from './import-execution'
import { asyncImportReceiptMcpResult } from './import-receipts'
import { validateImportRequest } from './roster-import'
import { validateRosterImportPageCounts } from './roster-import-page-validation'

/** The two import tools share only submission. Schemas and authorization stay on the tools. */
export function submitRosterImportMcp(action: 'preflight' | 'commit', input: {
  idempotencyKey: string; sourceKind: 'announcement' | 'platform_export' | 'platform_archive' | 'alias_evidence'
  sourceIdentity: string; sourceSha256?: string; payload: Record<string, unknown>
}) {
  const context = rosterImportMcpContext.getStore() ?? {}
  return asyncImportReceiptMcpResult(async () => {
    const validated = validateImportRequest({
      idempotencyKey: input.idempotencyKey,
      sourceKind: input.sourceKind,
      sourceIdentity: input.sourceIdentity,
      sourceSha256: input.sourceSha256 ?? null,
      payload: input.payload,
    })
    if (!validated.ok) {
      appLog({ source: 'import', operation: `import.submission.${action}`, outcome: 'denied', errorCode: 'invalid_import_request' }, context)
      throw createError({ statusCode: validated.status, message: validated.message })
    }
    try {
      const pageCountErrors = await validateRosterImportPageCounts(validated.value, useRuntimeConfig().filesDir)
      return await importExecutor.execute(useDb(), action, validated.value, pageCountErrors, context, { filesDir: useRuntimeConfig().filesDir })
    } catch (error) {
      logImportFailure(`import.submission.${action}`, error, context)
      throw error
    }
  })
}
