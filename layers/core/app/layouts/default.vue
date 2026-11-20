<script setup lang="ts">
import { watch } from 'vue'
import AppSidebar from '#core/app/components/AppSidebar.vue'
import ThemeToggle from '#core/app/components/ThemeToggle.vue'
import { Separator } from '#core/app/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '#core/app/components/ui/sidebar'

const route = useRoute()
const workspace = useTemplateRef('workspace')
watch(() => route.path, () => workspace.value?.scrollTo({ top: 0, left: 0 }), { flush: 'post' })
</script>

<template>
  <SidebarProvider class="h-dvh min-h-0 overflow-hidden">
    <AppSidebar />
    <SidebarInset class="min-h-0 min-w-0">
      <header
        class="bg-sidebar relative z-30 flex h-14 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear"
      >
        <div class="flex w-full items-center gap-3 px-4">
          <SidebarTrigger class="-ml-1" />
          <Separator orientation="vertical" class="data-[orientation=vertical]:h-4" />
          <ThemeToggle class="ml-auto" />
        </div>
      </header>
      <div
        ref="workspace" data-workspace-scroll role="region" aria-label="页面内容" tabindex="0"
        class="focus-visible:outline-ring flex min-h-0 min-w-0 flex-1 flex-col overflow-auto overscroll-contain p-4 focus-visible:-outline-offset-2 md:px-6 md:py-5"
      >
        <slot />
      </div>
    </SidebarInset>
  </SidebarProvider>
</template>
