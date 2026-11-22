<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { PLATFORM_INTERFACES, PLATFORM_RDJBS } from '#sme-roster/lib/labels'
import type { PlatformQueriesResult, PlatformQueryRow } from '#sme-roster/lib/platform/read'
import { platformFailureForDisplay, platformFieldValue, platformPresentationFields } from '#sme-roster/lib/roster/platform-records'
import DisclosurePanel from '#core/app/components/DisclosurePanel.vue'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import RosterPlatformQueryProvenance from './PlatformQueryProvenance.vue'
import RosterPlatformFieldConflicts from './PlatformFieldConflicts.vue'

const props = defineProps<{ queryId: number }>()
const open = ref(false)
const detail = shallowRef<PlatformQueryRow>()
const visibleFields = computed(() => new Map(detail.value?.relations.map(relation => [
  relation.id,
  platformPresentationFields(relation.rawFields)
    .filter(field => !['qymc', 'tyshxydm', 'rdjb', 'cszt', 'sqsj', 'year', 'whpc'].includes(field.key)),
])))
const pending = ref(false)
const error = ref('')
const controller = new AbortController()
onBeforeUnmount(() => controller.abort())

async function load() {
  if (pending.value) return
  pending.value = true
  error.value = ''
  try {
    const result = await $fetch<PlatformQueriesResult>('/api/platform/queries', {
      query: { queryId: props.queryId, view: 'full' }, signal: controller.signal, retry: 0,
    })
    const row = result.rows[0]
    if (row?.query.id !== props.queryId || row.relationsIncluded === false) {
      error.value = '查询记录已变化，请重试。'
      return
    }
    detail.value = row
  } catch (cause) {
    if (!controller.signal.aborted) {
      const message = cause instanceof Error ? cause.message : String(cause)
      error.value = platformFailureForDisplay(message) ?? '暂时无法读取查询记录。'
    }
  } finally {
    pending.value = false
  }
}

function toggle(value: boolean) {
  open.value = value
  if (value && !detail.value && !error.value) void load()
}
</script>

<template>
  <DisclosurePanel title="查看查询记录" :open="open" :heading-level="2" keep-mounted padded @update:open="toggle">
    <div class="flex min-w-0 flex-col gap-3 px-3" :aria-busy="pending">
      <p v-if="pending" role="status" class="text-muted-foreground text-xs">正在加载查询记录…</p>
      <TableFailureState v-if="error" title="查询记录加载失败" :description="error" :pending="pending" compact @retry="load" />
      <template v-if="detail">
        <p class="text-muted-foreground text-xs">{{ PLATFORM_INTERFACES[detail.query.interface] }} · {{ detail.query.relationCount }} 条记录</p>
        <RosterPlatformQueryProvenance :queries="[detail.query]" :source-label="PLATFORM_INTERFACES[detail.query.interface] ?? '平台查询'" />
        <p v-if="!detail.relations.length" class="text-muted-foreground text-sm">本次查询没有保存业务记录。</p>
        <article v-for="relation in detail.relations" :key="relation.id" class="min-w-0 rounded-md border p-3 break-words [overflow-wrap:anywhere]" :data-relation-id="relation.id">
          <p class="font-medium">{{ relation.nameRaw ?? '企业名称未提供' }}</p>
          <p class="text-muted-foreground text-xs">记录 #{{ relation.id }} · 原行 {{ relation.sequenceNo }} · 来源页 {{ platformFieldValue(relation.sourcePage) }}</p>
          <RosterPlatformFieldConflicts :conflicts="relation.normalizationConflicts" />
          <dl class="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt class="text-muted-foreground">业务编号</dt><dd>{{ platformFieldValue(relation.relationKey) }}</dd>
            <dt class="text-muted-foreground">信用代码</dt><dd>{{ platformFieldValue(relation.usccRaw) }}</dd>
            <dt class="text-muted-foreground">来源称号</dt><dd>{{ PLATFORM_RDJBS[platformFieldValue(relation.sourceRdjb)] ?? '未标注' }}</dd>
            <template v-if="relation.status != null"><dt class="text-muted-foreground">办理状态</dt><dd>{{ platformFieldValue(relation.status) }}</dd></template>
            <template v-if="relation.appliedAt"><dt class="text-muted-foreground">申报时间</dt><dd>{{ relation.appliedAt }}</dd></template>
            <template v-if="relation.year != null"><dt class="text-muted-foreground">平台年份</dt><dd>{{ relation.year }}</dd></template>
            <template v-if="relation.batch"><dt class="text-muted-foreground">维护批次</dt><dd>{{ relation.batch }}</dd></template>
            <template v-for="field in visibleFields.get(relation.id)" :key="field.key">
              <dt class="text-muted-foreground">{{ field.label }}</dt><dd class="whitespace-pre-wrap">{{ field.value }}</dd>
            </template>
          </dl>
        </article>
      </template>
    </div>
  </DisclosurePanel>
</template>
