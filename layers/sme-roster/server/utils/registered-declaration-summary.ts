import type { fileDeclaration669 } from '../../../../db/postgresql/roster-file-tables'
import type { FilePart } from '../../../../db/file-part'

export type RegisteredDeclaration = Omit<typeof fileDeclaration669.$inferSelect, 'part' | 'pageRanges' | 'active'> & {
  active: boolean
  part: FilePart
  pageRanges: { start: number; end: number }[] | null
}
type Declaration = RegisteredDeclaration
export function registeredSummary681(declarations: Declaration[]) {
  return { count: declarations.length, declarations }
}
