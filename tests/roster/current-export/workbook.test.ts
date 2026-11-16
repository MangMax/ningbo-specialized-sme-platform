import { mkdtempSync, appendFileSync, writeFileSync, readFileSync, rmSync, createWriteStream, open, close, write } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { Writable } from 'node:stream'
import { createHash, randomBytes } from 'node:crypto'
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { initializeDb, schema as s } from '../../../db/client'
import { writeCurrentWorkbook } from '../../../lib/roster/current-workbook'
import { createCurrentQualificationAssessmentReader, readCurrentQualificationAssessment, readCurrentCandidate } from '../../../lib/roster/current-qualification'
import { currentWorkbookValues } from '../../../lib/roster/current-workbook-presentation'
import { readOfficialPublishedPresentation } from '../../../lib/roster/official-published-presentation'

vi.mock('node:fs', async importOriginal => {
  const filesystem = await importOriginal<typeof import('node:fs')>()
  return { ...filesystem, appendFileSync: vi.fn(filesystem.appendFileSync), createWriteStream: vi.fn(filesystem.createWriteStream) }
})

const fixtures: Array<() => void> = []
afterEach(() => { vi.mocked(appendFileSync).mockClear(); vi.mocked(createWriteStream).mockReset(); for (const close of fixtures.splice(0)) close() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'current-workbook-146-'))
  const db = initializeDb({ dbPath: join(dir, 'synthetic.db'), create: true })
  fixtures.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, db, file: join(dir, 'workbook.xlsx') }
}
function candidate(db: ReturnType<typeof initializeDb>, name: string, group: 'eligible' | 'pending' | 'excluded' = 'eligible', uscc = 'SYNTHETIC-' + name) {
  const enterprise = db.insert(s.enterprise).values({ name, nameNorm: name, usccNorm: uscc, district: '鄞州区', city: '宁波市' }).returning().get()
  const record = db.insert(s.record).values({ enterpriseId: enterprise.id, titleCode: 'little_giant', source: 'jxj', nameRaw: name }).returning().get()
  const event = db.insert(s.recordEvent).values({ recordId: record.id, eventType: group === 'excluded' ? 'nurture' : 'award', year: new Date().getFullYear() - (group === 'pending' ? 3 : 0), batchSeq: 1 }).returning().get()
  db.insert(s.recordEvidence).values({ recordEventId: event.id, sourceFile: 'jxj/announcement/synthetic-146.xlsx', attachment: '名单\n原始附件', listNo: enterprise.id }).run()
  return enterprise.id
}

it.each([{ autoDestroy: false }, { emitClose: false }])('rejects non-filename destinations before opening a read transaction %j', async options => {
  expectTypeOf<Parameters<typeof writeCurrentWorkbook>[2]>().toEqualTypeOf<string>()
  const { db } = fixture()
  const sink = new Writable({ ...options, write(_chunk, _encoding, callback) { callback() } })
  const operation = writeCurrentWorkbook(db.$client, 'little_giant', sink as never, () => {}).then(result => ({ result }), error => ({ error }))
  let timer: ReturnType<typeof setTimeout>
  try {
    const outcome = await Promise.race([operation, new Promise(resolve => { timer = setTimeout(() => resolve('pending after finish'), 200) })])
    expect(outcome).toEqual({ error: expect.any(TypeError) })
    expect(db.$client.inTransaction).toBe(false)
  } finally {
    clearTimeout(timer!)
    // Release the old implementation after a failed regression assertion.
    sink.emit('close')
    await operation
    sink.destroy()
  }
})

it('writes an empty six-sheet workbook to an owned file and waits for its close', async () => {
  const { db, file } = fixture()
  const sink = createWriteStream(file, { highWaterMark: 1 })
  await once(sink, 'open')
  fixtures.unshift(() => sink.destroy())
  vi.mocked(createWriteStream).mockReturnValueOnce(sink)
  const result = await writeCurrentWorkbook(db.$client, 'little_giant', file, () => {})
  expect(sink.writableFinished).toBe(true)
  expect(sink.closed).toBe(true)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(readFileSync(file) as any)
  expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['有效企业', '已到期', '已注销（吊销）', '已迁出', '未认定', '口径说明'])
  const headers = ['序号','企业名称','统一社会信用代码','区县','称号','首次认定年份','认定及复核情况','公布名称','已确认曾用名','公布对应情况','情况说明','来源及页码','有效状态','有效期及排除依据','资料缺口与来源备注']
  for (const sheet of workbook.worksheets.slice(0, 5)) {
    expect(sheet.rowCount).toBe(1)
    expect(sheet.getRow(1).values).toEqual([undefined, ...headers])
  }
  expect(result.counts).toEqual({ eligible: 0, pending: 0, excluded: 0 })
  expect(result.statusCounts).toEqual({effective:0,expired:0,terminated:0,moved_out:0,unrecognized:0})
  const explanation = workbook.getWorksheet('口径说明')!
  expect(explanation.getCell('B4').value).toBe('0')
  expect(explanation.getCell('B5').value).toBe('0')
  expect(explanation.getCell('B6').value).toBe('0')
  expect(explanation.getCell('A2').value).toBe('生成时间')
  expect(explanation.getCell('A3').value).toBe('范围')
  expect(db.$client.inTransaction).toBe(false)
})

it('preserves text identities, Chinese newlines, formula-looking strings and group ordering through the original reader', async () => {
  const { db, file } = fixture()
  const examples = [
    ['=1+1', 'pending', '001234567890123456'],
    ['中文企业\n第二行😀', 'eligible', '000000000000000001'],
    ['+12345678901234567890', 'excluded', '000000000000000002'],
    ['@SUM(A1)', 'pending', '000000000000000003'],
    ['-1', 'eligible', '000000000000000004'],
  ] as const
  examples.forEach(([name, group, uscc]) => candidate(db, name, group, uscc))
  const result = await writeCurrentWorkbook(db.$client, 'little_giant', file, () => {})
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file)
  expect(result.counts).toEqual({ eligible: 2, pending: 0, excluded: 3 })
  expect(result.statusCounts).toEqual({effective:2,expired:2,terminated:0,moved_out:0,unrecognized:1})
  for (const [group, sheet] of [['eligible', '有效企业'], ['pending', '已到期'], ['excluded', '未认定']] as const) {
    const indices = examples.map((row, index) => row[1] === group ? index : -1).filter(index => index >= 0)
    const target = workbook.getWorksheet(sheet)!
    expect(target.rowCount).toBe(indices.length + 1)
    for (const [offset, index] of indices.entries()) {
      const row = target.getRow(offset + 2)
      expect(row.getCell(1).value).toBe(String(offset + 1))
      expect(row.getCell(2).value).toBe(examples[index]![0])
      expect(row.getCell(3).value).toBe(examples[index]![2])
      expect(row.getCell(4).value).toBe('鄞州区')
      // Nurture is excluded and is not a published designation name.
      if (group === 'excluded') expect(row.getCell(8).value).toBeNull()
      else expect(row.getCell(8).value).toContain('未逐出处核实')
      expect(row.getCell(12).value).toContain('名单\n原始附件')
      row.eachCell(cell => { expect(cell.type).not.toBe(ExcelJS.ValueType.Formula); expect(typeof cell.value).toBe('string') })
    }
  }
})

it('renders recognition and review facts with real source pages and usable sheet layout', async () => {
  const { db, file } = fixture()
  const id = candidate(db, '新名称', 'eligible', '001234567890123456')
  const record = db.select().from(s.record).all().find(record => record.enterpriseId === id)!
  db.update(s.recordEvidence).set({page:9}).run()
  const review = db.insert(s.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2021, batchSeq: 6, decidedYear: 2025, reviewOutcome: 'passed' }).returning().get()
  db.insert(s.recordEvidence).values({recordEventId:review.id,sourceFile:'jxj/announcement/正式公布.pdf',attachment:'附件二·复核名单',page:7,listNo:12}).run()
  await writeCurrentWorkbook(db.$client, 'little_giant', file, () => {})
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file)
  const sheet = workbook.getWorksheet('有效企业')!
  expect(sheet.getCell('B2').value).toBe('新名称')
  expect(sheet.getCell('C2').value).toBe('001234567890123456')
  expect(sheet.getCell('C2').type).toBe(ExcelJS.ValueType.String)
  expect(sheet.getCell('G2').value).toContain('2021年第6批原认定批次，2025年复核通过')
  expect(sheet.getCell('L2').value).toContain('《正式公布.pdf》，附件：附件二·复核名单，PDF第7页，名单序号12')
  expect(sheet.getCell('L2').value).toContain('名单序号' + id)
  expect(sheet.getCell('L2').value).not.toContain('PDF第9页')
  expect(sheet.getCell('L2').value).not.toContain('PDF第' + id + '页')
  expect(sheet.getRow(2).height).toBeGreaterThan(26)
  expect(sheet.getCell('L2').alignment?.wrapText).toBe(true)
  expect(sheet.getColumn(2).width).toBeGreaterThan(25)
  expect(sheet.views[0]).toMatchObject({state:'frozen',xSplit:2,ySplit:1})
  expect(sheet.autoFilter).toBe('A1:O2')
})

it('labels each award and review citation with its actual source and distinct document context', async () => {
  const { db, file } = fixture()
  const id = candidate(db, '多次公布主体')
  const record = db.select().from(s.record).all().find(item => item.enterpriseId === id)!
  const first = db.select().from(s.recordEvent).all().find(item => item.recordId === record.id)!
  db.update(s.recordEvent).set({year:2023,batchSeq:1}).run()
  db.update(s.recordEvidence).set({sourceFile:'jxj/announcement/2023/1/名单.xlsx',attachment:'认定名单',listNo:7}).run()
  const later = db.insert(s.recordEvent).values({recordId:record.id,eventType:'review',year:2023,batchSeq:1,decidedYear:new Date().getFullYear(),reviewOutcome:'passed'}).returning().get()
  db.insert(s.recordEvidence).values({recordEventId:later.id,sourceFile:'jxj/announcement/2024/2/名单.xlsx',attachment:'复核名单',listNo:9}).run()
  db.insert(s.recordEvidence).values({recordEventId:later.id,sourceFile:'jxj/announcement/2024/3/名单.xlsx',attachment:'补充复核名单',listNo:10}).run()
  const platform = db.insert(s.record).values({enterpriseId:id,titleCode:'little_giant',source:'miit',nameRaw:'多次公布主体'}).returning().get()
  const snapshot = db.insert(s.recordEvent).values({recordId:platform.id,eventType:'maintain',year:2024}).returning().get()
  db.insert(s.recordEvidence).values({recordEventId:snapshot.id,sourceFile:'miit/export/2024/名单.xlsx',attachment:'平台导出',listNo:11}).run()
  await writeCurrentWorkbook(db.$client,'little_giant',file,()=>{})
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(file)
  const citation = String(workbook.getWorksheet('有效企业')!.getCell('L2').value)
  expect(citation).toContain('2023年第1批认定：宁波经信来源资料\n《名单.xlsx》，附件：认定名单，名单序号7')
  expect(citation).toContain(`2023年第1批原认定批次，${new Date().getFullYear()}年复核通过：宁波经信来源资料\n《名单.xlsx》，附件：复核名单，名单序号9`)
  expect(citation).toContain(`2023年第1批原认定批次，${new Date().getFullYear()}年复核通过：宁波经信来源资料\n《名单.xlsx》，附件：补充复核名单，名单序号10`)
  expect(citation).toContain('平台维护记录：工信部平台导出快照\n《名单.xlsx》，附件：平台导出，名单序号11')
  expect(citation).not.toMatch(/2024年第[23]批《名单\.xlsx》/)
  expect(citation).not.toContain('jxj/announcement/')
  expect(citation).not.toContain('宁波市经信局《名单.xlsx》，附件：平台导出')
  expect(first.id).not.toBe(later.id)
})

it('uses the 2021 review event and full notice filename without treating its 2024/1 archive directory as a batch', async () => {
  const { db, file } = fixture()
  const id = candidate(db, '到期复核主体')
  const record = db.select().from(s.record).all().find(item => item.enterpriseId === id)!
  db.update(s.record).set({titleCode:'specialized_sme'}).run()
  db.update(s.recordEvent).set({year:2021,batchSeq:1}).run()
  db.update(s.recordEvidence).set({sourceFile:'jxj/announcement/2021/1/2021年度第一批认定名单.pdf',attachment:'认定名单',listNo:3}).run()
  const review = db.insert(s.recordEvent).values({recordId:record.id,eventType:'review',year:2021,batchSeq:1,decidedYear:2024,reviewOutcome:'passed'}).returning().get()
  const notice = '甬经信中小〔2024〕143号关于公布2021年度第一批宁波市“专精特新”中小企业到期复核通过企业名单的通知.pdf'
  db.insert(s.recordEvidence).values({recordEventId:review.id,sourceFile:`jxj/announcement/2024/1/${notice}`,attachment:'到期复核通过企业名单',page:12,listNo:87}).run()

  await writeCurrentWorkbook(db.$client,'specialized_sme',file,()=>{})
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(file)
  const row = ['有效企业','已到期'].map(name => workbook.getWorksheet(name)!.getRow(2)).find(row => row.getCell(2).value === '到期复核主体')!
  expect(row.getCell(7).value).toContain('2021年第1批原认定批次，2024年复核通过')
  expect(row.getCell(12).value).toContain(`2021年第1批原认定批次，2024年复核通过：宁波市经信局公布资料\n《${notice}》，附件：到期复核通过企业名单，PDF第12页，名单序号87`)
  expect(row.getCell(12).value).not.toContain(`2024年第1批《${notice}》`)
  expect(row.getCell(12).value).not.toContain('jxj/announcement/2024/1')
})

it('retains migration business reasons while removing arbitrary trace text and server locations', () => {
  const {db} = fixture()
  const id = candidate(db,'迁入资格企业')
  const row = readCurrentCandidate(db.$client,id,'little_giant',new Date().getFullYear())
  row.workbookFacts!.migration.push({awardYear:2024,validFrom:'2024-01-01T00:00:00Z',validUntil:'2027-01-01T00:00:00Z',
    basis:'根据迁入证明，当前资格仍在核验期；platform-relation:17 query:8；/srv/private/sha256:deadbeef；{"queryId":8,"status":"valid"} 尚未核实外地授奖批次；认定/复核顺序未核实',
    publicationScope:'已核对宁波公布名单至2026-10-20；/var/db/internal.json；尚未覆盖外地历史公告'})
  const values = currentWorkbookValues('little_giant',row,1,readOfficialPublishedPresentation(db,row.workbookFacts!.evidence.map(item => ({evidenceId:item.id,eventId:item.eventId}))))
  expect(values[6]).toContain('根据迁入证明，当前资格仍在核验期')
  expect(values[6]).toContain('尚未核实外地授奖批次')
  expect(values[6]).toContain('认定 复核顺序未核实')
  expect(values[10]).toContain('已核对宁波公布名单至 2026-10-20；尚未覆盖外地历史公告')
  expect(values.join(' ')).not.toMatch(/platform-relation|query:8|sha256|\/srv\/|\/var\/|internal\.json|deadbeef|queryId|status|valid/)
})

it('renders distinct known explanation and query coverage states without changing qualification group', () => {
  const {db} = fixture()
  const id = candidate(db,'覆盖状态企业')
  const row = readCurrentCandidate(db.$client,id,'little_giant',new Date().getFullYear())
  row.workbookFacts!.assessments.push(
    {explanationValidity:'valid',queryCoverage:'complete',noRecord:false},
    {explanationValidity:'evidence_changed',queryCoverage:'failed',noRecord:false},
    {explanationValidity:'premise_invalid',queryCoverage:'partial',noRecord:false},
    {explanationValidity:'unknown',queryCoverage:'not_queried',noRecord:false},
    {explanationValidity:'valid',queryCoverage:'complete',noRecord:true},
  )
  const values = currentWorkbookValues('little_giant',row,1,readOfficialPublishedPresentation(db,row.workbookFacts!.evidence.map(item => ({evidenceId:item.id,eventId:item.eventId}))))
  expect(values[10]).toContain('解释依据：适用；查询覆盖：完整')
  expect(values[10]).toContain('解释依据：证据已变化；查询覆盖：查询失败')
  expect(values[10]).toContain('解释依据：适用前提无效；查询覆盖：部分')
  expect(values[10]).toContain('解释依据：未知；查询覆盖：尚未查询')
  expect(values[10]).toContain('解释依据：适用；查询覆盖：完整；已核对范围内无记录')
  expect(row.group).toBe('eligible')
})

it('keeps technical audit values out of every visible workbook cell', async () => {
  const {db,file} = fixture()
  candidate(db,'业务企业')
  const result = await writeCurrentWorkbook(db.$client,'little_giant',file,()=>{})
  expect(result.ruleVersion).toBe('current-roster-116-v12')
  expect(result.dataVersion).toMatch(/^sha256:[a-f0-9]{64}$/)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file)
  expect(workbook.worksheets).toHaveLength(6)
  for (const sheet of workbook.worksheets) {
    expect(sheet.state).toBe('visible')
    sheet.eachRow(row => row.eachCell(cell => {
      const value = String(cell.value ?? '')
      expect(value).not.toMatch(/(?:event|evidence|decision|alias|correspondence|platform-relation|query):\d+|sha256:|current-roster-116-v12|jxj[\\/]announcement[\\/]|\b(?:award|review|passed|failed|evidence_changed)\b/)
      expect(cell.note ?? null).toBeNull()
    }))
  }
})

it('paces slow filesystem writes across effective expired and unrecognized sheets without collecting a worksheet behind another ZIP entry', async () => {
  const { db, file } = fixture()
  db.transaction(() => {
    for (let index = 0; index < 1200; index++) candidate(db, randomBytes(240).toString('base64'), (['pending','eligible','excluded'] as const)[index % 3]!, 'SYNTHETIC-' + index)
  })
  let peakQueued = 0, writes = 0
  const sink = createWriteStream(file, {
    highWaterMark: 1024,
    fs: { open, close, write(fd, buffer, offset, length, position, callback) {
      peakQueued = Math.max(peakQueued, sink.writableLength); writes++
      setTimeout(() => write(fd, buffer, offset, length, position, callback), 2)
    } },
  })
  vi.mocked(createWriteStream).mockReturnValueOnce(sink)
  const progress: number[] = []
  const result = await writeCurrentWorkbook(db.$client, 'little_giant', file, done => progress.push(done))
  expect(sink.writableFinished).toBe(true)
  expect(writes).toBeGreaterThan(20)
  // One row may cross a compressor batch; a slow disk must not queue an entire sheet.
  expect(peakQueued).toBeLessThan(256 * 1024)
  expect(progress).toContain(100)
  expect(progress).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200])
  expect(result.counts).toEqual({ eligible: 400, pending: 0, excluded: 800 })
  expect(result.statusCounts).toEqual({effective:400,expired:400,terminated:0,moved_out:0,unrecognized:400})
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file)
  for (const name of ['有效企业', '已到期', '未认定']) {
    const sheet = workbook.getWorksheet(name)!
    expect(sheet.rowCount).toBe(401)
    expect(sheet.getCell('A401').value).toBe('400')
    expect((sheet.getCell('B401').value as string).length).toBe(320)
  }
}, 30000)

it('survives short filesystem writes and rejects final file close errors', async () => {
  const { db, file } = fixture()
  candidate(db, '短写仍完整')
  let writes = 0
  const sink = createWriteStream(file, { fs: { open, close, write(fd, buffer, offset, length, position, callback) {
    writes++
    write(fd, buffer, offset, Math.min(length, 17), position, callback)
  } } })
  vi.mocked(createWriteStream).mockReturnValueOnce(sink)
  await writeCurrentWorkbook(db.$client, 'little_giant', file, () => {})
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file)
  expect(workbook.getWorksheet('有效企业')!.getCell('B2').value).toBe('短写仍完整')
  expect(writes).toBeGreaterThan(100)
  const broken = createWriteStream(file, { fs: { open, write, close(fd, callback) {
    close(fd, error => callback(error ?? new Error('synthetic commit failure')))
  } } })
  vi.mocked(createWriteStream).mockReturnValueOnce(broken)
  await expect(writeCurrentWorkbook(db.$client, 'little_giant', file, () => {})).rejects.toThrow('synthetic commit failure')
  expect(broken.destroyed).toBe(true)
  expect(db.$client.inTransaction).toBe(false)
})

it('moves overheight text to the full-text appendix and still enforces the cell character limit', async () => {
  const { db, file, dir } = fixture()
  const maximum = '字'.repeat(250)
  candidate(db, maximum, 'eligible', 'SYNTHETIC-LIMIT')
  await writeCurrentWorkbook(db.$client, 'little_giant', file, () => {})
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file)
  expect(workbook.getWorksheet('有效企业')!.getCell('B2').value).toBe(maximum)
  candidate(db, '字'.repeat(32767), 'pending', 'SYNTHETIC-TALL')
  const tall = join(dir, 'tall.part')
  await writeCurrentWorkbook(db.$client, 'little_giant', tall, () => {})
  const parsed = new ExcelJS.Workbook(); await parsed.xlsx.readFile(tall)
  const fullText: string[] = []
  parsed.getWorksheet('长文本全文')!.eachRow((row,n) => { if(n>1 && row.getCell(2).value === 'B2') fullText.push(String(row.getCell(12).value)) })
  expect(fullText.join('')).toBe('字'.repeat(32767))
  const other = fixture()
  candidate(other.db, '字'.repeat(32768), 'pending', 'SYNTHETIC-OVER-LIMIT')
  await expect(writeCurrentWorkbook(other.db.$client, 'little_giant', join(other.dir, 'overflow.part'), () => {})).rejects.toThrow('32767')
  expect(db.$client.inTransaction).toBe(false)
})

it('rejects filesystem write errors and premature file closure instead of reporting a workbook', async () => {
  for (const mode of ['write-error', 'close'] as const) {
    const { db, file } = fixture()
    candidate(db, '失败不能成功')
    const sink = createWriteStream(file, { fs: { open, close, write(_fd, buffer, _offset, length, _position, callback) {
      if (mode === 'write-error') callback(new Error('synthetic disk full'), 0, buffer)
      else { sink.destroy(); callback(null, length, buffer) }
    } } })
    vi.mocked(createWriteStream).mockReturnValueOnce(sink)
    const operation = writeCurrentWorkbook(db.$client, 'little_giant', file, () => {})
    if (mode === 'write-error') await expect(operation).rejects.toThrow('synthetic disk full')
    else await expect(operation).rejects.toMatchObject({ code: 'ERR_STREAM_DESTROYED' })
    expect(sink.destroyed).toBe(true)
    expect(db.$client.inTransaction).toBe(false)
  }
})


it('native workbook digest binds its title scope and actual worksheet text projection', async () => {
  const { db, file } = fixture()
  const id = candidate(db,'D409 literal eligible')
  const result = await writeCurrentWorkbook(db.$client,'little_giant',file,()=>{})
  const at=Date.parse(result.generatedAt)
  const snapshot=nativeWorkbookSnapshot(db,id,at)
  expect(snapshot.titles.map(title=>title.titleCode)).toEqual(['little_giant'])
  const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(file)
  const values=Array.from({length:15},(_,i)=>wb.getWorksheet('有效企业')!.getRow(2).getCell(i+1).value)
  values[13] ??= ''; values[14] ??= ''
  const {titles:_titles,snapshotId,...scope}=snapshot
  const expected=createHash('sha256').update(JSON.stringify(['current-export-assessment-title-v3','enterprise-qualification-740-v5','current-roster-116-v12',new Date(result.generatedAt).getUTCFullYear(),'little_giant'])+'\n')
    .update(JSON.stringify(['effective',id,scope,snapshotId,values])+'\n').digest('hex')
  expect(result.dataVersion).toBe('sha256:'+expected)
  expect(result.counts).toEqual({eligible:1,pending:0,excluded:0})
})


it('native workbook digest hashes mixed groups in sheet order then stable identity order', async () => {
  const {db,file}=fixture()
  // ID order differs from sheet order; two eligible rows also prove within-sheet order.
  const pending=candidate(db,'mixed pending','pending')
  const eligible=candidate(db,'mixed eligible','eligible')
  const excluded=candidate(db,'mixed excluded','excluded')
  const eligibleTail=candidate(db,'mixed eligible tail','eligible')
  const result=await writeCurrentWorkbook(db.$client,'little_giant',file,()=>{})
  expect(result.counts).toEqual({eligible:2,pending:0,excluded:2})
  const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(file)
  const hash=createHash('sha256').update(JSON.stringify(['current-export-assessment-title-v3','enterprise-qualification-740-v5','current-roster-116-v12',new Date(result.generatedAt).getUTCFullYear(),'little_giant'])+'\n')
  for (const [group,sheet,ids] of [['effective','有效企业',[eligible,eligibleTail]],['expired','已到期',[pending]],['unrecognized','未认定',[excluded]]] as const) {
    for (const [index,id] of ids.entries()) {
      const snapshot=nativeWorkbookSnapshot(db,id,Date.parse(result.generatedAt),group !== 'unrecognized')
      expect(snapshot.titles.find(title=>title.titleCode==='little_giant')!.effectiveQualification!.status).toBe(group)
      const {titles:_titles,snapshotId,...scope}=snapshot
      const values=Array.from({length:15},(_,c)=>wb.getWorksheet(sheet)!.getRow(index+2).getCell(c+1).value)
      expect(values[0]).toBe(String(index+1))
      // The writer hashes empty business text as an empty string; XLSX reads blank cells as null.
      values[13] ??= ''; values[14] ??= ''
      hash.update(JSON.stringify([group,id,scope,snapshotId,values])+'\n')
    }
  }
  expect(result.dataVersion).toBe('sha256:'+hash.digest('hex'))
})


it('default native export keeps its title digest and never invokes comparison', async () => {
  const core = await import('../../../lib/roster/platform-comparison')
  const spy = vi.spyOn(core, 'comparePlatformComparison')
  const { db, file } = fixture()
  try {
    const id = candidate(db, '427 default workbook')
    const result = await writeCurrentWorkbook(db.$client, 'little_giant', file, () => {})
    const snapshot = nativeWorkbookSnapshot(db,id,Date.parse(result.generatedAt))
    expect(snapshot.assessmentVersion).toBe('enterprise-qualification-740-v5')
    expect(snapshot.titles.every(t => t.platform.comparison === 'not_established')).toBe(true)
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(file)
    const values = Array.from({ length: 15 }, (_, i) => workbook.getWorksheet('有效企业')!.getRow(2).getCell(i + 1).value)
    values[13] ??= ''; values[14] ??= ''
    const { titles: _titles, snapshotId, ...scope } = snapshot
    const digest = createHash('sha256').update(JSON.stringify(['current-export-assessment-title-v3', 'enterprise-qualification-740-v5', 'current-roster-116-v12', new Date(result.generatedAt).getUTCFullYear(), 'little_giant']) + '\n')
      .update(JSON.stringify(['effective', id, scope, snapshotId, values]) + '\n').digest('hex')
    expect(result.dataVersion).toBe('sha256:' + digest)
    expect(result.counts).toEqual({ eligible: 1, pending: 0, excluded: 0 })
    expect(spy).not.toHaveBeenCalled()
  } finally { spy.mockRestore() }
})

it('publishes long multiple sources without duplicate business identities and reconstructs every source byte', async () => {
  const { db, file } = fixture()
  const id = candidate(db, 'overflow synthetic')
  const record = db.select().from(s.record).get()!
  const event = db.select().from(s.recordEvent).get()!
  const sources = ['首段\n'.repeat(24), '第二来源😀'.repeat(180)]
  for (const [index, attachment] of sources.entries()) db.insert(s.recordEvidence).values({recordEventId:event.id,sourceFile:`jxj/announcement/overflow-${index}.xlsx`,attachment,listNo:index+10}).run()
  const row = readCurrentCandidate(db.$client,id,'little_giant',new Date().getFullYear())
  const expected = currentWorkbookValues('little_giant',row,1,readOfficialPublishedPresentation(db,row.workbookFacts!.evidence.map(item=>({evidenceId:item.id,eventId:item.eventId}))))[11]
  await writeCurrentWorkbook(db.$client,'little_giant',file,()=>{})
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(file)
  const business = workbook.getWorksheet('有效企业')!
  expect(business.rowCount).toBe(2)
  expect(business.getCell('B2').value).toBe('overflow synthetic')
  expect(business.getCell('L2').value).toBe('全文见「长文本全文」：有效企业!L2')
  const appendix = workbook.getWorksheet('长文本全文')!
  const chunks: string[] = []
  appendix.eachRow((r,n)=>{ if(n>1){expect(r.getCell(1).value).toBe('有效企业');expect(r.getCell(2).value).toBe('L2');chunks.push(String(r.getCell(12).value));expect(r.height).toBeLessThanOrEqual(409)} })
  expect(chunks.join('')).toBe(expected)
  expect(chunks.join('')).toContain(sources[0])
  expect(chunks.join('')).toContain(sources[1])
  expect(business.autoFilter).toBe('A1:O2')
  expect(record.enterpriseId).toBe(id)
})

it.each([23,24])('keeps 23 display lines inline and redirects 24 lines at the 409pt boundary (%i)', async lines => {
  const {db,file} = fixture()
  const text = Array.from({length:lines},()=> '界').join('\n')
  candidate(db,text,'eligible','BOUNDARY-TEXT')
  await writeCurrentWorkbook(db.$client,'little_giant',file,()=>{})
  const parsed = new ExcelJS.Workbook(); await parsed.xlsx.readFile(file)
  const sheet = parsed.getWorksheet('有效企业')!
  if(lines===23){expect(sheet.getCell('B2').value).toBe(text);expect(sheet.getRow(2).height).toBe(399);expect(parsed.getWorksheet('长文本全文')).toBeUndefined()}
  else {expect(sheet.getCell('B2').value).toBe('全文见「长文本全文」：有效企业!B2');const chunks:string[]=[];parsed.getWorksheet('长文本全文')!.eachRow((r,n)=>{if(n>1)chunks.push(String(r.getCell(12).value))});expect(chunks.join('')).toBe(text)}
})

/** Independent projection of the full public assessment into the exported title scope. */
function nativeWorkbookSnapshot(db:ReturnType<typeof initializeDb>,id:number,at:number,formal = true) {
  const full=readCurrentQualificationAssessment(db.$client,id,at)
  const {titles:allTitles,snapshotId:_digest,...scope}=full
  const titles=allTitles.filter(title=>title.titleCode==='little_giant')
  // candidate() seeds exactly one event/evidence per enterprise in these digest cases.
  // No stored file, published row, disposition, correspondence or managed input exists.
  const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const evidence = [{ id, eventId: id, sourceFile: 'jxj/announcement/synthetic-146.xlsx', attachment: '名单\n原始附件', listNo: id, page: null }]
  const sourceVersions = [{ evidenceId: id, eventId: id, sourceFile: 'jxj/announcement/synthetic-146.xlsx', storedFileId: null, sha256: null, bytes: null, removedAt: null, capturedRevision: null, capturedSha256: null }]
  const names = formal ? [{ evidenceId: id, availability: 'unknown_legacy', nameKnown: false }] : []
  expect(titles[0]!.versions.sources).toBe(hash([evidence, sourceVersions, names, []]))
  expect(titles[0]!.versions.decisions).toBe(hash([[], [], [], []]))
  return {...scope,titles,snapshotId:createHash('sha256').update(JSON.stringify([scope,titles])).digest('hex')}
}

// Literal layout expectations: appendix width 45 leaves 43 units per line;
// 23 lines fit (399pt), 24 do not (416pt). No layout algorithm oracle.
it.each([
  ['ASCII', 'a'.repeat(990), ['a'.repeat(989), 'a'], [399,42]],
  ['wide', '界'.repeat(495), ['界'.repeat(494), '界'], [399,42]],
  ['astral', '😀'.repeat(495), ['😀'.repeat(494), '😀'], [399,42]],
  ['combining', 'a\u0301'.repeat(330), ['a\u0301'.repeat(329)+'a', '\u0301'], [399,42]],
  ['empty lines', '\n'.repeat(24), ['\n'.repeat(22), '\n\n'], [399,59]],
  ['CRLF', 'a\r\n'.repeat(24)+'z', ['a\n'.repeat(22)+'a\n', '\na\nz'], [399,59]],
  ['multiple parts', 'a'.repeat(2000), ['a'.repeat(989),'a'.repeat(989),'a'.repeat(22)], [399,399,42]],
])('preserves literal overflow chunks addresses parts and heights for %s', async (_label,text,chunks,heights) => {
  vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date('2026-11-16T06:00:00Z'))
  try {
    const {db,file}=fixture(); candidate(db,text,'eligible','LITERAL-LAYOUT')
    candidate(db,'expired source period','pending','LITERAL-EXPIRED')
    candidate(db,'unrecognized source','excluded','LITERAL-UNRECOGNIZED')
    const result=await writeCurrentWorkbook(db.$client,'little_giant',file,()=>{})
    const wb=new ExcelJS.Workbook(); await wb.xlsx.readFile(file)
    expect(wb.getWorksheet('有效企业')!.getCell('B2').value).toBe('全文见「长文本全文」：有效企业!B2')
    const parts:unknown[]=[]
    wb.getWorksheet('长文本全文')!.eachRow((row,n)=>{if(n>1 && row.getCell(2).value==='B2') parts.push([row.getCell(1).value,row.getCell(2).value,row.getCell(3).value,row.getCell(12).value,row.height])})
    const rawParts=vi.mocked(appendFileSync).mock.calls.map(call=>JSON.parse(String(call[1]))).filter(row=>row[0]==='有效企业' && row[1]==='B2')
    const rawChunks=_label==='CRLF' ? ['a\r\n'.repeat(22)+'a\r', '\na\r\nz'] : chunks
    expect(rawParts.map(row=>[row[2],row[11]])).toEqual(rawChunks.map((chunk,i)=>[String(i+1),chunk]))
    expect(parts).toEqual(chunks.map((chunk,i)=>['有效企业','B2',String(i+1),chunk,heights[i]]))
    // Optional external baseline capture/compare includes every cell and height,
    // column widths, full result (including dataVersion), source and period text.
    const control={result,rawParts,sheets:wb.worksheets.map(sheet=>({name:sheet.name,widths:sheet.columns.map(c=>c.width),rows:Array.from({length:sheet.rowCount},(_,i)=>({height:sheet.getRow(i+1).height,cells:Array.from({length:sheet.columnCount},(_,j)=>sheet.getRow(i+1).getCell(j+1).value)}))}))}
    const path=process.env.WORKBOOK_LAYOUT_CONTROL
    if(path){const target=join(path,String(_label)+'.json');if(process.env.CAPTURE_LAYOUT_CONTROL==='1')writeFileSync(target,JSON.stringify(control));else expect(control).toEqual(JSON.parse(readFileSync(target,'utf8')))}
  } finally {vi.useRealTimers()}
})

it('bounds character width inspections for a public long-text workbook without repeated prefix scans', async () => {
  const {db,file}=fixture(); candidate(db,'界'.repeat(1200),'eligible','SCAN-BOUND')
  const original=String.prototype.codePointAt
  let inspections=0
  const spy=vi.spyOn(String.prototype,'codePointAt').mockImplementation(function(this:string,index:number){inspections++;return original.call(this,index)})
  try {
    await writeCurrentWorkbook(db.$client,'little_giant',file,()=>{})
  } finally {spy.mockRestore()}
  // Whole public writer budget, generously covers all source/heading/row passes.
  // Counts actual width operations, not a private layout function's invocations.
  expect(inspections).toBeLessThan(100000)
})
