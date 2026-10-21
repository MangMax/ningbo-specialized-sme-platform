import { mkdtempSync, readFileSync, rmSync, createWriteStream, open, close, write } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { Writable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { useDb, schema as s } from '../db/client'
import { writeCurrentWorkbook } from '../lib/roster/current-workbook'

vi.mock('node:fs', async importOriginal => {
  const filesystem = await importOriginal<typeof import('node:fs')>()
  return { ...filesystem, createWriteStream: vi.fn(filesystem.createWriteStream) }
})

const fixtures: Array<() => void> = []
afterEach(() => { vi.mocked(createWriteStream).mockReset(); for (const close of fixtures.splice(0)) close() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'current-workbook-146-'))
  const db = useDb({ dbPath: join(dir, 'synthetic.db') })
  fixtures.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, db, file: join(dir, 'workbook.xlsx') }
}
function candidate(db: ReturnType<typeof useDb>, name: string, group: 'eligible' | 'pending' | 'excluded' = 'eligible', uscc = 'SYNTHETIC-' + name) {
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

it('writes an empty four-sheet workbook to an owned file and waits for its close', async () => {
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
  expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['有效企业', '待确认', '排除明细', '口径说明'])
  const headers = ['序号','稳定企业标识','统一社会信用代码','现名','公布名','已确认曾用名','宁波区县','称号','首次认定','最近授予/延续资格依据','复核情况','公布对应情况','备注','可核对依据']
  for (const sheet of workbook.worksheets.slice(0, 3)) {
    expect(sheet.rowCount).toBe(1)
    expect(sheet.getRow(1).values).toEqual([undefined, ...headers])
  }
  expect(result.counts).toEqual({ eligible: 0, pending: 0, excluded: 0 })
  expect(workbook.getWorksheet('口径说明')!.getCell('B7').value).toBe('0')
  expect(workbook.getWorksheet('口径说明')!.getCell('B8').value).toBe('0')
  expect(workbook.getWorksheet('口径说明')!.getCell('B9').value).toBe('0')
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
  const ids = examples.map(([name, group, uscc]) => candidate(db, name, group, uscc))
  const result = await writeCurrentWorkbook(db.$client, 'little_giant', file, () => {})
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file)
  expect(result.counts).toEqual({ eligible: 2, pending: 2, excluded: 1 })
  for (const [group, sheet] of [['eligible', '有效企业'], ['pending', '待确认'], ['excluded', '排除明细']] as const) {
    const indices = examples.map((row, index) => row[1] === group ? index : -1).filter(index => index >= 0)
    const target = workbook.getWorksheet(sheet)!
    expect(target.rowCount).toBe(indices.length + 1)
    for (const [offset, index] of indices.entries()) {
      const row = target.getRow(offset + 2)
      expect(row.getCell(1).value).toBe(String(offset + 1))
      expect(row.getCell(2).value).toBe(String(ids[index]))
      expect(row.getCell(3).value).toBe(examples[index]![2])
      expect(row.getCell(4).value).toBe(examples[index]![0])
      // Nurture is excluded and is not a published designation name.
      expect(row.getCell(5).value).toBe(group === 'excluded' ? null : examples[index]![0])
      expect(row.getCell(14).value).toContain('名单\n原始附件')
      row.eachCell(cell => { expect(cell.type).not.toBe(ExcelJS.ValueType.Formula); expect(typeof cell.value).toBe('string') })
    }
  }
})

it('paces slow filesystem writes across all three groups without collecting a worksheet behind another ZIP entry', async () => {
  const { db, file } = fixture()
  db.transaction(() => {
    for (let index = 0; index < 1200; index++) candidate(db, randomBytes(1536).toString('base64'), (['pending','eligible','excluded'] as const)[index % 3]!, 'SYNTHETIC-' + index)
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
  expect(result.counts).toEqual({ eligible: 400, pending: 400, excluded: 400 })
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file)
  for (const name of ['有效企业', '待确认', '排除明细']) {
    const sheet = workbook.getWorksheet(name)!
    expect(sheet.rowCount).toBe(401)
    expect(sheet.getCell('A401').value).toBe('400')
    expect((sheet.getCell('D401').value as string).length).toBe(2048)
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
  expect(workbook.getWorksheet('有效企业')!.getCell('D2').value).toBe('短写仍完整')
  expect(writes).toBeGreaterThan(100)
  const broken = createWriteStream(file, { fs: { open, write, close(fd, callback) {
    close(fd, error => callback(error ?? new Error('synthetic commit failure')))
  } } })
  vi.mocked(createWriteStream).mockReturnValueOnce(broken)
  await expect(writeCurrentWorkbook(db.$client, 'little_giant', file, () => {})).rejects.toThrow('synthetic commit failure')
  expect(broken.destroyed).toBe(true)
  expect(db.$client.inTransaction).toBe(false)
})

it('accepts the cell character limit and rejects the next character without leaving a read transaction', async () => {
  const { db, file, dir } = fixture()
  const maximum = '字'.repeat(32767)
  candidate(db, maximum, 'eligible', 'SYNTHETIC-LIMIT')
  await writeCurrentWorkbook(db.$client, 'little_giant', file, () => {})
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file)
  expect(workbook.getWorksheet('有效企业')!.getCell('D2').value).toBe(maximum)
  candidate(db, '字'.repeat(32768), 'pending', 'SYNTHETIC-OVER-LIMIT')
  await expect(writeCurrentWorkbook(db.$client, 'little_giant', join(dir, 'overflow.part'), () => {})).rejects.toThrow('32767')
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
