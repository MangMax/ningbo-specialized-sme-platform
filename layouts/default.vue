<script setup lang="ts">
import AppSidebar from '@/components/AppSidebar.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'

const route = useRoute()

const PAGE_TITLES: Record<string, string> = {
  '/': '台账',
  '/stats': '统计概览',
  '/quality': '数据质量',
}

const pageTitle = computed(() => {
  if (route.path.startsWith('/enterprises/')) return '企业详情'
  return PAGE_TITLES[route.path] ?? '专精特新企业称号台账'
})
const isHome = computed(() => route.path === '/')
</script>

<template>
  <SidebarProvider>
    <AppSidebar />
    <SidebarInset>
      <header
        class="flex h-16 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12"
      >
        <div class="flex w-full items-center gap-2 px-4">
          <SidebarTrigger class="-ml-1" />
          <Separator orientation="vertical" class="mr-2 data-[orientation=vertical]:h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <template v-if="!isHome">
                <BreadcrumbItem class="hidden md:block">
                  <BreadcrumbLink as-child>
                    <NuxtLink to="/">台账</NuxtLink>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator class="hidden md:block" />
              </template>
              <BreadcrumbItem>
                <BreadcrumbPage>{{ pageTitle }}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <ThemeToggle class="ml-auto" />
        </div>
      </header>
      <div class="flex flex-1 flex-col gap-4 p-4 md:p-6">
        <div class="mx-auto w-full max-w-7xl">
          <slot />
        </div>
      </div>
    </SidebarInset>
  </SidebarProvider>
</template>
