import { describe, expect, it } from 'vitest'
import { UploadRegistrationError } from '../../../layers/core/server/utils/file-store-contract'
import { parseUploadDeclaration } from '../../../layers/sme-roster/server/modules/sme-roster/file-upload'

describe('parseUploadDeclaration', () => {
  it('只留下声明的五个键,空串当「没填」', () => {
    expect(
      parseUploadDeclaration({
        relPath: 'jxj/announcement/2024/1/a.pdf',
        source: 'jxj',
        kind: 'announcement',
        year: '2024',
        batch: ' 1 ',
      }),
    ).toEqual({
      relPath: 'jxj/announcement/2024/1/a.pdf',
      source: 'jxj',
      kind: 'announcement',
      year: '2024',
      batch: '1',
    })

    expect(
      parseUploadDeclaration({
        relPath: 'jxj/announcement/a.pdf',
        source: '',
        kind: '',
        year: '',
        batch: '',
      }),
    ).toMatchObject({ source: null, kind: null, year: null, batch: null })
  })

  it('缺少 relPath / 不是对象 → 400', () => {
    for (const bad of [null, [], 'x', {}, { relPath: '' }, { relPath: '   ' }]) {
      expect(() => parseUploadDeclaration(bad)).toThrow(UploadRegistrationError)
      expect(() => parseUploadDeclaration(bad)).toThrow()
    }
  })

  it('**不接受**磁盘事实键(大小 / 哈希 / 文件名由服务端从盘上读)', () => {
    for (const key of ['bytes', 'sha256', 'filename', 'ext', 'rel_path']) {
      expect(() => parseUploadDeclaration({ relPath: 'a/b.pdf', [key]: 'x' })).toThrow(
        `不可提交的字段:${key}`,
      )
    }
  })
})
