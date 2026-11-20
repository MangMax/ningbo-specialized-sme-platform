<script setup lang="ts">
import { shallowRef, watch } from 'vue'
import { ChevronRight } from '@lucide/vue'
import type { AppNavItem } from '#core/lib/core/module-registry'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#core/app/components/ui/collapsible'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '#core/app/components/ui/sidebar'

const props = defineProps<{
  label?: string
  items: readonly AppNavItem[]
}>()

const route = useRoute()
const { state, isMobile, setOpen, setOpenMobile } = useSidebar()
const expanded = shallowRef<string[]>([])
const isActive = (url: string) =>
  url === '/' ? route.path === '/' : route.path.startsWith(url)

function updateExpanded(title: string, open: boolean) {
  expanded.value = [...expanded.value.filter(value => value !== title), ...(open ? [title] : [])]
}
watch(() => route.path, () => {
  for (const item of props.items) {
    if (item.items?.some(child => isActive(child.url))) updateExpanded(item.title, true)
  }
}, { immediate: true })

function toggleGroup(title: string, open: boolean) {
  if (!isMobile.value && state.value === 'collapsed') {
    setOpen(true)
    updateExpanded(title, true)
  } else {
    updateExpanded(title, open)
  }
}
</script>

<template>
  <SidebarGroup>
    <SidebarGroupLabel v-if="label">{{ label }}</SidebarGroupLabel>
    <SidebarMenu>
      <template v-for="item in items" :key="item.title">
        <Collapsible v-if="item.items" as-child :open="expanded.includes(item.title)" class="group/collapsible" @update:open="toggleGroup(item.title, $event)">
          <SidebarMenuItem>
            <CollapsibleTrigger as-child>
              <SidebarMenuButton :is-active="item.items.some(child => isActive(child.url))" :tooltip="item.title">
                <component :is="item.icon" v-if="item.icon" aria-hidden="true" />
                <span>{{ item.title }}</span>
                <ChevronRight class="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
              </SidebarMenuButton>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub>
                <SidebarMenuSubItem v-for="child in item.items" :key="child.url">
                  <SidebarMenuSubButton as-child :is-active="isActive(child.url)">
                    <NuxtLink :to="child.url" :aria-current="isActive(child.url) ? 'page' : undefined" @click="setOpenMobile(false)">
                      <span>{{ child.title }}</span>
                    </NuxtLink>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              </SidebarMenuSub>
            </CollapsibleContent>
          </SidebarMenuItem>
        </Collapsible>
        <SidebarMenuItem v-else-if="item.url">
          <SidebarMenuButton as-child :is-active="isActive(item.url)" :tooltip="item.title">
            <NuxtLink :to="item.url" :aria-current="isActive(item.url) ? 'page' : undefined" @click="setOpenMobile(false)">
              <component :is="item.icon" v-if="item.icon" aria-hidden="true" />
              <span>{{ item.title }}</span>
            </NuxtLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </template>
    </SidebarMenu>
  </SidebarGroup>
</template>
