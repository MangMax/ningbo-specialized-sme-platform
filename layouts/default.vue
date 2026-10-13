<script setup lang="ts">
const route = useRoute()
const links = [
  { to: '/', label: '台账' },
  { to: '/stats', label: '统计' },
  { to: '/quality', label: '数据质量' },
]
const active = (to: string) => (to === '/' ? route.path === '/' : route.path.startsWith(to))
</script>

<template>
  <div class="min-h-screen">
    <header class="border-b">
      <div class="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
        <NuxtLink to="/" class="text-sm font-semibold">专精特新企业称号台账</NuxtLink>
        <nav class="flex items-center gap-1">
          <Button
            v-for="l in links"
            :key="l.to"
            as-child
            :variant="active(l.to) ? 'secondary' : 'ghost'"
            size="sm"
          >
            <NuxtLink :to="l.to">{{ l.label }}</NuxtLink>
          </Button>
        </nav>
      </div>
    </header>
    <main class="mx-auto max-w-6xl px-6 py-6">
      <slot />
    </main>
  </div>
</template>
