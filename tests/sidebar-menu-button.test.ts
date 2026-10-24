// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { Sidebar, SidebarMenuButton, SidebarProvider, SidebarTrigger } from '../components/ui/sidebar'

let wrapper: ReturnType<typeof mount> | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function mountSidebar(mobile: boolean, defaultOpen = true) {
  // Only the browser media-query boundary is supplied; Sheet/Tooltip and their
  // focus/dismissal layers are the real components, including their portals.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: mobile && query === '(max-width: 768px)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }))
  wrapper = mount(defineComponent({
    setup: () => () => h(SidebarProvider, { defaultOpen }, () => [
      h(Sidebar, { collapsible: 'icon' }, () =>
        h(SidebarMenuButton, { id: 'menu', tooltip: 'Menu help' }, () => 'Menu')),
      h(SidebarTrigger, { id: 'trigger' }),
    ]),
  }), { attachTo: document.body })
  return wrapper
}

describe('sidebar menu tooltip keyboard behavior', () => {
  it('closes the mobile Sheet on the first Escape after its menu receives focus', async () => {
    const view = mountSidebar(true)
    await nextTick()
    await view.get('#trigger').trigger('click')
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
    const menu = document.querySelector<HTMLButtonElement>('#menu')!
    menu.focus()
    await vi.waitFor(() => expect(document.activeElement).toBe(menu))
    // Let focus-triggered Tooltip updates settle before pressing Escape.
    await flushPromises()
    await nextTick()
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  })

  it('shows help for a focused collapsed desktop menu and removes it when expanded', async () => {
    const view = mountSidebar(false, false)
    const menu = view.get<HTMLButtonElement>('#menu').element
    menu.focus()
    await vi.waitFor(() => {
      const help = document.querySelector('[role="tooltip"]')
      expect(help?.textContent).toBe('Menu help')
      expect(help?.closest('[hidden]')).toBeNull()
    })
    await view.get('#trigger').trigger('click')
    await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeNull())
    // Focusing the same menu in expanded mode must not create help content.
    menu.blur()
    menu.focus()
    await flushPromises()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })
})
