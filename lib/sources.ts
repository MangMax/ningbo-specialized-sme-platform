import { glob } from 'tinyglobby'
import { relative, resolve } from 'node:path'

/**
 * 递归找出某来源目录下的公布文件(.doc/.docx),跳过通知目录与临时文件。
 * 只取文件名含「公布」的文件 —— 通知类的 PDF 不含名单。
 */
export async function discoverAnnouncements(root: string, subdir: string): Promise<string[]> {
  const files = await glob('**/*.{doc,docx}', {
    cwd: resolve(root, subdir),
    ignore: ['**/通知/**', '**/.*', '**/~*'],
    absolute: true,
    onlyFiles: true,
  })
  return files.filter((f) => /公布/.test(f)).sort()
}

/** 数据来源定义:称号代号 → 经信局子目录。 */
export const JXJ_SOURCES = [
  { titleCode: 'specialized_sme', subdir: '经信局名单/省专' },
  { titleCode: 'innovative_sme', subdir: '经信局名单/创新型' },
] as const

export function relPath(root: string, file: string): string {
  return relative(root, file)
}
