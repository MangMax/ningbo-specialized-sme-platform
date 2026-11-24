import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 弹窗统一结构契约（DESIGN.md §2.1 / §2.7 / §3）。
 *
 * 与 DetailDrawer 对称，所有业务模态弹窗（表单、详情、确认）必须经由
 * `ModalDialog.vue` 承载，禁止各业务组件直接拼 `<DialogContent>` 导致
 * 头部不固定、关闭按钮贴边、尺寸与边距各自为政。
 */

const rootDir = path.resolve(__dirname, '../../..')
const modalDialogPath = path.join(rootDir, 'layers/core/app/components/ModalDialog.vue')

/** 允许直接使用 `<DialogContent` 的底层原语与全屏透明预览器。 */
const ALLOWED_RAW_DIALOG_CONTENT = new Set([
  'layers/core/app/components/ModalDialog.vue',
  'layers/core/app/components/ui/dialog/DialogContent.vue',
  'layers/core/app/components/ui/dialog/DialogScrollContent.vue',
  'layers/core/app/components/ui/sheet/SheetContent.vue',
  'layers/sme-roster/app/components/EnterpriseDrawer.vue',
  'layers/core/app/components/preview/FilePreviewDialog.vue',
  'layers/core/app/components/files/PdfViewDialog.vue',
  'layers/core/app/components/ocr/OcrCompareDialog.vue',
])

function collectVueFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      results.push(...collectVueFiles(full))
    } else if (entry.endsWith('.vue')) {
      results.push(full)
    }
  }
  return results
}

describe('模态弹窗统一契约', () => {
  it('ModalDialog 统一固定头部、关闭按钮居中、独立滚动主体与投影/圆角 token', () => {
    const source = readFileSync(modalDialogPath, 'utf8')
    expect(source).toContain(':show-close-button="false"')
    expect(source).toContain('rounded-xl')
    expect(source).toContain('shadow-(--shadow-drawer)')
    expect(source).toContain('max-h-[min(85dvh,calc(100dvh-2rem))]')
    expect(source).toContain('overflow-y-auto overscroll-contain')
    expect(source).toContain('aria-label="关闭"')
  })

  it('业务组件不得直接拼裸 DialogContent，须复用 ModalDialog', () => {
    const vueFiles = [
      ...collectVueFiles(path.join(rootDir, 'layers')),
      ...collectVueFiles(path.join(rootDir, 'app')),
    ]
    const violations: string[] = []
    for (const file of vueFiles) {
      const rel = path.relative(rootDir, file).replaceAll(path.sep, '/')
      if (ALLOWED_RAW_DIALOG_CONTENT.has(rel)) continue
      const content = readFileSync(file, 'utf8')
      if (content.includes('<DialogContent')) {
        violations.push(rel)
      }
    }
    expect(violations).toEqual([])
  })
})
