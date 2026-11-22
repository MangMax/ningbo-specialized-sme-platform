import { handlePostgresEvidenceCorrectionWrite } from './roster-evidence-correction-write-postgres'

export async function dispatchEvidenceCorrectionMcp(action: 'preflight' | 'commit', args: Record<string, unknown>, context: { filesDir?: string; authorized?: boolean }) {
  const apiToken = 'mcp-internal-authorized'
  const output = await handlePostgresEvidenceCorrectionWrite({ action, method: 'POST', body: args,
    headers: context.authorized ? { authorization: 'Bearer ' + apiToken } : undefined,
  }, { filesDir: context.filesDir, apiToken })
  if (output.status !== 200) {
    const { error } = output.body as { error: { code: string; message: string } }
    throw Object.assign(new Error(error.message), { code: error.code, statusCode: output.status })
  }
  return output.body
}
