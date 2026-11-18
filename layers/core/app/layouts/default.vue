<script setup lang="ts">
import AppSidebar from '#core/app/components/AppSidebar.vue'
import ThemeToggle from '#core/app/components/ThemeToggle.vue'
import { Separator } from '#core/app/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '#core/app/components/ui/sidebar'
</script>

<template>
  <SidebarProvider>
    <AppSidebar />
    <SidebarInset class="min-w-0">
      <header
        class="bg-sidebar sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear"
      >
        <div class="flex w-full items-center gap-3 px-4">
          <SidebarTrigger class="-ml-1" />
          <Separator orientation="vertical" class="data-[orientation=vertical]:h-4" />
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
