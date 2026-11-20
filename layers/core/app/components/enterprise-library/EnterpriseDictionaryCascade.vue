<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { ArrowLeft, Check, ChevronDown, ChevronRight } from '@lucide/vue'
import { Button } from '#core/app/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '#core/app/components/ui/dropdown-menu'
import type { DictionaryEntry } from '#core/lib/dictionaries'

const props = defineProps<{
  id: string
  label: string
  kind: 'region' | 'industry'
  entries?: readonly DictionaryEntry[]
  parentLabel?: string
  emptyLabel: string
  disabled?: boolean
}>()
const selection = defineModel<{ parent?: string; child?: string }>({ required: true })
const branch = ref<string>()

function parentOf(entry: DictionaryEntry, map: ReadonlyMap<string, DictionaryEntry>) {
  const parent = entry.parentCode
  return props.kind === 'region' ? parent : map.get(parent ?? '')?.parentCode
}

const entriesByCode = computed(() => new Map((props.entries ?? []).map(entry => [entry.code, entry])))
const groups = computed(() => {
  const parents = new Map((props.entries ?? []).filter(entry => entry.level === (props.kind === 'region' ? 2 : 1))
    .map(entry => [entry.code, { entry, children: [] as DictionaryEntry[] }]))
  for (const entry of props.entries ?? []) {
    if (entry.level === 3) {
      const parent = parentOf(entry, entriesByCode.value)
      if (parent) parents.get(parent)?.children.push(entry)
    }
  }
  return parents
})
const activeGroup = computed(() => groups.value.get(branch.value ?? ''))
const selectedParent = computed(() => {
  if (selection.value.parent) return selection.value.parent
  const child = entriesByCode.value.get(selection.value.child ?? '')
  return child ? parentOf(child, entriesByCode.value) : undefined
})
const selectedPath = computed(() => [selectedParent.value, selection.value.child]
  .filter((code): code is string => Boolean(code))
  .map(code => entriesByCode.value.get(code)?.name ?? code).join(' / '))
const itemId = (code: string) => `${props.id}-choice-${code}`

function focus(id: string) {
  void nextTick(() => document.getElementById(id)?.focus())
}

function onOpen(open: boolean) {
  if (open) branch.value = selectedParent.value ?? undefined
}

function enter(event: Event, parent: string) {
  event.preventDefault()
  branch.value = parent
  focus(`${props.id}-back`)
}

function back(event: Event) {
  if (!branch.value) return
  event.preventDefault()
  const parent = branch.value
  branch.value = undefined
  focus(itemId(parent))
}

function choose(parent?: string, child?: string) {
  selection.value = { parent, child }
}
</script>

<template>
  <DropdownMenu :modal="false" @update:open="onOpen">
    <DropdownMenuTrigger as-child>
      <Button
        :id="id" type="button" variant="outline" :aria-label="label" :aria-description="selectedPath || emptyLabel"
        :disabled="disabled || !entries" :title="selectedPath || undefined"
        class="w-full min-w-0 justify-between px-3 font-normal"
      >
        <span class="min-w-0 truncate">{{ selectedPath || emptyLabel }}</span>
        <ChevronDown aria-hidden="true" class="mr-0 size-4 shrink-0 text-muted-foreground" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      align="start" :aria-label="label" :collision-padding="12"
      class="max-h-[min(20rem,var(--reka-dropdown-menu-content-available-height))] w-[min(24rem,calc(100vw-2rem))] min-w-0 overscroll-contain motion-reduce:animate-none"
      @keydown.left="back"
    >
      <template v-if="activeGroup">
        <DropdownMenuItem :id="`${id}-back`" @select="back">
          <ArrowLeft aria-hidden="true" />返回上一级
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel class="wrap-anywhere">{{ activeGroup.entry.name }}</DropdownMenuLabel>
        <DropdownMenuItem
          v-if="parentLabel" :aria-current="selectedParent === activeGroup.entry.code && !selection.child || undefined"
          @select="choose(activeGroup.entry.code)"
        >
          <span class="min-w-0 flex-1 wrap-anywhere">{{ parentLabel }}</span>
          <Check v-if="selectedParent === activeGroup.entry.code && !selection.child" aria-hidden="true" />
        </DropdownMenuItem>
        <DropdownMenuItem
          v-for="entry in activeGroup.children" :key="entry.code" :aria-current="selection.child === entry.code || undefined"
          @select="choose(activeGroup.entry.code, entry.code)"
        >
          <span class="min-w-0 flex-1 wrap-anywhere">{{ kind === 'industry' ? entry.code + ' · ' : '' }}{{ entry.name }}</span>
          <Check v-if="selection.child === entry.code" aria-hidden="true" />
        </DropdownMenuItem>
      </template>
      <template v-else>
        <DropdownMenuItem :aria-current="!selectedPath || undefined" @select="choose()">
          <span class="min-w-0 flex-1">{{ emptyLabel }}</span>
          <Check v-if="!selectedPath" aria-hidden="true" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          v-for="{ entry } in groups.values()" :id="itemId(entry.code)" :key="entry.code"
          @select="enter($event, entry.code)" @keydown.right="enter($event, entry.code)"
        >
          <span class="min-w-0 flex-1 wrap-anywhere">{{ kind === 'industry' ? entry.code + ' · ' : '' }}{{ entry.name }}</span>
          <ChevronRight aria-hidden="true" />
        </DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
