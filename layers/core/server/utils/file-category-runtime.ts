import { createFileCategoryRules } from './file-category-rules'
import type { FileCategoryServer } from './file-store-contract'

export let serverFileCategories: readonly FileCategoryServer[] = []
export let postgresFileCategoryRules = createFileCategoryRules(serverFileCategories)

export function configurePostgresFileCategories(categories: readonly FileCategoryServer[]) {
  const rules = createFileCategoryRules(categories)
  serverFileCategories = categories
  postgresFileCategoryRules = rules
}
