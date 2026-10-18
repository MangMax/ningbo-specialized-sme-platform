<script setup lang="ts">
import type { SidebarProps } from '@/components/ui/sidebar'
import { ChartColumn, FolderOpen, Gauge, GitCompareArrows, LayoutList, ScanText, KeyRound } from '@lucide/vue'
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
  { title: '文件管理', url: '/files', icon: FolderOpen },
  // 识别校对:扫描件的逐页 OCR 结果在这里对着页图核对、改、删、导入(票 14 的页面半边)。
  { title: '识别校对', url: '/ocr', icon: ScanText },
  { title: '统计', url: '/stats', icon: ChartColumn },
  { title: '数据质量', url: '/quality', icon: Gauge },
  { title: '比对', url: '/comparison', icon: GitCompareArrows },
]

const adminNav = [
  { title: '密钥配置', url: '/settings', icon: KeyRound },
]
</script>

<template>
  <Sidebar v-bind="props">
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" as-child tooltip="宁波专精特新企业称号台账">
            <NuxtLink to="/" aria-label="宁波专精特新企业称号台账，返回企业列表">
              <div
                class="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg"
              >
                <img
                  :src="colorMode === 'dark' ? '/brand/symbol-mono.svg' : '/brand/symbol-white.svg'"
                  alt=""
                  width="32"
                  height="32"
                  class="size-8 shrink-0"
                />
              </div>
              <div class="grid flex-1 text-left text-sm leading-tight">
                <img
                  :src="colorMode === 'dark' ? '/brand/wordmark-white.svg' : '/brand/wordmark.svg'"
                  alt="宁波专精特新"
                  width="168"
                  height="35"
                  class="w-[168px] max-w-none"
                />
              </div>
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
