import ExcelJS from 'exceljs'
import { join } from 'node:path'
import { writePostgresCurrentWorkbook } from '../../../../layers/sme-roster/lib/roster/current-workbook-postgres'
import { specializedExportFixture } from './specialized-export'
import type { CurrentTitle } from '../../../../layers/sme-roster/lib/roster/current-titles'

// Isolated PostgreSQL reader and streaming workbook writer.
export function nativeWorkbookFixture() {
  const base = specializedExportFixture()
  return {
    get db() { return base.db },
    candidate: base.candidate, addRecord: base.addRecord, businessDigest: base.businessDigest,
    runtimeQuery: base.runtimeQuery, resetBusiness: base.resetBusiness, close: base.close,
    async workbook(key: string, title: CurrentTitle = 'specialized_sme') {
      const filename = join(base.dir, key + '.xlsx')
      const result = await writePostgresCurrentWorkbook(base.db, title, filename, () => {})
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(filename)
      return { wb, result }
    },
  }
}
