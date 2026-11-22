import { readMcpToken, resolveMcpAuth } from '../../../core/server/utils/mcp-auth'
import { dispatchPostgresAnnualTaskMcp } from './annual-correspondence-runtime'
import type { AnnualTaskAction, AnnualRuntimeContext } from './annual-correspondence-api'

export async function annualTaskMcpRequest(
  action: AnnualTaskAction,
  args: Record<string, unknown>,
  extra: { requestInfo?: { headers: Record<string, string | string[] | undefined> } },
  context: AnnualRuntimeContext & { mcpToken?: string },
) {
  const header = (name: string) => {
    const value = extra.requestInfo?.headers[name]
    return Array.isArray(value) ? value[0] : value
  }
  const authorized = resolveMcpAuth({
    given: readMcpToken({ authorization: header('authorization'), 'x-mcp-token': header('x-mcp-token') }),
    configured: context.mcpToken,
  }).writeAuthorized
  return dispatchPostgresAnnualTaskMcp(action, args, {
    ...context, authorized,
  })
}
