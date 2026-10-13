import { describe, expect, it } from 'vitest'
import {
  describeLoadError,
  describeUnsupported,
  extensionOf,
  fileNameOf,
  isLegacyOffice,
  isPreviewable,
  resolvePreviewKind,
} from '../lib/preview'

describe('preview 文件类型解析', () => {
  it('取扩展名时忽略查询串与锚点,并统一小写', () => {
    expect(extensionOf('a/b/通知.DOCX')).toBe('docx')
    expect(extensionOf('/api/files/x.xlsx?t=1')).toBe('xlsx')
    expect(extensionOf('/api/files/x.pdf#page=3')).toBe('pdf')
    expect(extensionOf('noext')).toBe('')
    // 以点开头的隐藏文件不算有扩展名。
    expect(extensionOf('.gitignore')).toBe('')
  })

  it('取文件名时解码百分号编码', () => {
    expect(fileNameOf('a/b/%E9%80%9A%E7%9F%A5.docx')).toBe('通知.docx')
    expect(fileNameOf('/api/files/x.pdf?a=1')).toBe('x.pdf')
    expect(fileNameOf('')).toBe('未命名文件')
  })

  it('把台账里真实出现的四种出处路径解析成对应预览器', () => {
    expect(resolvePreviewKind('经信局名单/省专/2021/01公布文件/甬经信中小〔2021〕160号.docx')?.kind).toBe('docx')
    expect(resolvePreviewKind('工信部名单/专精特新小巨人导出Excel.xlsx')?.kind).toBe('xlsx')
    expect(resolvePreviewKind('汇报/工作汇报.pptx')?.kind).toBe('pptx')
    expect(resolvePreviewKind('经信局名单/省专/2022/00公布文件/通知.pdf')?.kind).toBe('pdf')
    expect(resolvePreviewKind('截图/表格.png')?.kind).toBe('image')
    expect(resolvePreviewKind('照片/扫描.JPEG')?.kind).toBe('image')
  })

  it('xlsm 归到 Excel,svg 归到图片', () => {
    expect(resolvePreviewKind('a.xlsm')?.kind).toBe('xlsx')
    expect(resolvePreviewKind('a.svg')?.kind).toBe('image')
  })

  it('旧版二进制 Office 格式可识别但不可预览', () => {
    for (const ext of ['doc', 'xls', 'ppt']) {
      expect(isLegacyOffice(`通知.${ext}`)).toBe(true)
      expect(isPreviewable(`通知.${ext}`)).toBe(false)
      expect(resolvePreviewKind(`通知.${ext}`)).toBeNull()
    }
  })

  it('未知扩展名与无扩展名都不可预览', () => {
    expect(isPreviewable('a.txt')).toBe(false)
    expect(isPreviewable('README')).toBe(false)
    expect(resolvePreviewKind('a.zip')).toBeNull()
  })

  it('给旧版格式一句说得出原因的提示,而不是笼统的「不支持」', () => {
    const msg = describeUnsupported('通知.doc')
    expect(msg).toContain('DOC')
    expect(msg).toContain('.docx')
    expect(describeUnsupported('a.txt')).toContain('.txt')
    expect(describeUnsupported('README')).toContain('扩展名')
  })
})

describe('describeLoadError 把技术报错翻成人话', () => {
  it('按状态码给可指导下一步的说明', () => {
    expect(describeLoadError(new Error('Failed to fetch: 404 Not Found'))).toContain('文件不存在')
    expect(describeLoadError(new Error('403 Forbidden'))).toContain('权限')
    expect(describeLoadError(new Error('415 Unsupported'))).toContain('预览范围')
    expect(describeLoadError(new Error('500 Internal'))).toContain('文件服务出错')
  })

  it('识别加密与网络故障', () => {
    expect(describeLoadError(new Error('password required'))).toContain('加密')
    expect(describeLoadError(new Error('Failed to fetch'))).toContain('取不到文件')
    expect(describeLoadError(new TypeError('NetworkError when attempting'))).toContain('取不到文件')
  })

  it('认不出来时保留原文,方便排查', () => {
    expect(describeLoadError(new Error('OoxmlResourceLimitError: too big'))).toBe(
      'OoxmlResourceLimitError: too big',
    )
    // 非 Error 也要能处理。
    expect(describeLoadError('boom')).toBe('boom')
  })
})
