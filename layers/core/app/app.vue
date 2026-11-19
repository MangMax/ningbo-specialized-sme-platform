<script setup lang="ts">
import 'vue-sonner/style.css'
import { Toaster } from '#core/app/components/ui/sonner'
const colorMode = useAppColorMode()
</script>

<template>
  <div>
    <NuxtRouteAnnouncer />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
    <Toaster :theme="colorMode === 'dark' ? 'dark' : 'light'" position="bottom-right" close-button close-button-aria-label="关闭提示" />
  </div>
</template>
