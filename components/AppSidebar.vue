<script setup lang="ts">
import type { SidebarProps } from '@/components/ui/sidebar'
import {
  BookOpenCheck,
  CalendarSync,
  ChartColumn,
  FolderOpen,
  Gauge,
  GitCompareArrows,
  LayoutList,
  ScanText,
} from '@lucide/vue'
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

// 名录台账(RL-17 合并后**唯一**的台账入口):一个页面里按「企业 / 企业×称号 / 差异与原因」
// 三种分组看同一份数据。原先并排的「台账」与「企业总表」是两个入口讲同一件事,
// `/roster` 现在只做 302 重定向。
const nav = [
  { title: '名录台账', url: '/', icon: LayoutList },
  { title: '文件管理', url: '/files', icon: FolderOpen },
  // 识别校对:扫描件的逐页 OCR 结果在这里对着页图核对、改、删、导入(票 14 的页面半边)。
  { title: '识别校对', url: '/ocr', icon: ScanText },
  { title: '统计', url: '/stats', icon: ChartColumn },
  { title: '数据质量', url: '/quality', icon: Gauge },
  { title: '比对', url: '/comparison', icon: GitCompareArrows },
  // 年度增量(RL-07):今年这一批来源文件先预览再应用 —— 逐项分类 + 总表增减三栏。
  { title: '年度增量', url: '/annual-update', icon: CalendarSync },
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
              </div>
            </NuxtLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>

    <SidebarContent>
      <NavMain :items="nav" />
    </SidebarContent>

    <SidebarRail />
  </Sidebar>
</template>
