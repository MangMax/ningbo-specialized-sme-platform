// @vitest-environment happy-dom
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../layers/core/app/components/ui/tabs'

// Keep DOM semantics real while avoiding Happy DOM's WAAPI cancellation promises.
const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeAll(() => { Reflect.deleteProperty(Element.prototype, 'animate') })
afterAll(() => { if (nativeAnimate) Object.defineProperty(Element.prototype, 'animate', nativeAnimate) })

it('keeps independent tab groups and switches only the keyboard-activated panel', async () => {
  const view = mount(defineComponent({
    components: { Tabs, TabsContent, TabsList, TabsTrigger },
    template: `<div><Tabs v-for="group in ['first', 'second']" :key="group" :id="group" default-value="a">
      <TabsList><TabsTrigger value="a">First</TabsTrigger><TabsTrigger value="b">Second</TabsTrigger><TabsTrigger value="c" disabled>Unavailable</TabsTrigger></TabsList>
      <TabsContent value="a">First panel</TabsContent><TabsContent value="b">Second panel</TabsContent>
    </Tabs></div>`,
  }))
  const first = view.get('#first'), second = view.get('#second')
  await first.findAll('[role="tab"]')[1]!.trigger('keydown', { key: 'Enter' })
  expect(first.get('[role="tabpanel"]').text()).toBe('Second panel')
  expect(second.get('[role="tabpanel"]').text()).toBe('First panel')
  expect(first.findAll('[role="tabpanel"]')).toHaveLength(1)
  expect(first.findAll<HTMLButtonElement>('[role="tab"]')[2]!.element.disabled).toBe(true)
  const selected = first.get('[role="tab"][aria-selected="true"]')
  expect(selected.attributes('aria-controls')).toBe(first.get('[role="tabpanel"]').attributes('id'))
  view.unmount()
})

it('preserves custom panel tags and composes asChild without adding a layout wrapper', () => {
  const view = mount(defineComponent({
    components: { Tabs, TabsContent },
    template: `<div><Tabs default-value="a"><TabsContent value="a" as="section" class="flex">Tagged panel</TabsContent></Tabs>
      <Tabs default-value="a"><TabsContent value="a" as-child><article>Composed panel</article></TabsContent></Tabs></div>`,
  }))
  const panels = view.findAll('[role="tabpanel"]')
  expect(panels[0]!.element.tagName).toBe('SECTION')
  expect(panels[0]!.classes()).toContain('flex')
  expect(panels[1]!.element.tagName).toBe('ARTICLE')
  expect(panels[1]!.text()).toBe('Composed panel')
  view.unmount()
})
