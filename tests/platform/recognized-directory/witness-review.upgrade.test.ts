import Database from 'better-sqlite3'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { recognizedFixture } from './fixtures/migrated-directory'
import { finalizeRecognizedWitness } from '../../../upgrade/recognized-witness'
import { witnessInstalled } from '../../../upgrade/frozen/recognized-witness-catalog'
import { verifyWitnessCollection, verifyWitnessObservation } from '../../../upgrade/frozen/recognized-witness-write'

async function fixture(rdjb: unknown = '2') {
  const evidence = JSON.stringify({ source: 'queryBusList', status: 'success', completeness: 'complete', fullRange: 1, effectiveConditions: { combination: 'and', rddqrq: '2028' }, pages: [{ status: 'success', fetchedCount: 1, rdjb, page: 1 }] })
  const f = await recognizedFixture(old => old.prepare('UPDATE platform_query SET collection_evidence=? WHERE id=1').run(evidence))
  f.close()
  const source = join(f.root, 'witness-source.sqlite')
  copyFileSync(f.target, source)
  const options = { source, target: f.target, runId: 'witness', predecessorRunId: 'recognized' }
  finalizeRecognizedWitness(options)
  return { ...f, options }
}

it('rejects replacing captured conditions with recursive triggers disabled and preserves committed facts', async () => {
  const f = await fixture()
  const t = new Database(f.target)
  try {
    t.pragma('foreign_keys=ON')
    expect(t.pragma('recursive_triggers', { simple: true })).toBe(0)
    const query = "SELECT * FROM platform_collection_condition WHERE collection_id=1 AND name='rddqrq'"
    const before = t.prepare(query).get()
    t.exec('BEGIN IMMEDIATE')
    expect(() => t.exec("INSERT OR REPLACE INTO platform_collection_condition(collection_id,name,value_kind,text_value,integer_value) SELECT collection_id,name,value_kind,text_value,integer_value FROM platform_collection_condition WHERE collection_id=1 AND name='rddqrq'")).toThrow(/recognized witness condition/)
    expect(() => t.exec("INSERT INTO platform_collection_condition(collection_id,name,value_kind) VALUES(1,'rddqrq','absent') ON CONFLICT(collection_id,name) DO UPDATE SET witness_kind=NULL,witness_value=NULL")).toThrow(/recognized witness condition/)
    t.exec('COMMIT')
    expect(t.prepare(query).get()).toEqual(before)
    expect(witnessInstalled(t)).toBe(true)
    verifyWitnessCollection(t, 1)
    expect(t.pragma('foreign_key_check')).toEqual([])
  } finally { t.close() }
  const reopened = new Database(f.target, { readonly: true })
  try { verifyWitnessCollection(reopened, 1) } finally { reopened.close() }
})

it('rejects update replacement of a captured destination with recursive triggers disabled after commit and reopen', async () => {
  const f = await fixture()
  const t = new Database(f.target)
  const query = 'SELECT * FROM platform_collection_condition ORDER BY collection_id,name'
  const before = t.prepare(query).all()
  try {
    t.pragma('foreign_keys=ON')
    expect(t.pragma('recursive_triggers', { simple: true })).toBe(0)
    t.exec('BEGIN IMMEDIATE')
    expect(() => t.exec("UPDATE OR REPLACE platform_collection_condition SET name='rddqrq',value_kind='text',text_value='2028',integer_value=NULL WHERE collection_id=1 AND name='combination'")).toThrow(/recognized witness condition/)
    t.exec('COMMIT')
    expect(t.prepare(query).all()).toEqual(before)
  } finally { t.close() }
  const reopened = new Database(f.target, { readonly: true })
  try {
    expect(reopened.prepare(query).all()).toEqual(before)
    verifyWitnessCollection(reopened, 1)
    expect(witnessInstalled(reopened)).toBe(true)
    expect(reopened.pragma('foreign_key_check')).toEqual([])
  } finally { reopened.close() }
})

it.each([
  { name: 'lone high surrogate', value: '\ud800', hex: '00d8' },
  { name: 'nested lone surrogate', value: [['\ud800']], hex: '00d8' },
  { name: 'lone low surrogate', value: '\udfff', hex: 'ffdf' },
  { name: 'astral pair and zero', value: '\ud83d\ude00\u0000', hex: '3dd800de0000' },
  { name: 'empty array key', value: [], hex: '' },
  { name: 'false has no key', value: false, hex: null },
  { name: 'ordinary title', value: '2', hex: '3200' },
])('migrates and replays exact property key code units: $name', async ({ value, hex }) => {
  const f = await fixture(value)
  const t = new Database(f.target, { readonly: true })
  try {
    const row = t.prepare('SELECT witness_state,witness_rdjb_key FROM platform_business_observation WHERE id=1').get()
    expect(row).toEqual({ witness_state: 'matched', witness_rdjb_key: hex })
    verifyWitnessObservation(t, 1)
  } finally { t.close() }
  expect(finalizeRecognizedWitness(f.options).state).toBe('complete')
})
