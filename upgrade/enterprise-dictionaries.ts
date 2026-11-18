import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { z } from 'zod'

const region = z.object({ id: z.string().regex(/^\d+$/), pid: z.string(), name: z.string().min(1), level: z.enum(['1', '2', '3']) })
const industry = z.object({
  id: z.string().min(1),
  industry_code: z.string(),
  industry_name: z.string().min(1),
  parent_id: z.string().nullable(),
  level: z.enum(['0', '1', '2', '3']),
  description: z.string().nullable(),
})
type Entry = { code: string; parent: string | null; level: number }

function checkHierarchy(rows: Entry[], rootLevel: number) {
  const byCode = new Map(rows.map(row => [row.code, row]))
  if (rows.length === 0 || byCode.size !== rows.length) throw new Error('Dictionary is empty or has duplicate codes')
  for (const { code, parent, level } of rows) {
    if (level === rootLevel ? parent !== null : parent === null || byCode.get(parent)?.level !== level - 1) {
      throw new Error(`Invalid dictionary parent for ${code}`)
    }
  }
}

function readInput(path: string) {
  const bytes = readFileSync(path)
  return { value: JSON.parse(bytes.toString('utf8')) as unknown, sha256: createHash('sha256').update(bytes).digest('hex') }
}

export function readEnterpriseDictionaries(regionPath: string, industryPath: string) {
  const regionInput = readInput(regionPath)
  const industryInput = readInput(industryPath)
  const regions = z.array(region).parse(regionInput.value).map(row => ({
    code: row.id, name: row.name, parent: row.pid === '0' ? null : row.pid, level: Number(row.level),
  }))
  const industries = z.array(industry).parse(industryInput.value).map(row => ({
    code: row.industry_code, inputId: row.id, name: row.industry_name, parent: row.parent_id,
    level: Number(row.level), description: row.description,
  }))
  checkHierarchy(regions, 1)
  checkHierarchy(industries, 0)
  for (const row of industries) {
    const validCode = [/^[A-Z]$/, /^\d{2}$/, /^\d{3}$/, /^\d{4}$/][row.level]!
    if (!validCode.test(row.code) || (row.level >= 2 && !row.code.startsWith(row.parent!))) {
      throw new Error(`Invalid industry code: ${row.code}`)
    }
  }
  return { regions, industries, regionSha256: regionInput.sha256, industrySha256: industryInput.sha256 }
}

export type EnterpriseDictionaries = ReturnType<typeof readEnterpriseDictionaries>

export function installEnterpriseDictionaries(db: Database.Database, dictionaries: EnterpriseDictionaries) {
  const regionInsert = db.prepare('INSERT INTO enterprise_region(code,name,parent_code,level) VALUES (@code,@name,@parent,@level)')
  for (const row of dictionaries.regions.toSorted((a, b) => a.level - b.level)) regionInsert.run(row)
  const industryInsert = db.prepare('INSERT INTO enterprise_industry(code,input_id,name,parent_code,level,description) VALUES (@code,@inputId,@name,@parent,@level,@description)')
  for (const row of dictionaries.industries.toSorted((a, b) => a.level - b.level)) industryInsert.run(row)
}
