import { describe, expect, it } from 'vitest'
import { formatBytes } from '../../../layers/core/lib/core/file-size'
import type { PreviousUpload } from '../../../layers/core/lib/upload-transport'
import type { UploadMetadata } from '../../../layers/sme-roster/lib/upload'
import { MAX_SIZE, TUS_ENDPOINT, baseName, formatEta, isFilenameSafe, targetsEndpoint, toUploadFailure } from '../../../layers/core/lib/upload-transport'
import { buildMetadata, isBatchComplete, landingPath, matchPreviousUpload, metadataPayload, resumeKey, suggestBatch, validateBatch } from '../../../layers/sme-roster/lib/upload'

/**
 * 上传的**模型层**单测:只测规则本身(文件名推导、落位路径、续传匹配、错误翻译),
 * 不测 tus 协议 —— 协议端到端在 `tests/tus.test.ts`(服务端那一侧)里。
 *
 * 断言的口径全部对着 `lib/file-store-scope.ts` 的目录规则与 `server/utils/tus.ts` 的白名单,
 * 这两处是客户端声明的**唯一依据**。
 */

/** 测试里当成「当前站点」用的 origin;端点检查靠它区分同源与跨源。 */
const ORIGIN = 'http://localhost:3480'

/** 造一条完整声明,少写重复。 */
function meta(over: Partial<UploadMetadata> = {}): UploadMetadata {
  return {
    source: 'jxj',
    kind: 'announcement',
    year: '2024',
    batch: '1',
    filename: '甬经信中小〔2024〕72号.pdf',
    ...over,
  }
}

/** 造一条 `tus-js-client` 存下来的历史条目。 */
function previous(over: Partial<PreviousUpload> = {}): PreviousUpload {
  return {
    size: 10,
    metadata: { source: 'jxj', kind: 'announcement', year: '2024', batch: '1', filename: 'a.pdf' },
    creationTime: '2026-10-14T00:00:00.000Z',
    urlStorageKey: 'tus::x::1',
    uploadUrl: `${TUS_ENDPOINT}/abc`,
    parallelUploadUrls: null,
    ...over,
  }
}

describe('suggestBatch(从文件名推导)', () => {
  it('导出表由扩展名定来源与类别(xlsx 只从工信部来)', () => {
    expect(suggestBatch('创新型中小企业导出Excel.xlsx')).toMatchObject({
      source: 'miit',
      kind: 'export',
    })
  })

  it('不按扩展名猜类别:经信局的公布文件也可能是 xlsx,没有把握的项留空', () => {
    const suggestion = suggestBatch('甬经信中小〔2021〕160号关于公布名单的通知.doc')
    expect(suggestion.source).toBeUndefined()
    expect(suggestion.kind).toBeUndefined()
  })

  it('取文件名里第一个四位年份', () => {
    expect(suggestBatch('甬经信中小〔2024〕72号通知.pdf').year).toBe('2024')
  })

  it('中文数字批次:第一批 → 1,第十二批 → 12', () => {
    expect(suggestBatch('…第一批公布名单.pdf').batch).toBe('1')
    expect(suggestBatch('…第十二批公布名单.pdf').batch).toBe('12')
  })

  it('阿拉伯数字批次', () => {
    expect(suggestBatch('…第10批.pdf').batch).toBe('10')
  })

  it('年份区间 2021-2022 只取到第一个年份,不把范围当单值', () => {
    expect(
      suggestBatch('甬经信中小〔2021〕160号关于公布2021-2022入库培育名单的通知.pdf').year,
    ).toBe('2021')
  })

  it('解析不出批次就不填(纯通知类文件)', () => {
    expect(suggestBatch('关于公布名单的通知.pdf').batch).toBeUndefined()
  })
})

describe('landingPath(落位路径,与服务端 landingSegments 同一规则)', () => {
  it('完整五段', () => {
    expect(landingPath(meta())).toBe('jxj/announcement/2024/1/甬经信中小〔2024〕72号.pdf')
  })

  it('导出表无年份无批次,只落三段', () => {
    expect(
      landingPath(
        meta({ source: 'miit', kind: 'export', year: '', batch: '', filename: '导出Excel.xlsx' }),
      ),
    ).toBe('miit/export/导出Excel.xlsx')
  })

  it('只有年份、无批次时省略批次段', () => {
    expect(landingPath(meta({ year: '2021', batch: '', filename: 'a.pdf' }))).toBe(
      'jxj/announcement/2021/a.pdf',
    )
  })

  it('只取文件名最后一段,不把路径带进去', () => {
    expect(landingPath(meta({ filename: '/etc/passwd' }))).toBe('jxj/announcement/2024/1/passwd')
  })
})

describe('metadataPayload(发出去的 Upload-Metadata)', () => {
  it('空的年份/批次不发送该键,而不是发空串', () => {
    const payload = metadataPayload(meta({ year: '', batch: '' }))
    expect(payload).toEqual({
      source: 'jxj',
      kind: 'announcement',
      filename: '甬经信中小〔2024〕72号.pdf',
    })
    expect('year' in payload).toBe(false)
    expect('batch' in payload).toBe(false)
  })

  it('填了年份批次就带上', () => {
    expect(metadataPayload(meta())).toMatchObject({ year: '2024', batch: '1' })
  })
})

describe('buildMetadata', () => {
  it('把一批文件的声明与该文件的文件名拼成完整声明', () => {
    expect(
      buildMetadata(
        { source: 'miit', kind: 'export', year: '', batch: '' },
        '创新型中小企业导出Excel.xlsx',
      ),
    ).toEqual({
      source: 'miit',
      kind: 'export',
      year: '',
      batch: '',
      filename: '创新型中小企业导出Excel.xlsx',
    })
  })

  it('文件名去掉路径段', () => {
    expect(
      buildMetadata({ source: 'jxj', kind: 'export', year: '', batch: '' }, 'a/b/c.xlsx').filename,
    ).toBe('c.xlsx')
  })
})

describe('baseName', () => {
  it('两种分隔符都取最后一段', () => {
    expect(baseName('a/b/c.pdf')).toBe('c.pdf')
    expect(baseName('a\\b\\c.pdf')).toBe('c.pdf')
    expect(baseName('c.pdf')).toBe('c.pdf')
  })
})

describe('isBatchComplete / validateBatch', () => {
  it('两项必需声明齐了才算完整', () => {
    expect(isBatchComplete({ source: '', kind: '', year: '', batch: '' })).toBe(false)
    expect(isBatchComplete({ source: 'jxj', kind: '', year: '', batch: '' })).toBe(false)
    expect(isBatchComplete({ source: 'jxj', kind: 'export', year: '', batch: '' })).toBe(true)
  })

  it('年份不是四位就报错', () => {
    expect(validateBatch({ source: 'jxj', kind: 'export', year: '24', batch: '' })).toContain(
      '年份要四位数字',
    )
  })

  it('批次没有年份就报错', () => {
    expect(validateBatch({ source: 'jxj', kind: 'export', year: '', batch: '1' })).toContain(
      '填了批次就要同时填年份',
    )
  })

  it('合法的组合没有任何问题', () => {
    expect(validateBatch({ source: 'jxj', kind: 'announcement', year: '2024', batch: '1' })).toEqual(
      [],
    )
  })
})

describe('isFilenameSafe(与服务端 isSafeFilename 同口径)', () => {
  it('放行正常的中文文件名(含文号、书名号)', () => {
    expect(isFilenameSafe('甬经信中小〔2024〕72号关于公布名单的通知.pdf')).toBe(true)
    expect(isFilenameSafe('创新型中小企业导出Excel.xlsx')).toBe(true)
  })

  it('挡住路径分隔符、.. 与空名', () => {
    for (const bad of ['../../etc/passwd', 'a/b.pdf', 'a\\b.pdf', '..', '', '   ']) {
      expect(isFilenameSafe(bad), bad).toBe(false)
    }
  })
})

describe('resumeKey(断点续传的匹配键)', () => {
  const file = { name: 'a.pdf', size: 10 }

  it('落位声明变了,键就变 —— 不同格子不能续到同一个上传上', () => {
    const keyOf = (over: Partial<UploadMetadata>) => resumeKey(file, meta(over))
    expect(keyOf({})).not.toBe(keyOf({ batch: '2' }))
    expect(keyOf({})).not.toBe(keyOf({ year: '2023' }))
    expect(keyOf({})).not.toBe(keyOf({ kind: 'export' }))
  })

  it('同名不同体不共用键', () => {
    expect(resumeKey({ name: 'a.pdf', size: 10 }, meta())).not.toBe(
      resumeKey({ name: 'a.pdf', size: 11 }, meta()),
    )
  })

  it('同样的文件与声明得到同样的键', () => {
    expect(resumeKey(file, meta())).toBe(resumeKey(file, meta()))
  })
})

describe('matchPreviousUpload(只续真正对得上的那一条)', () => {
  const file = { name: 'a.pdf', size: 10 }

  it('元数据与文件都相符时命中', () => {
    expect(matchPreviousUpload([previous()], file, meta({ filename: 'a.pdf' }))).toBeDefined()
  })

  it('批次改了就**不**续 —— 这是会静默落错目录的那个坑', () => {
    expect(
      matchPreviousUpload([previous()], file, meta({ filename: 'a.pdf', batch: '2' })),
    ).toBeUndefined()
  })

  it('换了一个文件就不续', () => {
    expect(
      matchPreviousUpload([previous()], { name: 'b.pdf', size: 10 }, meta({ filename: 'b.pdf' })),
    ).toBeUndefined()
  })

  it('大小对不上不续', () => {
    expect(
      matchPreviousUpload([previous()], { name: 'a.pdf', size: 999 }, meta({ filename: 'a.pdf' })),
    ).toBeUndefined()
  })

  it('上传地址不在同一端点上不续', () => {
    const foreign = previous({ uploadUrl: 'https://files.example.com/api/uploads/abc' })
    expect(
      matchPreviousUpload([foreign], file, meta({ filename: 'a.pdf' }), TUS_ENDPOINT, ORIGIN),
    ).toBeUndefined()
  })

  it('同源同端点时才续', () => {
    const local = previous({ uploadUrl: `${ORIGIN}${TUS_ENDPOINT}/abc` })
    expect(
      matchPreviousUpload([local], file, meta({ filename: 'a.pdf' }), TUS_ENDPOINT, ORIGIN),
    ).toBeDefined()
  })

  it('有多条能对上时取最新的一条', () => {
    const older = previous({ creationTime: '2026-10-13T00:00:00.000Z', urlStorageKey: 'old' })
    const newer = previous({ creationTime: '2026-10-14T00:00:00.000Z', urlStorageKey: 'new' })
    expect(
      matchPreviousUpload([older, newer], file, meta({ filename: 'a.pdf' }))?.urlStorageKey,
    ).toBe('new')
  })

  it('空历史返回 undefined(当成新上传)', () => {
    expect(matchPreviousUpload([], file, meta({ filename: 'a.pdf' }))).toBeUndefined()
  })
})

describe('targetsEndpoint(上传地址是不是当前这个端点)', () => {
  it('同源同路径的绝对地址通过', () => {
    expect(targetsEndpoint(`${ORIGIN}${TUS_ENDPOINT}/abc`, TUS_ENDPOINT, ORIGIN)).toBe(true)
  })

  it('相对地址也通过', () => {
    expect(targetsEndpoint(`${TUS_ENDPOINT}/abc`, TUS_ENDPOINT, ORIGIN)).toBe(true)
  })

  it('换 host 不通过(路径一样也不行)', () => {
    expect(
      targetsEndpoint(`https://files.example.com${TUS_ENDPOINT}/abc`, TUS_ENDPOINT, ORIGIN),
    ).toBe(false)
  })

  it('同源但换了路径不通过,也不误伤前缀相近的路径', () => {
    expect(targetsEndpoint(`${ORIGIN}/api/uploadsextra/abc`, TUS_ENDPOINT, ORIGIN)).toBe(false)
    expect(targetsEndpoint(`${ORIGIN}/api/other/abc`, TUS_ENDPOINT, ORIGIN)).toBe(false)
  })
})

describe('toUploadFailure(把失败翻译成看得懂的话)', () => {
  /** 造一个 tus-js-client 形状的 DetailedError。 */
  function detailed(status: number, body = '', message = 'tus: unexpected response') {
    return {
      message,
      originalResponse: { getStatus: () => status, getBody: () => body },
    }
  }

  it('400:说元数据不合规,并原样带出服务端指出的那一项', () => {
    const failure = toUploadFailure(detailed(400, 'filename 非法: ../../etc/passwd\n'))
    expect(failure.kind).toBe('invalid')
    expect(failure.message).toContain('不合规')
    expect(failure.detail).toBe('filename 非法: ../../etc/passwd')
  })

  it('400 但服务端没给细节时,给一段自查提示而不是空白', () => {
    expect(toUploadFailure(detailed(400, '')).detail).toContain('四位')
  })

  it('413:说超过上限,并给出上限本身', () => {
    const failure = toUploadFailure(detailed(413))
    expect(failure.kind).toBe('too-large')
    expect(failure.message).toContain(formatBytes(MAX_SIZE))
  })

  it('5xx:当成服务端出错,提示可以重试', () => {
    const failure = toUploadFailure(detailed(503))
    expect(failure.kind).toBe('server')
    expect(failure.detail).toContain('重试')
  })

  it('没有响应 = 网络断:不当成元数据错', () => {
    const failure = toUploadFailure({ message: 'tus: Failed to fetch' })
    expect(failure.kind).toBe('network')
    expect(failure.message).toContain('连接中断')
  })

  it('空错误不炸', () => {
    expect(toUploadFailure(undefined).kind).toBe('network')
    expect(toUploadFailure(null).message.length).toBeGreaterThan(0)
  })
})

describe('formatBytes / formatEta', () => {
  it('按人读的单位显示', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024 * 1.2)).toBe('1.2 MB')
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB')
  })

  it('拿不到的数不显示成乱码', () => {
    expect(formatBytes(Number.NaN)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
  })

  it('剩余时间:不足一分钟按秒,超过按分秒', () => {
    expect(formatEta(30)).toBe('约 30 秒')
    expect(formatEta(80)).toBe('约 1 分 20 秒')
    expect(formatEta(120)).toBe('约 2 分')
    expect(formatEta(0)).toBeUndefined()
  })
})
