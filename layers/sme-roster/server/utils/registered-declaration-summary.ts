import type { fileDeclaration669 } from '../../../../db/schema'

type Declaration = typeof fileDeclaration669.$inferSelect
export function registeredSummary681(declarations: Declaration[]) {
  return { count: declarations.length, declarations }
}
