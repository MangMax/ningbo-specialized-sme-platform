<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { ArrowDown, ArrowUp, Plus, X } from '@lucide/vue'
import { Button } from '#core/app/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import {
  enterpriseLibraryColumnLabels, enterpriseLibrarySortFields,
  type EnterpriseLibrarySort, type EnterpriseLibrarySortField,
} from '#core/lib/core/enterprise-library'

const rules = defineModel<EnterpriseLibrarySort[]>({ required: true })
const unused = computed(() => enterpriseLibrarySortFields.filter(field => rules.value.every(item => item.field !== field)))
const fieldId = (field: EnterpriseLibrarySortField) => `enterprise-sort-${field}`

function focus(id: string) {
  void nextTick(() => document.getElementById(id)?.focus())
}

function add() {
  const field = unused.value[0]
  if (!field) return
  rules.value = [...rules.value, { field, direction: 'asc' }]
  focus(fieldId(field))
}

function setField(index: number, value: unknown) {
  if (typeof value !== 'string' || !unused.value.includes(value as EnterpriseLibrarySortField)) return
  const field = value as EnterpriseLibrarySortField
  rules.value = rules.value.map((item, i) => i === index ? { ...item, field } : item)
  focus(fieldId(field))
}

function setDirection(index: number, value: unknown) {
  if (value !== 'asc' && value !== 'desc') return
  rules.value = rules.value.map((item, i) => i === index ? { ...item, direction: value } : item)
}

function move(index: number, step: -1 | 1) {
  const target = index + step
  const item = rules.value[index]
  const other = rules.value[target]
  if (!item || !other) return
  const next = [...rules.value]
  next[target] = item
  next[index] = other
  rules.value = next
  focus(fieldId(item.field))
}

function remove(index: number) {
  rules.value = rules.value.filter((_, i) => i !== index)
  const next = rules.value[Math.min(index, rules.value.length - 1)]
  focus(next ? fieldId(next.field) : 'add-enterprise-sort-rule')
}
</script>

<template>
  <div class="flex max-w-3xl flex-col gap-3">
    <ol v-if="rules.length" aria-label="排序优先级" class="flex flex-col gap-3">
      <li v-for="(rule, index) in rules" :key="rule.field" class="min-w-0 rounded-md border p-3 @min-[42rem]/enterprise-filters:grid @min-[42rem]/enterprise-filters:grid-cols-[10rem_minmax(0,1fr)] @min-[42rem]/enterprise-filters:items-center @min-[42rem]/enterprise-filters:gap-3 @min-[42rem]/enterprise-filters:py-2">
        <div class="mb-2 flex items-center justify-between gap-2 @min-[42rem]/enterprise-filters:mb-0">
          <span class="text-sm font-medium">第 {{ index + 1 }} 级</span>
          <div class="flex items-center gap-1">
            <Button type="button" variant="ghost" size="icon-sm" :disabled="index === 0"
              :aria-label="`上移第 ${index + 1} 级排序`" @click="move(index, -1)"><ArrowUp aria-hidden="true" /></Button>
            <Button type="button" variant="ghost" size="icon-sm" :disabled="index === rules.length - 1"
              :aria-label="`下移第 ${index + 1} 级排序`" @click="move(index, 1)"><ArrowDown aria-hidden="true" /></Button>
            <Button type="button" variant="ghost" size="icon-sm"
              :aria-label="`移除第 ${index + 1} 级排序`" @click="remove(index)"><X aria-hidden="true" /></Button>
          </div>
        </div>
        <div class="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
          <Select :model-value="rule.field" @update:model-value="setField(index, $event)">
            <SelectTrigger :id="fieldId(rule.field)" class="w-full min-w-0" :aria-label="`第 ${index + 1} 级排序字段`">
              <SelectValue>{{ enterpriseLibraryColumnLabels[rule.field] }}</SelectValue>
            </SelectTrigger>
            <SelectContent class="max-w-(--reka-select-content-available-width)">
              <SelectItem v-for="field in enterpriseLibrarySortFields" :key="field" :value="field"
                :disabled="field !== rule.field && !unused.includes(field)">{{ enterpriseLibraryColumnLabels[field] }}</SelectItem>
            </SelectContent>
          </Select>
          <Select :model-value="rule.direction" @update:model-value="setDirection(index, $event)">
            <SelectTrigger class="w-full min-w-0" :aria-label="`第 ${index + 1} 级排序方向`">
              <SelectValue>{{ rule.direction === 'asc' ? '升序' : '降序' }}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="asc">升序</SelectItem>
              <SelectItem value="desc">降序</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </li>
    </ol>
    <Button id="add-enterprise-sort-rule" type="button" variant="outline" class="self-start" :disabled="!unused.length" @click="add">
      <Plus aria-hidden="true" />添加排序字段
    </Button>
  </div>
</template>
