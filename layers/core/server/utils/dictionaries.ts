import { randomUUID } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterpriseIndustry, enterpriseRegion, enterpriseSourceChannel, enterpriseSourceListType } from '@db/schema'
import type { useDb } from '@db'
import { coreDictionaryKinds, type DictionaryEntry, type EditableDictionaryKind } from '#core/lib/dictionaries'

type Db = ReturnType<typeof useDb>
type DictionaryKind = typeof coreDictionaryKinds[number]
type DictionaryInput = { name: string } | { code: string; name: string; previousName: string }
const businessTables = { 'list-sources': enterpriseSourceChannel, 'list-types': enterpriseSourceListType } as const
const postgresTables = {
  regions: sql`enterprise_region`, industries: sql`enterprise_industry`,
  'list-sources': sql`enterprise_source_channel`, 'list-types': sql`enterprise_source_list_type`,
}
const normalizeName = (name: string) => name.normalize('NFKC').trim().toLowerCase()

function withParentDetail(rows: { code: string; name: string; level: number; parentCode: string | null }[]): DictionaryEntry[] {
  const names = new Map(rows.map(row => [row.code, row.name]))
  return rows.map(({ code, name, parentCode, level }) => ({ code, name, level, parentCode, detail: parentCode ? names.get(parentCode) ?? parentCode : undefined }))
}

export function readDictionary(db: Db, kind: DictionaryKind): DictionaryEntry[] {
  if (kind === 'regions' || kind === 'industries') {
    const table = kind === 'regions' ? enterpriseRegion : enterpriseIndustry
    const rows = db.select({ code: table.code, name: table.name, parentCode: table.parentCode, level: table.level }).from(table).orderBy(asc(table.code)).all()
    return withParentDetail(rows)
  }
  const table = businessTables[kind]
  return db.select({ code: table.code, name: table.name }).from(table).orderBy(asc(table.code)).all()
}

function validateEntry(entries: DictionaryEntry[], input: DictionaryInput) {
  const code = 'code' in input ? input.code : `custom-${randomUUID()}`
  if ('code' in input) {
    if (code === 'direct') return { status: 403, message: '「直接添加」是系统保留项。' } as const
    const current = entries.find(value => value.code === code)
    if (!current) return { status: 404, message: '该字典项不存在。' } as const
    if (current.name !== input.previousName && current.name !== input.name) {
      return { status: 409, message: '名称已变更，请刷新后重新编辑。' } as const
    }
  }
  if (entries.some(value => value.code !== code && normalizeName(value.name) === normalizeName(input.name))) {
    return { status: 409, message: '已有同名选项。' } as const
  }
  return { status: 200, entry: { code, name: input.name } } as const
}

export function saveDictionaryEntry(db: Db, kind: EditableDictionaryKind, input: DictionaryInput) {
  return db.$client.transaction(() => {
    const checked = validateEntry(readDictionary(db, kind), input)
    if ('message' in checked) return checked
    const table = businessTables[kind]
    if ('code' in input) db.update(table).set({ name: input.name }).where(eq(table.code, checked.entry.code)).run()
    else db.insert(table).values(checked.entry).run()
    return checked
  }).immediate()
}

export async function readPostgresDictionary(db: NodePgDatabase, kind: DictionaryKind): Promise<DictionaryEntry[]> {
  const table = postgresTables[kind]
  if (kind === 'regions' || kind === 'industries') {
    const { rows } = await db.execute<{ code: string; name: string; parentCode: string | null; level: string }>(sql`
      SELECT code, name, parent_code AS "parentCode", level FROM ${table} ORDER BY code COLLATE "C"`)
    return withParentDetail(rows.map(row => ({ ...row, level: Number(row.level) })))
  }
  const { rows } = await db.execute<{ code: string; name: string }>(sql`SELECT code, name FROM ${table} ORDER BY code COLLATE "C"`)
  return rows
}

export function savePostgresDictionaryEntry(db: NodePgDatabase, kind: EditableDictionaryKind, input: DictionaryInput) {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('dictionary:' || ${kind}, 0))`)
    const checked = validateEntry(await readPostgresDictionary(tx, kind), input)
    if ('message' in checked) return checked
    const table = postgresTables[kind]
    const { code, name } = checked.entry
    if ('code' in input) await tx.execute(sql`UPDATE ${table} SET name = ${name} WHERE code = ${code}`)
    else await tx.execute(sql`INSERT INTO ${table} (code, name) VALUES (${code}, ${name})`)
    return checked
  })
}
