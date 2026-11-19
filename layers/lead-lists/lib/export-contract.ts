import { z } from 'zod'
import { leadListId } from './contracts'

export const LEAD_LIST_EXPORT = 'lead-lists-version-export'
export const leadListExportInput = z.strictObject({ versionId: leadListId, clientRequestId: z.uuid() })
