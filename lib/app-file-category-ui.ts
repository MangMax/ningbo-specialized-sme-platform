// Vue composition. Nitro consumes the server contributions separately.
import type { FileCategoryUi } from '../layers/core/lib/core/file-category-ui'
import { rosterFileCategoryUi } from './sme-roster/file-category-ui'

const categories: readonly FileCategoryUi[] = [rosterFileCategoryUi]

export function getFileCategoryUi(): readonly FileCategoryUi[] {
  return categories
}
