import { handleRecordCorrespondenceRequest, type CorrespondenceAction } from './record-correspondence-api'
import { dispatchRecordCorrespondenceMcp as dispatch } from './mcp-record-correspondence'

export function dispatchRecordCorrespondenceMcp(action: CorrespondenceAction, args: Record<string, unknown>, context: { db: Parameters<typeof handleRecordCorrespondenceRequest>[1]['db']; authorized?: boolean }) {
  return dispatch(action, args, context, (input, apiToken) => handleRecordCorrespondenceRequest(input, { db: context.db, apiToken }))
}
