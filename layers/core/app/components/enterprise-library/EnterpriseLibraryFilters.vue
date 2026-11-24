<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { ChevronDown } from '@lucide/vue'
import { Button } from '#core/app/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '#core/app/components/ui/field'
import { Input } from '#core/app/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#core/app/components/ui/collapsible'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#core/app/components/ui/tabs'
import EnterpriseDictionaryCascade from './EnterpriseDictionaryCascade.vue'
import EnterpriseLibrarySortRules from './EnterpriseLibrarySortRules.vue'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import { normalizeReviewedUscc } from '#core/lib/enterprise-uscc'
import {
  enterpriseLibraryColumnLabels, type EnterpriseLibraryFilters, type EnterpriseLibrarySort,
} from '#core/lib/core/enterprise-library'
import type { DictionaryEntry } from '#core/lib/dictionaries'

const props = defineProps<{
  filters: EnterpriseLibraryFilters
  sorts: readonly EnterpriseLibrarySort[]
  regions?: DictionaryEntry[]
  industries?: DictionaryEntry[]
  regionsError: boolean
  industriesError: boolean
}>()
const emit = defineEmits<{
  apply: [filters: EnterpriseLibraryFilters, sorts: EnterpriseLibrarySort[]]
  retryRegions: []
  retryIndustries: []
}>()
const open = ref(false)
const filters = ref<EnterpriseLibraryFilters>({})
const sorts = ref<EnterpriseLibrarySort[]>([])
const tab = ref('filters')
const invalidUscc = ref(false)
const textFields = [
  { key: 'name', label: enterpriseLibraryColumnLabels.name, limit: 500 },
  { key: 'uscc', label: enterpriseLibraryColumnLabels.uscc, limit: 35 },
  { key: 'registeredAddress', label: enterpriseLibraryColumnLabels.registeredAddress, limit: 500 },
  { key: 'operatingAddress', label: enterpriseLibraryColumnLabels.operatingAddress, limit: 500 },
] as const
const region = computed({
  get: () => ({ parent: filters.value.districtCode, child: filters.value.townshipCode }),
  set: value => { filters.value = { ...filters.value, districtCode: value.parent, townshipCode: value.child } },
})
const industry = computed({
  get: () => ({ parent: filters.value.industryDivisionCode, child: filters.value.industryCode }),
  set: value => { filters.value = { ...filters.value, industryDivisionCode: value.parent, industryCode: value.child } },
})

function changeOpen(value: boolean) {
  if (value) {
    filters.value = { ...props.filters }
    sorts.value = props.sorts.map(rule => ({ ...rule }))
    invalidUscc.value = false
  }
  open.value = value
}

function reset() {
  if (tab.value === 'sort') sorts.value = []
  else {
    filters.value = {}
    invalidUscc.value = false
  }
}

function apply() {
  const result = { ...filters.value }
  for (const { key } of textFields) result[key] = result[key]?.trim() || undefined
  if (result.uscc) {
    result.uscc = normalizeReviewedUscc(result.uscc)
    if (!/^[A-Z0-9]{18}$/.test(result.uscc)) {
      invalidUscc.value = true
      tab.value = 'filters'
      void nextTick(() => document.getElementById('enterprise-filter-uscc')?.focus())
      return
    }
  }
  emit('apply', result, sorts.value.map(rule => ({ ...rule })))
  open.value = false
  void nextTick(() => document.getElementById('enterprise-filter-trigger')?.focus({ preventScroll: true }))
}
</script>

<template>
  <Collapsible :open="open" class="flex min-w-0 flex-col" @update:open="changeOpen">
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <slot name="quick-search" />
      <CollapsibleTrigger as-child>
        <Button id="enterprise-filter-trigger" :variant="open ? 'secondary' : 'outline'" type="button" size="sm" class="group shrink-0">
          筛选与排序
          <ChevronDown aria-hidden="true" class="motion-safe:transition-transform ease-snap group-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
    </div>
    <CollapsibleContent>
      <form aria-label="企业筛选与排序" class="mt-3 min-w-0 overflow-hidden rounded-md border bg-card" @submit.prevent="apply">
        <Tabs v-model="tab" class="flex min-w-0 flex-col gap-0">
          <div class="border-b px-3 py-2">
            <TabsList class="grid w-full max-w-56 grid-cols-2" aria-label="企业列表设置">
              <TabsTrigger value="filters">筛选</TabsTrigger>
              <TabsTrigger value="sort">排序</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="filters" class="max-h-[min(38dvh,20rem)] min-w-0 overflow-y-auto overscroll-contain p-3">
            <FieldGroup class="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 @min-[42rem]/enterprise-filters:grid-cols-4">
              <Field v-for="item in textFields" :key="item.key" class="min-w-0 gap-1.5">
                <FieldLabel :for="`enterprise-filter-${item.key}`" class="text-muted-foreground text-xs">{{ item.label }}</FieldLabel>
                <Input
                  :id="`enterprise-filter-${item.key}`" v-model="filters[item.key]" size="sm" :maxlength="item.limit"
                  :aria-invalid="item.key === 'uscc' && invalidUscc ? true : undefined"
                  :aria-describedby="item.key === 'uscc' && invalidUscc ? 'enterprise-filter-uscc-error' : undefined"
                  @update:model-value="item.key === 'uscc' && (invalidUscc = false)"
                />
                <FieldError v-if="item.key === 'uscc' && invalidUscc" id="enterprise-filter-uscc-error" role="alert">请输入完整的 18 位信用代码。</FieldError>
              </Field>
              <TableFailureState v-if="regionsError" class="col-span-full" title="区划字典暂时无法加载" compact @retry="emit('retryRegions')" />
              <TableFailureState v-if="industriesError" class="col-span-full" title="行业字典暂时无法加载" compact @retry="emit('retryIndustries')" />
              <Field class="col-span-full min-w-0 gap-1.5 @min-[30rem]/enterprise-filters:col-span-1">
                <FieldLabel for="enterprise-filter-region" class="text-muted-foreground text-xs">区划</FieldLabel>
                <EnterpriseDictionaryCascade
                  id="enterprise-filter-region" v-model="region" size="sm" label="区划" kind="region" :entries="regions"
                  empty-label="不限" parent-label="按此区县筛选"
                />
              </Field>
              <Field class="col-span-full min-w-0 gap-1.5 @min-[30rem]/enterprise-filters:col-span-1">
                <FieldLabel for="enterprise-filter-industry" class="text-muted-foreground text-xs">行业</FieldLabel>
                <EnterpriseDictionaryCascade
                  id="enterprise-filter-industry" v-model="industry" size="sm" label="行业" kind="industry" :entries="industries"
                  empty-label="不限" parent-label="按此行业大类筛选"
                />
              </Field>
            </FieldGroup>
          </TabsContent>
          <TabsContent value="sort" class="max-h-[min(38dvh,20rem)] min-w-0 overflow-y-auto overscroll-contain p-3">
            <EnterpriseLibrarySortRules v-model="sorts" />
          </TabsContent>
        </Tabs>
        <div class="flex items-center justify-end gap-2 border-t px-3 py-2">
          <Button variant="ghost" size="sm" type="button" @click="reset">{{ tab === 'sort' ? '清除排序' : '清除筛选' }}</Button>
          <Button size="sm" type="submit">应用</Button>
        </div>
      </form>
    </CollapsibleContent>
  </Collapsible>
</template>
