import type { FileCategoryUi } from '../layers/core/lib/core/file-category-ui'

let categories: readonly FileCategoryUi[] = []

export function installFileCategoryUi(contributions: readonly FileCategoryUi[]): void {
  categories = contributions
}

export function getFileCategoryUi(): readonly FileCategoryUi[] {
  return categories
}
