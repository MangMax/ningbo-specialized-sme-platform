import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createError, createRouter, defineEventHandler, readBody, toWebHandler } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

const endpoint = '/api/core/enterprises/match-candidates'
describe('PostgreSQL batch candidate matching over HTTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-enterprise-match-'))
  let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  let request: ReturnType<typeof toWebHandler>

  beforeAll(async () => {
    postgres = await postgresRuntimeFixture({ dir })
    postgres.psql(['-c', `
      SET search_path TO business, public;
      INSERT INTO enterprise (id, name, name_norm, uscc_norm) VALUES
        (11, '正源（宁波）', '正源宁波', '91330110MA2GMDFH58'),
        (12, '海科企业', '海科企业', '91330211255994458Q'),
        (13, '已合并', '已合并', 'AAAAAAAAAAAAAAAAAA'),
        (14, '已移出', '已移出', 'BBBBBBBBBBBBBBBBBB');
      INSERT INTO enterprise_merge (from_enterprise_id, into_enterprise_id, basis, recorded_at)
        VALUES (13, 11, 'fixture', '2026-01-01');
      INSERT INTO enterprise_region (code, name, level) VALUES ('9911', '测试区', 2);
      INSERT INTO enterprise_region (code, name, level, parent_code) VALUES ('991101', '测试镇', 3, '9911');
      INSERT INTO enterprise_industry (code, input_id, name, level) VALUES ('9999', 'fixture', '测试行业', 3);
      INSERT INTO enterprise_directory (enterprise_id, revision, district_code, township_code, industry_code)
        VALUES (11, 7, '9911', '991101', '9999');
      INSERT INTO enterprise_directory (enterprise_id, removed_reason) VALUES (14, '已移出范围');
      INSERT INTO enterprise_alias (enterprise_id, name, name_norm, source_kind, source_ref_id, verification_status, created_at) VALUES
        (11, '曾用名', '曾用名', 'manual', 1, 'confirmed', '2026-01-01'),
        (11, '曾用名', '曾用名', 'manual', 2, 'confirmed', '2026-01-01'),
        (12, '正源宁波', '正源宁波', 'manual', 1, 'pending', '2026-01-01'),
        (12, '待核别名', '待核别名', 'manual', 1, 'pending', '2026-01-01'),
        (12, '撤下别名', '撤下别名', 'manual', 1, 'withdrawn', '2026-01-01'),
        (12, '重名', '重名', 'manual', 1, 'confirmed', '2026-01-01'),
        (11, '重名', '重名', 'manual', 1, 'confirmed', '2026-01-01'),
        (11, '正源宁波', '正源宁波', 'manual', 1, 'confirmed', '2026-01-01'),
        (14, '移出别名', '移出别名', 'manual', 1, 'confirmed', '2026-01-01');
      ALTER DATABASE postgres SET default_transaction_read_only = on;
    `])
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
    vi.stubEnv('NUXT_DB_READONLY', '1')
    vi.stubGlobal('defineEventHandler', defineEventHandler)
    vi.stubGlobal('readBody', readBody)
    vi.stubGlobal('createError', createError)
    const handler = (await import('../../../layers/core/server/api/core/enterprises/match-candidates.post')).default
    request = toWebHandler(createApp().use(createRouter().post(endpoint, handler)))
  })

  afterAll(async () => {
    try {
      await closePostgresDirectoryDb()
      postgres?.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })

  const post = (body: unknown) => request(new Request('http://localhost' + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))

  it('returns exact candidates in source order with all reasons and current directory details', async () => {
    const response = await post({ rows: [
      { key: 1, name: '外部名称', uscc: '９１３３０１１０ ma2gmdfh58' },
      { key: '1', name: ' 正源 （宁波）✓ ', uscc: '待核对' },
      { key: 'alias', name: ' 曾 用 名 ' },
      { key: 'agree', name: '正源宁波', uscc: '91330110MA2GMDFH58' },
      { key: 'conflict', name: '正源宁波', uscc: '91330211255994458Q' },
      { key: 'same-name', name: '重名', uscc: 'CCCCCCCCCCCCCCCCCC' },
      { key: 'uscc-mismatch', name: '正源（宁波）', uscc: '91330200000000000Z' },
    ] })
    expect(response.status).toBe(200)
    const alpha = {
      id: 11, name: '正源（宁波）', uscc: '91330110MA2GMDFH58', revision: 7,
      districtCode: '9911', townshipCode: '991101', industryCode: '9999',
      districtName: '测试区', townshipName: '测试镇', industryName: '测试行业',
    }
    const beta = {
      id: 12, name: '海科企业', uscc: '91330211255994458Q', revision: 1,
      districtCode: null, townshipCode: null, industryCode: null, districtName: null, townshipName: null, industryName: null,
    }
    expect(await response.json()).toEqual({ rows: [
      { key: 1, status: 'matched', candidates: [{ ...alpha, matchReasons: ['uscc'] }] },
      { key: '1', status: 'matched', candidates: [{ ...alpha, matchReasons: ['name', 'alias'] }] },
      { key: 'alias', status: 'matched', candidates: [{ ...alpha, matchReasons: ['alias'] }] },
      { key: 'agree', status: 'matched', candidates: [{ ...alpha, matchReasons: ['uscc', 'name', 'alias'] }] },
      { key: 'conflict', status: 'ambiguous', candidates: [{ ...beta, matchReasons: ['uscc'] }, { ...alpha, matchReasons: ['name', 'alias'] }] },
      { key: 'same-name', status: 'ambiguous', candidates: [{ ...alpha, matchReasons: ['alias'] }, { ...beta, matchReasons: ['alias'] }] },
      { key: 'uscc-mismatch', status: 'ambiguous', candidates: [{ ...alpha, matchReasons: ['name', 'alias'] }] },
    ] })
  })

  it('excludes removed and merged subjects, unconfirmed aliases and partial names', async () => {
    const response = await post({ rows: [
      { key: 1, name: '已合并', uscc: 'AAAAAAAAAAAAAAAAAA' },
      { key: 2, name: '已移出', uscc: 'BBBBBBBBBBBBBBBBBB' },
      { key: 3, name: '移出别名' }, { key: 4, name: '待核别名' }, { key: 5, name: '撤下别名' },
      { key: 6, name: '正源', uscc: null }, { key: 7, name: '' },
    ] })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ rows: [1, 2, 3, 4, 5, 6, 7].map(key => ({
      key, status: 'unmatched', candidates: [],
    })) })
  })

  it.each([
    { rows: [] },
    { rows: Array.from({ length: 201 }, (_, key) => ({ key, name: '企业' })) },
    { rows: [{ key: 'same', name: '甲' }, { key: 'same', name: '乙' }] },
    { rows: [{ key: false, name: '企业' }] },
    { rows: [{ key: 1, uscc: null }] },
    { rows: [{ key: 1, name: '企业', uscc: 123 }] },
    { rows: [{ key: 1, name: '企业\u0000' }] },
  ])('returns 400 for invalid batch %#', async body => {
    expect((await post(body)).status).toBe(400)
  })
})
