<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight } from '@lucide/vue'
import { Button } from '#core/app/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#core/app/components/ui/card'
import { Input } from '#core/app/components/ui/input'

const props = defineProps<{
  groups: readonly { label: string; items: readonly { id: string; label: string }[] }[]
  active?: string
}>()
const search = defineModel<string>({ required: true })
const groups = computed(() => {
  const term = search.value.trim().normalize('NFKC').toLowerCase()
  if (!term) return props.groups
  return props.groups.map(group => ({
    ...group,
    items: group.items.filter(item => `${group.label} ${item.label}`.normalize('NFKC').toLowerCase().includes(term)),
  })).filter(group => group.items.length)
})
</script>

<template>
  <Card class="min-h-0 min-w-0 gap-0 p-0 shadow-none">
    <CardHeader class="shrink-0 gap-3 space-y-0 border-b px-4 py-4">
      <CardTitle as="h2" class="text-base">字典目录</CardTitle>
      <Input id="dictionary-directory-search" v-model="search" type="search" aria-label="搜索字典" placeholder="搜索字典名称" />
    </CardHeader>
    <CardContent class="flex min-h-0 flex-col p-0">
      <nav aria-label="字典目录" class="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain p-2">
        <section v-for="group in groups" :key="group.label" :aria-label="group.label">
          <h3 class="text-muted-foreground px-2 py-1 text-sm font-medium">{{ group.label }}</h3>
          <ul class="flex list-none flex-col gap-0.5 p-0">
            <li v-for="item in group.items" :key="item.id" class="min-w-0">
              <Button as-child :variant="item.id === active ? 'secondary' : 'ghost'"
                class="h-auto min-h-10 w-full justify-between px-2.5 py-2 text-left whitespace-normal">
                <NuxtLink :to="{ path: '/dictionaries', query: { kind: item.id } }" :data-dictionary-link="item.id"
                  :aria-current="item.id === active ? 'page' : undefined">
                  <span class="min-w-0 wrap-anywhere">{{ item.label }}</span>
                  <ChevronRight aria-hidden="true" />
                </NuxtLink>
              </Button>
            </li>
          </ul>
        </section>
        <p v-if="!groups.length" role="status" class="text-muted-foreground px-2 py-3 text-sm">没有匹配的字典</p>
      </nav>
    </CardContent>
  </Card>
</template>
