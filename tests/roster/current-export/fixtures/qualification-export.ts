import { specializedExportFixture } from './specialized-export'

export { businessTables, type Event } from './specialized-export'

export function qualificationExportFixture() {
  return specializedExportFixture({ preserveSyntheticUscc: true })
}
