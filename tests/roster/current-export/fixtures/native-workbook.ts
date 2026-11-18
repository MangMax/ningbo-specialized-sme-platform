import ExcelJS from 'exceljs'
import { join } from 'node:path'
import { writeCurrentWorkbook } from '../../../../layers/sme-roster/lib/roster/current-workbook'
import { specializedExportFixture } from './specialized-export'
import type { CurrentTitle } from '../../../../layers/sme-roster/lib/roster/current-qualification'

// Real SQLite reader and streaming writer; no job/HTTP contract is simulated here.
export function nativeWorkbookFixture() {
  const base = specializedExportFixture()
  return { ...base, get db() { return base.db },
    async workbook(key: string, title: CurrentTitle = 'specialized_sme') {
      const filename = join(base.dir, key + '.xlsx')
      const result = await writeCurrentWorkbook(base.db.$client, title, filename, () => {})
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(filename)
      return { wb, result }
    },
  }
}
