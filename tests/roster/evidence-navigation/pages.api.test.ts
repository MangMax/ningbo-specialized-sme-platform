import { initializeDb } from '../../../db/client'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema, useDb } from '../../../db'
import { getRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-roster-sqlite'
import { evidencePageState } from '../../../layers/sme-roster/lib/roster/evidence-page'
import { minimalPdf } from '../../support/minimal-pdf'
import { executeNativeImport, startRosterApi, type RosterApiServer } from '../imports/fixtures/import-server'

/**
 * RL-10 —— 出处页码补录接口的**真实 HTTP 契约**(`POST /api/roster/evidence/pages`)。
 *
 * 打的是 `layers/sme-roster/server/api/roster/evidence/pages.post.ts` 也在调的**同一份**
 * `handleEvidencePagesRequest`(`tests/helpers/roster-http-server.ts` 起真端口),
 * 不是替身实现 —— 理由见 `tests/helpers/http-fixture.ts` 顶部。
 *
 * 夹具用真形状:`甬经信中小〔2022〕145号` 的**三张分节名单**在库里只留下
 * `(source_file, attachment, list_no)`,于是「序号 6」命中三家完全不同的企业。
 * 本文件钉的就是:**裸序号写不进页码**,而带定位的那一条才写得进、也读得出。
 */

const dir = mkdtempSync(join(tmpdir(), 'spztx-evidence-pages-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'roster.db') })
const filesDir = join(dir, 'files')
const TOKEN = 'evidence-pages-test-token'

const F145 = 'jxj/announcement/2022/甬经信中小〔2022〕145号关于公布宁波市“专精特新”中小企业名单的通知.pdf'
const F_DOCX = 'jxj/announcement/2023/1/关于公布2023年宁波市“专精特新”中小企业名单的通知.docx'
const F_XLSX = 'miit/export/专精特新中小企业导出Excel.xlsx'

/** 三条「序号 6」== 145号 三张分节名单各一条;两条同序号近似名;一条 Excel、一条 Word。 */
const ids: Record<string, number> = {}

function seedEnterprise(key: string, name: string, district: string | null): number {
  const id = db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: null, district })
    .returning({ id: schema.enterprise.id })
    .get().id
  ids[key] = id
  return id
}

function seedEvidence(
  enterpriseId: number,
  sourceFile: string,
  listNo: number | null,
  opts: { attachment?: string | null; page?: number | null; district?: string | null } = {},
): number {
  const recordId = db
    .insert(schema.record)
    .values({ enterpriseId, titleCode: 'specialized_sme', source: 'jxj', district: opts.district ?? null })
    .returning({ id: schema.record.id })
    .get().id
  const eventId = db
    .insert(schema.recordEvent)
    .values({ recordId, eventType: 'award', year: 2022, sortKey: 2022 })
    .returning({ id: schema.recordEvent.id })
    .get().id
  return db
    .insert(schema.recordEvidence)
    .values({
      recordEventId: eventId,
      sourceFile,
      attachment: opts.attachment ?? '附件',
      listNo,
      page: opts.page ?? null,
    })
    .returning({ id: schema.recordEvidence.id })
    .get().id
}

let server: RosterApiServer
const URL_PAGES = () => `${server.baseUrl}/api/roster/evidence/pages`

async function post(body: unknown, token: string | null = TOKEN): Promise<{ status: number; json: any }> {
  const res = await fetch(URL_PAGES(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(async () => {
  // 145号 三张分节名单各出一条「序号 6」—— 真库里这三条都是海曙区,只能靠企业名分开。
  seedEnterprise('peiyuan', '宁波培源股份有限公司', '海曙区')
  seedEnterprise('kaicheng', '宁波开诚生态技术有限公司', '海曙区')
  seedEnterprise('hengte', '宁波恒特汽车零部件有限公司', '海曙区')
  seedEnterprise('lijkTech', '宁波力劲科技有限公司', '北仑区')
  seedEnterprise('lijkMach', '宁波力劲机械有限公司', '北仑区')
  seedEnterprise('docxRow', '宁波某文件公司', '海曙区')
  seedEnterprise('xlsxRow', '宁波某表公司', null)
  // 幂等用例专用:不跟别的用例抢同一行,免得「重跑」断言依赖执行顺序。
  seedEnterprise('idemRow', '宁波幂等测试有限公司', '海曙区')
  seedEnterprise('duplicateRow', '宁波重复页码申领有限公司', '海曙区')
  seedEnterprise('boundary23', '宁波页码边界23页测试有限公司', '海曙区')
  seedEnterprise('boundary24', '宁波页码边界24页测试有限公司', '海曙区')
  seedEnterprise('outOfRange', '宁波页码越界测试有限公司', '海曙区')
  seedEnterprise('unknownCount', '宁波页数未知测试有限公司', '海曙区')

  seedEvidence(ids.peiyuan!, F145, 6, { district: '海曙区' })
  seedEvidence(ids.kaicheng!, F145, 6, { district: '海曙区' })
  seedEvidence(ids.hengte!, F145, 6, { district: '海曙区' })
  seedEvidence(ids.lijkTech!, F145, 65, { district: '北仑区' })
  seedEvidence(ids.lijkMach!, F145, 104, { district: '北仑区' })
  seedEvidence(ids.docxRow!, F_DOCX, 3, { district: '海曙区' })
  seedEvidence(ids.xlsxRow!, F_XLSX, 3)
  seedEvidence(ids.idemRow!, F145, 200, { district: '海曙区' })
  seedEvidence(ids.duplicateRow!, F145, 201, { district: '海曙区' })
  seedEvidence(ids.boundary23!, F145, 202, { district: '海曙区' })
  seedEvidence(ids.boundary24!, F145, 203, { district: '海曙区' })
  seedEvidence(ids.outOfRange!, F145, 204, { district: '海曙区' })
  seedEvidence(ids.unknownCount!, 'synthetic/missing-count.pdf', 205, { district: '海曙区' })

  const sourcePdf = join(filesDir, F145)
  mkdirSync(dirname(sourcePdf), { recursive: true })
  writeFileSync(sourcePdf, minimalPdf({ pages: 23 }))
  server = await startRosterApi({ db, apiToken: TOKEN, filesDir, executeImport: executeNativeImport })
})

afterAll(async () => {
  await server?.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 从**读侧**看这一条出处的页码与三态 —— 断言的是用户能看到的东西,不是库里的裸值。 */
function evidenceOf(enterpriseId: number): { page: number | null; state: string } {
  const detail = getRosterEnterpriseDetail(db, enterpriseId)!
  const row = detail.evidence[0]!
  return { page: row.page, state: evidencePageState(row.sourceFile, row.page) }
}

describe('POST /api/roster/evidence/pages —— 鉴权与方法', () => {
  it('没带 token ⇒ 401,且一行不改', async () => {
    const before = evidenceOf(ids.kaicheng!).page
    const res = await post({ entries: [{ sourceFile: F145, listNo: 6, page: 8, enterpriseId: ids.kaicheng! }] }, null)
    expect(res.status).toBe(401)
    expect(res.json.reason).toBe('token-missing')
    expect(evidenceOf(ids.kaicheng!).page).toBe(before)
  })

  it('token 不匹配 ⇒ 401', async () => {
    const res = await post({ entries: [] }, 'wrong-token')
    expect(res.status).toBe(401)
    expect(res.json.reason).toBe('token-invalid')
  })

  it('GET ⇒ 405(写面只认 POST)', async () => {
    const res = await fetch(URL_PAGES(), { method: 'GET' })
    expect(res.status).toBe(405)
  })

  it('body 形状不对 ⇒ 400 并说清缺什么', async () => {
    expect((await post({})).json.message).toContain('entries')
    expect((await post({ entries: [] })).json.message).toContain('空')
    expect((await post([])).json.message).toContain('JSON 对象')
  })
})

describe('POST /api/roster/evidence/pages —— 分节定位与留空待核', () => {
  it('★ 裸序号(缺定位)一律拒收,并说清 145号 的三张分节名单', async () => {
    const res = await post({ entries: [{ sourceFile: F145, listNo: 6, page: 8 }] })

    expect(res.status).toBe(200)
    expect(res.json.summary).toMatchObject({ requested: 1, assigned: 0, written: 0, pending: 1 })
    expect(res.json.pending[0]).toMatchObject({ reason: 'entry_incomplete', index: 0 })
    expect(res.json.pending[0].detail).toContain('145号')
    // 三条同序号,一条都没动。
    for (const key of ['peiyuan', 'kaicheng', 'hengte']) expect(evidenceOf(ids[key]!).page).toBeNull()
  })

  it('★ 序号 + 企业名 ⇒ 只写到那一家(读数侧看得见第 8 页)', async () => {
    const res = await post({
      entries: [
        {
          sourceFile: F145,
          listNo: 6,
          page: 8,
          enterpriseName: '宁波开诚生态技术有限公司',
          district: '海曙区',
          basis: '人工核对页图:附件二第 6 行',
        },
      ],
    })

    expect(res.json.status).toBe('applied')
    expect(res.json.summary).toMatchObject({ requested: 1, assigned: 1, written: 1, unchanged: 0, pending: 0 })
    expect(res.json.assignments[0]).toMatchObject({ page: 8, previous: null, basis: '人工核对页图:附件二第 6 行' })

    expect(evidenceOf(ids.kaicheng!)).toEqual({ page: 8, state: 'assigned' })
    // 同序号另外两条**一个字没动** —— 这正是「裸序号会写错公司」的反面证据。
    expect(evidenceOf(ids.peiyuan!)).toEqual({ page: null, state: 'pending' })
    expect(evidenceOf(ids.hengte!)).toEqual({ page: null, state: 'pending' })
  })

  it('同序号不同分节、企业名对不上 ⇒ 留空待核,并报出同序号有几条', async () => {
    const res = await post({
      entries: [{ sourceFile: F145, listNo: 6, page: 22, enterpriseName: '宁波并不存在有限公司' }],
    })

    expect(res.json.summary).toMatchObject({ assigned: 0, written: 0, pending: 1 })
    expect(res.json.pending[0]).toMatchObject({ reason: 'no_match', sameListNo: 3 })
    expect(res.json.pending[0].candidateIds).toHaveLength(3)
    expect(res.json.pending[0].detail).toContain('3 条')
    for (const key of ['peiyuan', 'kaicheng', 'hengte']) expect(evidenceOf(ids[key]!).page).not.toBe(99)
  })

  it('同一份文件里的两家近似名各归各(力劲科技 / 力劲机械)', async () => {
    const res = await post({
      entries: [
        { sourceFile: F145, listNo: 65, page: 5, enterpriseName: '宁波力劲科技有限公司' },
        { sourceFile: F145, listNo: 104, page: 14, enterpriseName: '宁波力劲机械有限公司' },
      ],
    })

    expect(res.json.summary).toMatchObject({ assigned: 2, written: 2, pending: 0 })
    expect(evidenceOf(ids.lijkTech!)).toEqual({ page: 5, state: 'assigned' })
    expect(evidenceOf(ids.lijkMach!)).toEqual({ page: 14, state: 'assigned' })
  })

  it('Word / Excel 条目不写页码(这类来源没有可复核的「第 N 页」)', async () => {
    const res = await post({
      entries: [
        { sourceFile: F_DOCX, listNo: 3, page: 7, enterpriseName: '宁波某文件公司' },
        { sourceFile: F_XLSX, listNo: 3, page: 7, enterpriseName: '宁波某表公司' },
      ],
    })

    expect(res.json.summary).toMatchObject({ assigned: 0, written: 0, pending: 2 })
    expect(res.json.pending.map((p: any) => p.reason)).toEqual(['not_page_capable', 'not_page_capable'])
    // 读数侧「本来就没有页」,不是「待核」—— 两句话不一样。
    expect(evidenceOf(ids.docxRow!)).toEqual({ page: null, state: 'unavailable' })
    expect(evidenceOf(ids.xlsxRow!)).toEqual({ page: null, state: 'unavailable' })
  })

  it('page 非法 ⇒ 拒收,不取整也不当成「没有页码」', async () => {
    const res = await post({
      entries: [{ sourceFile: F145, listNo: 6, page: 2.5, enterpriseName: '宁波培源股份有限公司' }],
    })
    expect(res.json.pending[0].reason).toBe('page_invalid')
    expect(evidenceOf(ids.peiyuan!).page).toBeNull()
  })

  it('dryRun 只报结论,一行不改', async () => {
    const before = evidenceOf(ids.peiyuan!).page
    const res = await post({
      dryRun: true,
      entries: [{ sourceFile: F145, listNo: 6, page: 4, enterpriseName: '宁波培源股份有限公司' }],
    })

    expect(res.json.status).toBe('dry_run')
    expect(res.json.summary).toMatchObject({ assigned: 1, written: 0 })
    expect(res.json.assignments[0]).toMatchObject({ page: 4, previous: before })
    expect(evidenceOf(ids.peiyuan!).page).toBe(before)
  })

  it('重跑同一批是空操作:written 归零、unchanged 全中(幂等)', async () => {
    // 自成一段:先写再重放,不依赖别的用例留下的状态。
    const entries = [{ sourceFile: F145, listNo: 200, page: 18, enterpriseName: '宁波幂等测试有限公司' }]
    const first = await post({ entries })
    expect(first.json.summary).toMatchObject({ assigned: 1, written: 1, unchanged: 0 })

    const again = await post({ entries })
    expect(again.json.summary).toMatchObject({ assigned: 1, written: 0, unchanged: 1, pending: 0 })
    expect(evidenceOf(ids.idemRow!)).toEqual({ page: 18, state: 'assigned' })
  })

  it('同一请求的相同 claim 只写一次，重复项计入 unchanged', async () => {
    const entry = {
      sourceFile: F145,
      listNo: 201,
      page: 19,
      enterpriseName: '宁波重复页码申领有限公司',
    }
    const res = await post({ entries: [entry, { ...entry }] })

    expect(res.json.summary).toMatchObject({
      requested: 2,
      assigned: 2,
      written: 1,
      unchanged: 1,
      pending: 0,
    })
    expect(evidenceOf(ids.duplicateRow!)).toEqual({ page: 19, state: 'assigned' })
  })

  it('同一行被两条页码互相矛盾地指向 ⇒ 两条都不写(不留一条没依据的页码)', async () => {
    const res = await post({
      entries: [
        { sourceFile: F145, listNo: 6, page: 21, enterpriseName: '宁波恒特汽车零部件有限公司' },
        { sourceFile: F145, listNo: 6, page: 22, enterpriseName: '宁波恒特汽车零部件有限公司' },
      ],
    })
    expect(res.json.summary).toMatchObject({ assigned: 0, written: 0, pending: 2 })
    expect(res.json.pending.every((p: any) => p.reason === 'ambiguous')).toBe(true)
    expect(evidenceOf(ids.hengte!).page).toBeNull()
  })

  it('核验源 PDF 页数：23 页可写、24 页与 999 页均留空且不写', async () => {
    const page23 = await post({
      entries: [{ sourceFile: F145, listNo: 202, page: 23, enterpriseName: '宁波页码边界23页测试有限公司' }],
    })
    expect(page23.json.summary).toMatchObject({ assigned: 1, written: 1, pending: 0 })
    expect(evidenceOf(ids.boundary23!)).toEqual({ page: 23, state: 'assigned' })

    const page24 = await post({
      entries: [{ sourceFile: F145, listNo: 203, page: 24, enterpriseName: '宁波页码边界24页测试有限公司' }],
    })
    expect(page24.json.summary).toMatchObject({ assigned: 0, written: 0, pending: 1 })
    expect(page24.json.pending[0]).toMatchObject({ reason: 'page_invalid' })
    expect(page24.json.pending[0].detail).toContain('23 页')
    expect(evidenceOf(ids.boundary24!)).toEqual({ page: null, state: 'pending' })

    const entry = {
      sourceFile: F145,
      listNo: 204,
      page: 999,
      enterpriseName: '宁波页码越界测试有限公司',
    }
    const dryRun = await post({ dryRun: true, entries: [entry] })
    expect(dryRun.json.summary).toMatchObject({ assigned: 0, written: 0, pending: 1 })
    expect(dryRun.json.pending[0]).toMatchObject({ reason: 'page_invalid' })
    expect(evidenceOf(ids.outOfRange!)).toEqual({ page: null, state: 'pending' })

    const applied = await post({ entries: [entry] })
    expect(applied.json.summary).toMatchObject({ assigned: 0, written: 0, pending: 1 })
    expect(applied.json.pending[0]).toMatchObject({ reason: 'page_invalid' })
    expect(evidenceOf(ids.outOfRange!)).toEqual({ page: null, state: 'pending' })
  })

  it('源 PDF 页数无法读取时保持 page_count_unknown 待核,不按页图或猜测写入', async () => {
    const res = await post({
      entries: [{ sourceFile: 'synthetic/missing-count.pdf', listNo: 205, page: 1, enterpriseName: '宁波页数未知测试有限公司' }],
    })

    expect(res.json.summary).toMatchObject({ assigned: 0, written: 0, pending: 1 })
    expect(res.json.pending[0]).toMatchObject({ reason: 'page_count_unknown' })
    expect(evidenceOf(ids.unknownCount!)).toEqual({ page: null, state: 'pending' })
  })
})

describe('未配 token 时写入整体关闭(与其它写入口同一条反向默认)', () => {
  it('NUXT_API_TOKEN 未配置 ⇒ 401 no-token-configured,即使请求带了 token', async () => {
    const closed = await startRosterApi({ db, apiToken: null, executeImport: executeNativeImport })
    try {
      const res = await fetch(`${closed.baseUrl}/api/roster/evidence/pages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer anything' },
        body: JSON.stringify({ entries: [{ sourceFile: F145, listNo: 6, page: 8, enterpriseId: ids.kaicheng! }] }),
      })
      expect(res.status).toBe(401)
      expect((await res.json()).reason).toBe('no-token-configured')
    } finally {
      await closed.close()
    }
  })
})
