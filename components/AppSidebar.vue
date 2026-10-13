<script setup lang="ts">
import type { SidebarProps } from '@/components/ui/sidebar'
import { BookOpenCheck, ChartColumn, Gauge, LayoutList } from '@lucide/vue'
import NavMain from '@/components/NavMain.vue'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'

const props = withDefaults(defineProps<SidebarProps>(), {
  collapsible: 'icon',
})

const nav = [
  { title: '台账', url: '/', icon: LayoutList },
  { title: '统计', url: '/stats', icon: ChartColumn },
  { title: '数据质量', url: '/quality', icon: Gauge },
]
</script>

<template>
  <Sidebar v-bind="props">
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" as-child tooltip="专精特新企业称号台账">
            <NuxtLink to="/">
              <div
                class="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg"
              >
                <BookOpenCheck class="size-4" />
              </div>
              <div class="grid flex-1 text-left text-sm leading-tight">
                <span class="truncate font-medium">专精特新企业称号台账</span>
                <span class="truncate text-xs">宁波市培育名录 · 查阅看板</span>
              </div>
            </NuxtLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>

    <SidebarContent>
      <NavMain :items="nav" />
    </SidebarContent>

    <SidebarFooter>
      <p
        class="text-sidebar-foreground/70 px-2 text-xs leading-relaxed group-data-[collapsible=icon]:hidden"
      >
        只读看板 · 数据来自经信局与工信部公布名单
      </p>
    </SidebarFooter>

    <SidebarRail />
  </Sidebar>
</template>
