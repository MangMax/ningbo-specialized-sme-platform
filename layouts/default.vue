<script setup lang="ts">
import { useQuery } from '@pinia/colada'
import AppSidebar from '@/components/AppSidebar.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'

interface Stats {
  totalRecords: number
  totalEnterprises: number
}

const apiGet = $fetch as unknown as <T>(url: string) => Promise<T>
const { data: stats } = useQuery({
  key: () => ['stats'],
  query: () => apiGet<Stats>('/api/stats'),
})

const fmt = (n?: number) => (n == null ? '—' : n.toLocaleString('zh-CN'))
</script>

<template>
  <SidebarProvider>
    <AppSidebar />
    <SidebarInset class="min-w-0">
      <!--
        顶栏只放两件事:收起/展开侧栏,以及台账的规模。
        页面标题交给每页自己的 PageHeader,不在顶栏重复一遍。

        这里的 `totalRecords` 是 `/api/stats` 的**记录数**,而它等于**企业 × 称号**数
        (台账的最小行就是「企业 × 称号」,同一组合的两个来源并成一行)。原先写「条记录」,
        与台账页里「7,352 家企业 / 10,501 个企业×称号」两个口径一起出现时会被读成同一个数,
        所以这里把单位写全(RL-17)。
      -->
      <header
        class="bg-sidebar sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear"
      >
        <div class="flex w-full items-center gap-3 px-4">
          <SidebarTrigger class="-ml-1" />
          <Separator orientation="vertical" class="data-[orientation=vertical]:h-4" />
          <span data-global-stats class="text-muted-foreground text-xs tabular-nums">
            共 <span class="text-foreground font-medium">{{ fmt(stats?.totalRecords) }}</span> 个企业×称号
            · <span class="text-foreground font-medium">{{ fmt(stats?.totalEnterprises) }}</span> 家企业
          </span>
          <ThemeToggle class="ml-auto" />
        </div>
      </header>
      <div class="flex flex-1 flex-col gap-5 p-4 md:px-6 md:py-5">
        <div class="mx-auto w-full max-w-[1440px]">
          <slot />
        </div>
      </div>
    </SidebarInset>
  </SidebarProvider>
</template>
