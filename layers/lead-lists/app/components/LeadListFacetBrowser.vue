<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check } from '@lucide/vue'
import { Button } from '#core/app/components/ui/button'
import { Input } from '#core/app/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#core/app/components/ui/tabs'

type FacetKey = 'channel' | 'listType'
type FacetGroup = {
  key: FacetKey
  label: string
  allLabel: string
  total: number
  values: { value: string; label: string; count: number }[]
}

const props = defineProps<{ groups: FacetGroup[]; selected: Record<FacetKey, string> }>()
const group = defineModel<FacetKey>('group', { required: true })
const emit = defineEmits<{ select: [key: FacetKey, value: string] }>()

const search = ref('')
const active = computed(() => props.groups.find(item => item.key === group.value) ?? props.groups[0]!)
const normalize = (value: string) => value.trim().normalize('NFKC').toLowerCase()
const visible = computed(() => {
  const term = normalize(search.value)
  return active.value.values.filter(option => !term || normalize(option.label).includes(term))
})
watch(group, () => { search.value = '' })
</script>

<template>
  <Tabs v-model="group" class="flex min-h-0 min-w-0 flex-1 flex-col gap-0">
    <div class="flex shrink-0 flex-col gap-2 border-b p-3">
      <TabsList class="grid w-full grid-cols-2" aria-label="筛选方式">
        <TabsTrigger v-for="item in groups" :key="item.key" :value="item.key">{{ item.label }}</TabsTrigger>
      </TabsList>
      <Input v-model="search" type="search" :aria-label="`搜索${active.label}`" :placeholder="`搜索${active.label}`" />
    </div>

    <TabsContent
      :key="active.key" :value="active.key"
      class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
    >
      <ul class="flex min-w-0 flex-col gap-0.5" :aria-label="active.label">
        <li>
          <Button
            type="button" :variant="selected[active.key] ? 'ghost' : 'secondary'"
            :aria-pressed="!selected[active.key]"
            class="h-auto min-h-9 w-full min-w-0 justify-start gap-2 px-2 py-1.5"
            @click="emit('select', active.key, '')"
          >
            <span class="min-w-0 flex-1 text-left">{{ active.allLabel }}</span>
            <span class="text-muted-foreground tabular-nums" :aria-label="`${active.total} 份名单`">{{ active.total }}</span>
            <Check v-if="!selected[active.key]" aria-hidden="true" />
          </Button>
        </li>
        <li v-for="option in visible" :key="option.value">
          <Button
            type="button" :variant="selected[active.key] === option.value ? 'secondary' : 'ghost'"
            :aria-pressed="selected[active.key] === option.value"
            class="h-auto min-h-9 w-full min-w-0 justify-start gap-2 px-2 py-1.5 whitespace-normal"
            @click="emit('select', active.key, option.value)"
          >
            <span class="min-w-0 flex-1 text-left wrap-anywhere">{{ option.label }}</span>
            <span class="text-muted-foreground shrink-0 tabular-nums" :aria-label="`${option.count} 份名单`">{{ option.count }}</span>
            <Check v-if="selected[active.key] === option.value" aria-hidden="true" />
          </Button>
        </li>
      </ul>
      <p v-if="!visible.length" role="status" class="text-muted-foreground px-2 py-3 text-sm">没有匹配的{{ active.label }}</p>
    </TabsContent>
  </Tabs>
</template>
