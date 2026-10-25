import { getHeader, getQuery, setHeader, setResponseStatus } from 'h3'
import { useDb } from '@db'
import { authorizeRosterWrite } from './roster-import-http'
import { ImportReceiptError, readImportReceipt, type ImportReceiptAction } from './import-receipts'

export function importReceiptRoute(action: ImportReceiptAction) {
  return defineEventHandler(event => {
    setHeader(event, 'cache-control', 'no-store')
    const auth = authorizeRosterWrite({ headers: { authorization: getHeader(event, 'authorization'), 'x-api-token': getHeader(event, 'x-api-token') } }, useRuntimeConfig().apiToken)
    if (!auth.ok) { setResponseStatus(event, 401); return { error: { code: 'unauthorized', message: 'Import receipts require the configured API token' } } }
    try { return readImportReceipt(useDb(), action, getQuery(event)) }
    catch (error) {
      if (!(error instanceof ImportReceiptError)) {
        if(getQuery(event).projection!==undefined) {setResponseStatus(event,500);return {error:{code:'internal_error',message:'Exact snapshot read failed'}}}
        throw error
      }
      setResponseStatus(event, error.statusCode)
      return { error: { code: error.code, message: error.message, ...(error.requiredBytes===undefined?{}:{requiredBytes:error.requiredBytes}) } }
    }
  })
}
