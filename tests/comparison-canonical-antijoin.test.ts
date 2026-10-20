import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { expect, it } from 'vitest'
import * as schema from '../db/schema'
import { getComparison } from '../lib/comparison'
import { getComparisonB42 } from './helpers/comparison-b42-reference'
import type { ComparisonRow } from '../lib/comparison'

it('canonical same-enterprise matches avoid USCC equality probes while unmatched rows preserve exact DTOs', () => {
  const sqlite = new Database(':memory:')
  const reads = new Map<number, number>()
  try {
    // Current-schema constraints, canonical sources only. The transparent UDF
    // counts real SQL evaluations but changes access to the USCC index; these
    // numbers are not index seeks, CPU cost or a latency measurement.
    sqlite.function('observe_uscc', (id: number, value: unknown) => {
      reads.set(id, (reads.get(id) ?? 0) + 1)
      return value as string | null
    })
    sqlite.exec(`
      create table enterprise_storage(id integer primary key, name text not null, uscc_norm text, city text, reg_status text);
      create unique index enterprise_uscc_norm_uq on enterprise_storage(uscc_norm);
      create view enterprise as select id, name, observe_uscc(id, uscc_norm) as uscc_norm, city, reg_status from enterprise_storage;
      create table record(id integer primary key, enterprise_id integer not null, title_code text not null,
        source text not null check(source in ('jxj', 'miit')), district text);
      create unique index record_identity_uq on record(enterprise_id, title_code, source);
      insert into enterprise_storage values(1, 'Canonical matched', 'MATCH', null, null);
      insert into record values(1, 1, 'specialized_sme', 'miit', 'miit district');
      insert into record values(2, 1, 'specialized_sme', 'jxj', 'jxj district');
    `)
    const db = drizzle(sqlite, { schema })
    const zeroCounts = { little_giant: { missing_in_miit: 0, extra_in_miit: 0 },
      specialized_sme: { missing_in_miit: 0, extra_in_miit: 0 }, innovative_sme: { missing_in_miit: 0, extra_in_miit: 0 } }
    const measure = (read: typeof getComparison) => {
      reads.clear()
      const result = read(db)
      return { result, calls: Object.fromEntries(reads) }
    }
    const frozen = measure(getComparisonB42), actual = measure(getComparison)
    expect(frozen.result).toEqual({ rows: [], counts: zeroCounts })
    expect(actual.result).toEqual(frozen.result)
    expect(frozen.calls).toEqual({ 1: 6 })
    // Add canonical misses on both sides, without changing any constraint.
    sqlite.exec(`
      insert into enterprise_storage values(2, 'J only', 'J-ONLY', '宁波市', '存续'), (3, 'M only', 'M-ONLY', null, null);
      insert into record values(3, 2, 'specialized_sme', 'jxj', 'J district'), (4, 3, 'specialized_sme', 'miit', 'M district');
    `)
    const mixedFrozen = measure(getComparisonB42), mixedActual = measure(getComparison)
    const expected = { rows: [
      { enterpriseId: 2, name: 'J only', uscc: 'J-ONLY', district: 'J district', titleCode: 'specialized_sme', direction: 'missing_in_miit', curated: false,
        evidence: { matchedBy: 'uscc', otherSideUscc: null, currentCity: '宁波市', regStatus: '存续' } },
      { enterpriseId: 3, name: 'M only', uscc: 'M-ONLY', district: 'M district', titleCode: 'specialized_sme', direction: 'extra_in_miit', curated: false,
        evidence: { matchedBy: 'uscc', otherSideUscc: null, currentCity: null, regStatus: null } },
    ], counts: { ...zeroCounts, specialized_sme: { missing_in_miit: 1, extra_in_miit: 1 } } }
    expect(mixedActual.result).toEqual(expected)
    expect(JSON.stringify(mixedActual.result)).toBe(JSON.stringify(mixedFrozen.result))
    process.stdout.write(`canonical comparison USCC evaluations ${JSON.stringify({ matchedFrozen: frozen.calls, matchedActual: actual.calls, mixedFrozen: mixedFrozen.calls, mixedActual: mixedActual.calls })}\n`)
    // For the isolated matched pair only two NULL guards remain. Mixed-fixture
    // calls also include cross-enterprise comparisons and output USCC reads.
    expect(actual.calls).toEqual({ 1: 2 })
    expect(mixedActual.calls).toEqual({ 1: 4, 2: 5, 3: 5 })
  } finally { sqlite.close() }
})

it('preserves frozen bytes and literal DTOs for legacy binary identities, source sides and MIN-id representatives', () => {
  const sqlite = new Database(':memory:')
  try {
    // Deliberately legacy-compatible synthetic tables: duplicate USCC enterprise
    // IDs and nullable source cannot be created by today's import contract.
    sqlite.exec(`
      create table enterprise(id integer primary key, name text, uscc_norm text, city text, reg_status text);
      create table record(id integer primary key, enterprise_id integer, title_code text, source text, district text);
      create table record_event(id integer primary key, record_id integer, event_type text, year integer);
    `)
    const enterprise = sqlite.prepare('insert into enterprise values(?, ?, ?, ?, ?)')
    const record = sqlite.prepare('insert into record values(?, ?, ?, ?, ?)')
    const e = (id: number, name: string, uscc: string | null) => enterprise.run(id, name, uscc, '嘉兴市', '注销')
    const r = (id: number, enterpriseId: number, source: string | null, title = 'specialized_sme', district: string | null = 'first') => record.run(id, enterpriseId, title, source, district)
    e(1, 'A null', null); r(9, 1, 'legacy', 'specialized_sme', 'later'); r(1, 1, 'miit'); r(2, 1, 'jxj')
    e(2, 'empty J', ''); r(3, 2, 'jxj')
    e(3, 'empty other', ''); r(4, 3, 'archive')
    e(4, 'B tie', 'SAME'); r(10, 4, 'miit', 'specialized_sme', 'later'); r(5, 4, 'archive')
    e(5, 'B tie', 'SAME'); r(6, 5, 'miit')
    e(6, 'C lower', 'legacy'); r(7, 6, 'jxj')
    e(7, 'D upper', 'LEGACY'); r(8, 7, 'other')
    e(8, 'E space', ' LEGACY '); r(11, 8, 'miit')
    e(9, 'F zero width', 'LE\u200bGACY'); r(12, 9, 'jxj', 'innovative_sme')
    e(10, 'matched', 'MATCH'); r(13, 10, 'jxj'); r(14, 10, 'archive'); r(15, 10, 'miit')
    e(11, 'unknown title', 'UNKNOWN'); r(16, 11, 'jxj', 'future_title')
    e(12, 'G null side', 'NULL-SIDE'); r(17, 12, null); r(18, 12, 'jxj'); r(19, 12, 'miit'); r(20, 12, null, 'specialized_sme', 'later')
    e(13, 'H asymmetry', 'ASYMMETRY'); r(21, 13, null); r(22, 13, 'jxj')
    e(14, 'I whitespace match', ' '); r(23, 14, 'jxj', 'little_giant')
    e(15, 'I whitespace opposite', ' '); r(24, 15, 'non-jxj', 'little_giant')
    e(16, 'J all history', 'HISTORY'); r(25, 16, 'jxj', 'little_giant', null)
    e(17, 'K title mismatch', 'HISTORY'); r(26, 17, 'miit', 'innovative_sme')
    r(27, 999, 'jxj') // dangling enterprise remains excluded
    r(28, 4, 'miit', 'specialized_sme', 'duplicate source later')
    r(29, 16, 'jxj', 'little_giant', 'duplicate source later')
    // A legacy NULL side is separate from false even when both produce extra
    // rows with identical sort keys; retain their representative districts.
    e(18, 'L same coordinate tie', 'NULL-FALSE'); r(30, 18, 'miit', 'specialized_sme', 'false side'); r(31, 18, null, 'specialized_sme', 'null side')
    sqlite.exec("insert into record_event values(1, 25, 'nurture', 1901), (2, 25, 'review', 2099)")
    const db = drizzle(sqlite, { schema })
    const row = (enterpriseId: number, name: string, uscc: string | null, direction: ComparisonRow['direction'], titleCode: ComparisonRow['titleCode'] = 'specialized_sme', district: string | null = 'first'): ComparisonRow => ({
      enterpriseId, name, uscc, district, titleCode, direction, curated: false,
      evidence: { matchedBy: 'uscc', otherSideUscc: null, currentCity: '嘉兴市', regStatus: '注销' },
    })
    const expected = { rows: [
      row(16, 'J all history', 'HISTORY', 'missing_in_miit', 'little_giant', null),
      row(1, 'A null', null, 'extra_in_miit'), row(1, 'A null', null, 'missing_in_miit'),
      row(4, 'B tie', 'SAME', 'extra_in_miit'), row(5, 'B tie', 'SAME', 'extra_in_miit'),
      row(6, 'C lower', 'legacy', 'missing_in_miit'), row(7, 'D upper', 'LEGACY', 'extra_in_miit'),
      row(8, 'E space', ' LEGACY ', 'extra_in_miit'), row(12, 'G null side', 'NULL-SIDE', 'extra_in_miit'),
      row(13, 'H asymmetry', 'ASYMMETRY', 'extra_in_miit'), row(13, 'H asymmetry', 'ASYMMETRY', 'missing_in_miit'),
      row(18, 'L same coordinate tie', 'NULL-FALSE', 'extra_in_miit', 'specialized_sme', 'null side'),
      row(18, 'L same coordinate tie', 'NULL-FALSE', 'extra_in_miit', 'specialized_sme', 'false side'),
      row(9, 'F zero width', 'LE\u200bGACY', 'missing_in_miit', 'innovative_sme'),
      row(17, 'K title mismatch', 'HISTORY', 'extra_in_miit', 'innovative_sme'),
    ], counts: {
      little_giant: { missing_in_miit: 1, extra_in_miit: 0 },
      specialized_sme: { missing_in_miit: 3, extra_in_miit: 9 },
      innovative_sme: { missing_in_miit: 1, extra_in_miit: 1 },
    } }
    expect(getComparison(db)).toEqual(expected)
    for (const options of [{}, { title: [] }, { title: ['specialized_sme'] }, { title: ['future_title'] }, { direction: 'missing_in_miit' as const }, { title: ['innovative_sme'], direction: 'extra_in_miit' as const }]) {
      expect(JSON.stringify(getComparison(db, options))).toBe(JSON.stringify(getComparisonB42(db, options)))
      expect(getComparison(db, options).counts).toEqual(expected.counts)
    }
    // Semantic checks run on ordinary tables, without the counter view/UDF.
  } finally { sqlite.close() }
})

it('a same-enterprise miss still matches an opposite source on another enterprise with the same binary USCC', () => {
  const sqlite = new Database(':memory:')
  try {
    // Legacy distinct enterprise IDs with equal stored USCC; no local opposite
    // exists on either ID. Today's canonical uniqueness is tested separately.
    sqlite.exec(`
      create table enterprise(id integer primary key, name text, uscc_norm text, city text, reg_status text);
      create table record(id integer primary key, enterprise_id integer, title_code text, source text, district text);
      insert into enterprise values(1, 'Cross J', 'SAME-BINARY', null, null), (2, 'Cross M', 'SAME-BINARY', null, null);
      insert into record values(1, 1, 'specialized_sme', 'jxj', 'J district'), (2, 2, 'specialized_sme', 'miit', 'M district');
    `)
    const db = drizzle(sqlite, { schema })
    expect(getComparison(db)).toEqual({ rows: [], counts: {
      little_giant: { missing_in_miit: 0, extra_in_miit: 0 }, specialized_sme: { missing_in_miit: 0, extra_in_miit: 0 }, innovative_sme: { missing_in_miit: 0, extra_in_miit: 0 },
    } })
    expect(JSON.stringify(getComparison(db))).toBe(JSON.stringify(getComparisonB42(db)))
  } finally { sqlite.close() }
})
