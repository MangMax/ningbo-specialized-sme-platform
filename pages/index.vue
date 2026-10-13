<script setup lang="ts">
import { useQuery } from '@pinia/colada'

interface Health {
  titles: { code: string; nameZh: string; level: string; rank: number }[]
  recordCount: number
}

// Ticket 01 smoke: fetch the seeded title dictionary through the full stack.
// The arg is cast to string to sidestep vue-tsc's excessive-depth limit on
// Nuxt's typed-route inference for $fetch.
const { data, isLoading, error } = useQuery<Health>({
  key: ['health'],
  query: () => $fetch<Health>('/api/health' as string),
})
</script>

<template>
  <div class="mx-auto max-w-3xl p-8">
    <h1 class="text-2xl font-semibold">专精特新企业称号台账</h1>
    <p class="text-muted-foreground mt-1 text-sm">
      只读查阅看板 · 脚手架自检
    </p>

    <Card v-if="isLoading" class="mt-6">
      <CardContent class="pt-6">加载中…</CardContent>
    </Card>

    <Card v-else-if="error" class="mt-6">
      <CardContent class="pt-6">连接失败:{{ error.message }}</CardContent>
    </Card>

    <Card v-else class="mt-6">
      <CardHeader>
        <CardTitle>称号字典(来自 SQLite)</CardTitle>
      </CardHeader>
      <CardContent class="space-y-2">
        <div
          v-for="t in data?.titles"
          :key="t.code"
          class="flex items-center justify-between border-b py-2 last:border-0"
        >
          <span>{{ t.nameZh }}</span>
          <code class="text-muted-foreground text-xs">{{ t.code }}</code>
        </div>
        <p class="text-muted-foreground pt-2 text-sm">
          当前记录数:{{ data?.recordCount }}
        </p>
      </CardContent>
    </Card>
  </div>
</template>
