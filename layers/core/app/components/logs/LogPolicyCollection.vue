<script setup lang="ts">
import { ref } from 'vue'
import DisclosurePanel from '#core/app/components/DisclosurePanel.vue'
import { iconForIntegration } from './logIcons'
import LogModuleRow from './LogModuleRow.vue'
import type { CollectionRow, IntegrationEntry } from './logPolicy'
import type { LogCollectionSection } from './useLogCollectionPresentation'

defineProps<{
  sections: LogCollectionSection[]
  unwiredIntegrations: readonly IntegrationEntry[]
  busy: boolean
  supported: boolean
}>()

// The index owns which module drawer is open. All edits belong to the shared policy draft.
const activeKey = ref<string | null>(null)
const moduleKey = (row: CollectionRow) => row.prefix + ':' + row.key
function setActiveModule(key: string, open: boolean) {
  if (open) activeKey.value = key
  else if (activeKey.value === key) activeKey.value = null
}
</script>

<template>
  <template v-if="supported">
    <section
      v-for="section in sections"
      :key="section.key"
      :data-testid="section.testid"
      :aria-labelledby="section.headingId"
      class="flex min-w-0 flex-col gap-3"
    >
      <div class="bg-secondary flex min-w-0 items-start gap-2.5 rounded-md px-3 py-2.5">
        <span class="text-primary mt-0.5 inline-flex size-[18px] shrink-0 items-center justify-center">
          <Icon :name="section.icon" class="size-[18px]" aria-hidden="true" />
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <div class="flex min-w-0 items-center justify-between gap-2">
            <h2 :id="section.headingId" class="text-sm font-medium">{{ section.title }}</h2>
            <span class="text-muted-foreground shrink-0 text-[12px] leading-4 tabular-nums">
              {{ section.groups.reduce((sum, group) => sum + group.rows.length, 0) }} 项
            </span>
          </div>
          <p v-if="section.description" class="text-muted-foreground text-table leading-5">
            {{ section.description }}
          </p>
        </div>
      </div>
      <div
        v-for="group in section.groups"
        :key="group.key"
        :data-testid="group.testid"
        class="flex min-w-0 flex-col gap-1.5"
      >
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-1">
          <span class="text-muted-foreground inline-flex size-4 shrink-0 items-center justify-center">
            <Icon :name="group.icon" class="size-4" aria-hidden="true" />
          </span>
          <h3 class="text-muted-foreground text-table leading-5 font-medium">{{ group.title }}</h3>
          <span v-if="group.note" class="text-muted-foreground text-[12px] leading-4">{{ group.note }}</span>
          <span class="text-muted-foreground ml-auto shrink-0 text-[12px] leading-4 tabular-nums">{{ group.rows.length }}</span>
        </div>
        <div class="flex min-w-0 flex-col gap-0.5">
          <LogModuleRow
            v-for="entry in group.rows"
            :key="entry.row.key"
            v-bind="entry"
            :disabled="busy"
            :open="activeKey === moduleKey(entry.row)"
            @update:open="(open) => setActiveModule(moduleKey(entry.row), open)"
          />
        </div>
      </div>
      <DisclosurePanel
        v-if="section.key === 'technical' && unwiredIntegrations.length"
        data-testid="log-unwired-integrations"
        :title="'未接入的技术集成（' + unwiredIntegrations.length + '）'"
        description="未接入，不可配置"
        :heading-level="3"
        compact
        trigger-class="hover:bg-accent hover:no-underline"
      >
        <template #chevron>
          <span
            class="text-muted-foreground pointer-events-none inline-flex size-4 shrink-0 items-center justify-center"
            aria-hidden="true"
          >
            <Icon name="lucide:chevron-right" class="size-4" />
          </span>
        </template>
        <p class="text-muted-foreground text-table leading-5">
          以下库尚未接入日志采集，列在这里只表示当前没有采集器，不能据此判断业务或部署已关闭。
        </p>
        <ul class="mt-2 flex flex-col gap-1.5 text-table">
          <li
            v-for="row in unwiredIntegrations"
            :key="row.key"
            class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5"
          >
            <span class="text-muted-foreground inline-flex size-4 shrink-0 items-center justify-center">
              <Icon :name="iconForIntegration(row.key)" class="size-4" aria-hidden="true" />
            </span>
            <span>{{ row.label }}</span>
            <span class="text-muted-foreground font-mono text-xs">{{ row.key }}</span>
            <span class="text-muted-foreground">未接入，不可配置</span>
          </li>
        </ul>
      </DisclosurePanel>
    </section>
  </template>
</template>
