// Application composition. Only server contributions are installed in Nitro.
import { rosterFileServerCategory } from '../layers/sme-roster/server/modules/sme-roster/files'

export const serverFileCategories = [rosterFileServerCategory] as const
