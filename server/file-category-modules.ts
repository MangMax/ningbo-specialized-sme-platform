// Application composition. Only server contributions are installed in Nitro.
import { rosterFileServerCategory } from './modules/sme-roster/files'

export const serverFileCategories = [rosterFileServerCategory] as const
