// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import FileDisplayNameEditor from '../../../components/files/FileDisplayNameEditor.vue'
import type { StoredFileRow } from '../../../server/utils/stored-files'

const mounted: ReturnType<typeof mount>[] = []

function file(): StoredFileRow {
  return {
    id: 41,
    relPath: 'jxj/announcement/2024/1/original-notice.pdf',
    displayName: 'original-notice.pdf',
    filename: 'original-notice.pdf',
    ext: 'pdf',
    bytes: 123,
    sha256: 'a'.repeat(64),
    source: 'jxj',
    kind: 'announcement',
    year: 2024,
    batch: 1,
    titleCode: null,
    categoryState: 'set',
    parseState: 'unparsed',
    createdAt: '2026-10-17T00:00:00.000Z',
    removedAt: null,
    referenceCount: 1,
    parts: [],
  }
}

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  document.body.innerHTML = ''
})

describe('文件管理文件信息内的显示名称编辑', () => {
  it('只读展示磁盘文件名与路径,并提交修订后的用户可见名称', async () => {
    const wrapper = mount(FileDisplayNameEditor, {
      attachTo: document.body,
      props: { open: true, file: file() },
    })
    mounted.push(wrapper)
    await flushPromises()

    await wrapper.get('button[data-slot="accordion-trigger"]').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('original-notice.pdf')
    expect(document.body.textContent).toContain('jxj/announcement/2024/1/original-notice.pdf')
    const input = document.body.querySelector<HTMLInputElement>('[data-testid="file-display-name-input"]')!
    expect(input.value).toBe('original-notice.pdf')
    input.value = '公告附件-可见名称.pdf'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()
    document.body.querySelector<HTMLButtonElement>('[data-testid="save-file-display-name"]')!.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('save')).toEqual([['公告附件-可见名称.pdf']])
    expect(input.value).toBe('公告附件-可见名称.pdf')
  })

  it('未修改名称时不允许提交', async () => {
    const wrapper = mount(FileDisplayNameEditor, {
      attachTo: document.body,
      props: { open: true, file: file() },
    })
    mounted.push(wrapper)
    await flushPromises()

    expect(document.body.querySelector<HTMLButtonElement>('[data-testid="save-file-display-name"]')?.disabled).toBe(true)
    expect(wrapper.emitted('save')).toBeUndefined()
  })
})
