<script setup lang="ts">
import type { SidebarProps } from '@/components/ui/sidebar'
import { ChartColumn, FolderOpen, Gauge, GitCompareArrows, LayoutList, ScanText, KeyRound, ListTodo, Search } from '@lucide/vue'
import { ENTERPRISE_LIST_TITLE } from '~~/lib/labels'
import NavMain from '@/components/NavMain.vue'
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'

const props = withDefaults(defineProps<SidebarProps>(), {
  collapsible: 'icon',
})

const colorMode = useAppColorMode()

// 「企业列表」(RL-20 起用名;旧名「名录台账」):一行一家企业,称号历史与差异原因在右侧抽屉。
// 侧边栏入口、页面标题、`document.title` 三处都取 `ENTERPRISE_LIST_TITLE` 一个常量。
// 原先并排的「台账」与「企业总表」早已是同一件事,`/roster` 只做 302 重定向。
const nav = [
  { title: ENTERPRISE_LIST_TITLE, url: '/', icon: LayoutList },
  { title: '优质中小企业查询', url: '/current-enterprises', icon: Search },
  { title: '文件管理', url: '/files', icon: FolderOpen },
  // 识别校对:扫描件的逐页 OCR 结果在这里对着页图核对、改、删、导入(票 14 的页面半边)。
  { title: '识别校对', url: '/ocr', icon: ScanText },
  { title: '统计', url: '/stats', icon: ChartColumn },
  { title: '数据质量', url: '/quality', icon: Gauge },
  { title: '比对', url: '/comparison', icon: GitCompareArrows },
]

const adminNav = [
  { title: '后台任务', url: '/tasks', icon: ListTodo },
  { title: '密钥配置', url: '/settings', icon: KeyRound },
]
</script>

<template>
  <Sidebar v-bind="props">
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="lg"
            as-child
            tooltip="专精特新企业称号台账"
            class="group-data-[collapsible=icon]:justify-center"
          >
            <NuxtLink to="/" aria-label="专精特新企业称号台账，返回企业列表">
              <img
                :src="colorMode === 'dark' ? '/brand/symbol-small-white.svg' : '/brand/symbol-small.svg'"
                alt=""
                width="24"
                height="24"
                class="size-6 shrink-0"
              />
              <span class="truncate text-sm font-medium group-data-[collapsible=icon]:hidden">
                专精特新
              </span>
            </NuxtLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>

    <SidebarContent>
      <NavMain :items="nav" />
      <NavMain label="后台管理" :items="adminNav" class="mt-auto" />
    </SidebarContent>

    <SidebarRail />
  </Sidebar>
</template>
