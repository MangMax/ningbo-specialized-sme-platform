import { deserialize } from 'node:v8'
import { finalizeRecognizedWitness } from '../upgrade/recognized-witness'
/** R5 A bounded source-input audit. Passing diagnostics do not certify capture. */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as s from '../upgrade/legacy-schema'
import { candidateFixture } from './helpers/candidate-scope-target'
import { finalizeCandidateScopes } from '../upgrade/candidate-scope'
import { finalizeRecognizedStored } from '../upgrade/recognized-stored'
import { ensurePlatformObservation } from '../upgrade/frozen/server/platform-business-record'
import { recognizedFilterFacts } from '../lib/roster/recognized-filter-facts'
import { createRecognizedFilterSourceReader } from '../upgrade/frozen/recognized-filter-source'
import { sourcePositionForSequence, RDJB_TITLE_CODES } from '../lib/platform/recognized-evidence'

type Case = { conditionValue?: string | number | null; name: string; text: string | Buffer | null; gate: boolean | 'sql_error'; position?: string | null | 'reject' | 'TypeError'; sequence?: number; supplement?: boolean }
const page = (count: string, rdjb = '1') => `{"status":"success","rdjb":"${rdjb}","fetchedCount":${count},"page":1}`
const envelope = (fields = '', conditions = '"combination":"and"', pages = `[${page('1')}]`) => `{"source":"queryBusList","status":"success","completeness":"complete","fullRange":true,"effectiveConditions":{${conditions}},"pages":${pages}${fields}}`
const cases: Case[] = [
  ...[['true', true], ['false', false], ['1', true], ['2', false], ['"1"', false], ['null', false]] .map(([value, gate]) => ({ name: `fullRange ${value}`, text: envelope().replace('"fullRange":true', `"fullRange":${value}`), gate: gate === true })),
  { name: 'fullRange absent', text: envelope().replace(',"fullRange":true', ''), gate: false },
  { name: 'strict JSON', text: envelope(), gate: true, position: 'innovative_sme' },
  { name: 'JSON5', text: "{source:'queryBusList',status:'success',completeness:'complete',fullRange:true,effectiveConditions:{combination:'and'},pages:[{status:'success',rdjb:'1',fetchedCount:1,},],}", gate: true, position: 'innovative_sme' },
  { name: 'SQL NULL original', text: null, gate: false },
  { name: 'SQL NULL original with supplement', text: null, gate: false, supplement: true },
  { name: 'BLOB storage is not TEXT', text: Buffer.from('invalid'), gate: false },
  { name: 'JSON null', text: 'null', gate: false },
  { name: 'malformed', text: 'invalid', gate: 'sql_error' },
  { name: 'first source key', text: envelope().replace('"source":"queryBusList"', '"source":"queryBusList","source":"queryList"'), gate: true },
  { name: 'first status key', text: envelope().replace('"status":"success"', '"status":"success","status":"failed"'), gate: true },
  { name: 'first completeness key', text: envelope().replace('"completeness":"complete"', '"completeness":"complete","completeness":"partial"'), gate: true },
  { name: 'first fullRange key', text: envelope().replace('"fullRange":true', '"fullRange":true,"fullRange":false'), gate: true },
  { name: 'first combination key', text: envelope('', '"combination":"and","combination":"or"'), gate: true },
  { name: 'source wrong', text: envelope().replace('"source":"queryBusList"', '"source":"queryList"'), gate: false },
  { name: 'evidence failed', text: envelope().replace('"status":"success"', '"status":"failed"'), gate: false },
  { name: 'partial completeness', text: envelope().replace('"completeness":"complete"', '"completeness":"partial"'), gate: false },
  { name: 'combination or', text: envelope('', '"combination":"or"'), gate: false },
  { name: 'combination absent', text: envelope('', ''), gate: false },
  ...([{ raw: 'true', value: 1 }, { raw: 'false', value: 0 }, { raw: '1', value: 1 }, { raw: '2', value: 2 }, { raw: '"1"', value: '1' }, { raw: 'null', value: null }, { raw: '"2028"', value: '2028' }, { raw: '" 2028 "', value: ' 2028 ' }, { raw: '[]', value: '[]' }, { raw: '{}', value: '{}' }, { raw: '1.5', value: 1.5 }]).map(({ raw, value }) => ({ name: `condition ${raw}`, text: envelope('', `"combination":"and","rddqrq":${raw},"whpcyear":${raw},"whpc":${raw}`), gate: true, conditionValue: value })),
  { name: 'first condition key', text: envelope('', '"combination":"and","rddqrq":"2028","rddqrq":"2029"'), gate: true },
  { name: 'integer prefix ordinal', text: envelope('', undefined, `[${page('1', '2')},${page('1')}]`), gate: true, sequence: 2, position: 'innovative_sme' },
  { name: 'text prefix concatenation', text: envelope('', undefined, `[${page('"1"', '2')},${page('1')}]`), gate: true, sequence: 3, position: 'innovative_sme' },
  { name: 'integer prefix exhausted', text: envelope('', undefined, `[${page('1', '2')},${page('1')}]`), gate: true, sequence: 3, position: null },
  { name: 'real prefix reaches row', text: envelope('', undefined, `[${page('0.5', '2')},${page('0.5')}]`), gate: true, position: 'innovative_sme' },
  { name: 'real prefix misses row', text: envelope('', undefined, `[${page('0.25', '2')},${page('0.5')}]`), gate: true, position: null },
  { name: 'null prefix is zero', text: envelope('', undefined, `[${page('null', '2')},${page('1')}]`), gate: true, position: 'innovative_sme' },
  { name: 'absent prefix is NaN', text: envelope('', undefined, `[${page('null', '2').replace(',"fetchedCount":null', '')},${page('1')}]`), gate: true, position: null },
  { name: 'true prefix is one', text: envelope('', undefined, `[${page('true', '2')},${page('1')}]`), gate: true, position: 'specialized_sme' },
  { name: 'false prefix is zero', text: envelope('', undefined, `[${page('false', '2')},${page('1')}]`), gate: true, position: 'innovative_sme' },
  { name: 'negative prefix', text: envelope('', undefined, `[${page('-1', '2')},${page('2')}]`), gate: true, position: 'innovative_sme' },
  { name: 'missing page number', text: envelope('', undefined, `[${page('1', '2').replace(',"page":1', '')}]`), gate: true, position: 'specialized_sme' },
  { name: 'failed page skipped', text: envelope('', undefined, `[${page('99', '2').replace('"success"', '"failed"')},${page('1')}]`), gate: true, position: 'innovative_sme' },
  { name: 'zero success skipped', text: envelope('', undefined, `[${page('0', '2')},${page('1')}]`), gate: true, position: 'innovative_sme' },
  { name: 'first pages array', text: envelope(`,"pages":[${page('1', '3')}]`, undefined, `[${page('1', '2')}]`), gate: true, position: 'specialized_sme' },
  { name: 'first pages array lacks target ordinal', text: envelope(',"pages":[]', undefined, `[${page('1', '2')}]`), gate: true, position: 'specialized_sme' },
  { name: 'nested page title JS last', text: envelope('', undefined, `[${page('1', '2').replace('"rdjb":"2"', '"rdjb":"2","rdjb":"1"')}]`), gate: true, position: 'innovative_sme' },
  { name: 'primitive pages parse rejection', text: envelope('', undefined, '"oops"'), gate: true, position: 'reject' },
  { name: 'NULL pages', text: envelope('', undefined, 'null'), gate: true, position: null },
  { name: 'NULL page element', text: envelope('', undefined, '[null]'), gate: true, position: 'TypeError' },
]
let f: Awaited<ReturnType<typeof candidateFixture>>, old: Database.Database, target: Database.Database
const results: Record<string, unknown>[] = []
beforeAll(async () => {
  f = await candidateFixture(t => {
    const db = drizzle(t, { schema: s })
    db.insert(s.enterprise).values({ id: 1, name: 'Matrix', nameNorm: 'Matrix' }).run()
    for (const [index, input] of cases.entries()) {
      const id = index + 1
      t.prepare("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,collection_evidence,created_at) VALUES(?,'recognized_list',?,'1,2,3','t','success',?,'c')").run(id, input.name, input.text)
      db.insert(s.platformRelation).values({ id, queryId: id, sequenceNo: input.sequence ?? 1, relationKey: 'shared', enterpriseId: 1, verificationStatus: 'confirmed', rawFields: { id: 'shared', rdjb: '1', rddqrq: '2028-12-31', whpc: '2026-2' } }).run()
      ensurePlatformObservation(db, id)
      if (input.supplement) {
        db.insert(s.importBatch).values({ id: 1, idempotencyKey: 'matrix', sourceKind: 'platform_archive', sourceIdentity: 'synthetic' }).onConflictDoNothing().run()
        t.prepare("INSERT INTO platform_query_legacy_provenance(query_id,source_identity,source_sha256,segment_index,collection,input_fingerprint,import_batch_id,created_at) VALUES(?,'synthetic',?,0,?,?,1,'c')").run(id, 'a'.repeat(64), envelope(), 'b'.repeat(64))
      }
    }
  })
  finalizeCandidateScopes(f)
  const source = join(f.root, 'recognized-predecessor.sqlite'); copyFileSync(f.target, source)
  finalizeRecognizedStored({ source, target: f.target, runId: 'recognized', predecessorRunId: 'candidate' })
  const predecessor=join(f.root,'witness-predecessor.sqlite');copyFileSync(f.target,predecessor)
  finalizeRecognizedWitness({source:predecessor,target:f.target,runId:'witness',predecessorRunId:'recognized'})
  old = new Database(f.legacySource, { readonly: true }); target = new Database(f.target, { readonly: true })
  old.function('roster84_uscc', (_value: unknown) => null)
}, 30000)
afterAll(() => { if (f) writeFileSync(join(f.root, 'INPUT-MATRIX.json'), JSON.stringify(results, null, 2)); old?.close(); target?.close() })

it.each(cases)('freezes independent old witness input: $name', input => {
  const id = cases.indexOf(input) + 1
  const reader = createRecognizedFilterSourceReader(old, 'typed')
  const captured=target.prepare('SELECT * FROM platform_collection WHERE id=?').get(id) as Record<string,unknown>
  if (input.gate === 'sql_error') { expect(captured).toMatchObject({witness_state:'error',witness_gate:null,witness_error:'malformed JSON'}); expect(() => reader.read({ relationId: id, enterpriseId: 1, uscc: null })).toThrow('malformed JSON'); results.push({id,name:input.name,input:input.text,oldError:'malformed JSON',captured}); return }
  const row = reader.read({ relationId: id, enterpriseId: 1, uscc: null })
  expect(Boolean(row)).toBe(input.gate)
  expect(captured).toMatchObject({witness_state:'captured',witness_gate:Number(input.gate)})
  let position: string | null = null
  if (row) {
    let pages: unknown
    try { pages = row.pages ? JSON.parse(row.pages) : null } catch { position = 'reject' }
    if (Array.isArray(pages)) {
      try { const rdjb = sourcePositionForSequence({ pages }, row.sequenceNo).sourceRdjb; position = rdjb ? RDJB_TITLE_CODES[rdjb] ?? null : null }
      catch (error) { if (!(error instanceof TypeError)) throw error; position = 'TypeError' }
    }
  }
  if (input.position !== undefined) expect(position).toBe(input.position)
  const observed=target.prepare('SELECT * FROM platform_business_observation WHERE id=?').get(id) as Record<string,unknown>
  const expectedState=!input.gate?'not_applicable':position==='reject'?'rejected':position==='TypeError'?'error':position===null?'unmatched':'matched'
  expect(observed.witness_state).toBe(expectedState)
  if(expectedState==='matched')expect(RDJB_TITLE_CODES[Buffer.from(String(observed.witness_rdjb_key),'hex').toString('utf16le')]??null).toBe(position)
  if(input.name==='first pages array lacks target ordinal')expect(observed).toMatchObject({witness_ordinal:0,witness_rdjb_kind:'text',witness_rdjb_key:'3200',witness_page_kind:'number'})
  if(input.name==='first pages array lacks target ordinal'){if(!Buffer.isBuffer(observed.witness_rdjb_value)||!Buffer.isBuffer(observed.witness_page_value))throw new Error('Expected raw position BLOBs');expect(deserialize(observed.witness_rdjb_value)).toBe('2');expect(deserialize(observed.witness_page_value)).toBe(1)}
  if(row)for(const [name,value] of [['rddqrq',row.conditionValidYear],['whpcyear',row.conditionMaintenanceYear],['whpc',row.conditionMaintenanceBatch]]){
   const condition=target.prepare('SELECT witness_value FROM platform_collection_condition WHERE collection_id=? AND name=?').get(id,name) as {witness_value:unknown}
   expect(condition.witness_value).toEqual(value)
  }

  if (Object.hasOwn(input, 'conditionValue')) {
    expect(row?.conditionValidYear).toBe(input.conditionValue)
    expect(row?.conditionMaintenanceYear).toBe(input.conditionValue)
    expect(row?.conditionMaintenanceBatch).toBe(input.conditionValue)
    expect(recognizedFilterFacts({ titleCode: 'innovative_sme', schema: 'queryBusList' },
      { rddqrq: '2028-12-31', whpcyear: null, whpc: '2026-2' },
      { rddqrq: row?.conditionValidYear, whpcyear: row?.conditionMaintenanceYear, whpc: row?.conditionMaintenanceBatch }))
      .toEqual({ validYear: input.conditionValue === null || input.conditionValue === '2028' ? 2028 : null, maintenance: input.conditionValue === null ? { year: 2026, batch: null } : null })
  }
  const collection = target.prepare('SELECT source,evidence_status,completeness,full_range,provenance_state FROM platform_collection WHERE id=?').get(id)
  const pages = target.prepare('SELECT ordinal,rdjb,page_no,fetched_count,position_state FROM platform_collection_page WHERE collection_id=? ORDER BY ordinal').all(id)
  const conditions = target.prepare('SELECT name,value_kind,text_value,integer_value FROM platform_collection_condition WHERE collection_id=? ORDER BY name').all(id)
  results.push({ id, name: input.name, input: input.text, old: row ?? null, position, collection, pages, conditions, captured, observed })
  if (input.name === 'first pages array lacks target ordinal') { expect(position).toBe('specialized_sme'); expect(pages).toEqual([]) }
  if (input.name === 'first condition key') { expect(row?.conditionValidYear).toBe('2028'); expect(conditions).toContainEqual({ name: 'rddqrq', value_kind: 'text', text_value: '2029', integer_value: null }) }
  if (input.name === 'SQL NULL original with supplement') { expect(row).toBeUndefined(); expect(collection).toMatchObject({ source: 'queryBusList', full_range: 1, provenance_state: 'legacy_supplement' }) }
})
