<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import type { DecisionVersion, ReviewScope } from '~~/lib/roster/evidence-review-ui'
import DecisionVersionDetails from './DecisionVersionDetails.vue'
import TablePagination from '@/components/TablePagination.vue'
import TableFailureState from '@/components/TableFailureState.vue'
import { Button } from '@/components/ui/button'
import { reviewTimeLabel, titleLabel, directionLabel } from '~~/lib/roster/review-display'

const props = defineProps<{ scope: ReviewScope }>()
const page = shallowRef(1), pageSize = shallowRef(25), selected = shallowRef<number | null>(null)
const previousVersion = shallowRef<DecisionVersion>()
watch(() => JSON.stringify(props.scope), () => { page.value = 1; selected.value = null; previousVersion.value = undefined })
const { data, isLoading, error, refetch } = useQuery({
  key: () => ['decision-history', props.scope, page.value, pageSize.value],
  query: async ({ entry }) => {
    const query = { ...entry.key[1] as ReviewScope, page: entry.key[2] as number, pageSize: entry.key[3] as number }
    return { ...await $fetch<{ rows: Pick<DecisionVersion, 'id' | 'recordedAt' | 'status'>[]; total: number; page: number; pageSize: number }>('/api/roster/decision-lifecycle/history', { query }), scope: query }
  },
})
const previous = shallowRef<typeof data.value>()
watch(data, v => { if (v) previous.value = v }, { immediate: true, flush: 'sync' })
const displayed = computed(() => data.value ?? previous.value)
const { data: version, isLoading: versionLoading, error: versionError, refetch: reloadVersion } = useQuery({
  key: () => ['decision-version', selected.value], enabled: () => selected.value != null,
  query: ({ entry }) => $fetch<DecisionVersion>(`/api/roster/decision-lifecycle/${entry.key[1]}`),
})
watch(version, v => { if (v && selected.value != null) previousVersion.value = v }, { immediate: true, flush: 'sync' })
const displayedVersion = computed(() => selected.value == null ? undefined : version.value ?? previousVersion.value)
const empty = computed(() => displayed.value != null && !isLoading.value && !error.value && displayed.value.total === 0)
</script>

<template>
  <section class="flex min-w-0 flex-col gap-2" aria-label="决定历史">
    <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h4 class="text-sm font-medium">决定历史</h4>
      <span class="text-muted-foreground text-[13px]">
        {{ titleLabel(scope.titleCode) }} · {{ directionLabel(scope.direction) }}
      </span>
    </div>

    <div v-if="isLoading" class="flex flex-col gap-1.5" role="status" aria-label="正在读取决定历史">
      <span class="bg-muted h-4 w-48 animate-pulse rounded-sm" />
      <span class="bg-muted h-4 w-40 animate-pulse rounded-sm" />
    </div>
    <TableFailureState
      v-if="error"
      title="决定历史读取失败"
      :description="`读取目标：${titleLabel(scope.titleCode)} · ${directionLabel(scope.direction)} · 第 ${displayed?.page ?? page} 页。上次成功结果仍保留。`"
      :pending="isLoading"
      @retry="refetch()"
    />

    <p v-if="empty" class="text-muted-foreground text-[13px] leading-5">暂无决定历史。</p>

    <ul v-if="displayed?.rows.length" class="flex flex-col divide-y rounded-md border">
      <li v-for="row in displayed.rows" :key="row.id" class="flex min-w-0 items-center justify-between gap-2 px-3 py-2">
        <span class="min-w-0 text-[13px] leading-5">
          决定 #{{ row.id }}
          <span class="text-muted-foreground"> · {{ reviewTimeLabel(row.recordedAt) }}</span>
        </span>
        <Button
          size="sm"
          variant="ghost"
          :aria-label="`查看历史决定 ${row.id}`"
          @click="selected = row.id"
        >
          查看原文
        </Button>
      </li>
    </ul>

    <p v-if="versionLoading" role="status" class="text-muted-foreground text-[13px]">正在读取历史决定原文…</p>
    <TableFailureState
      v-if="versionError"
      title="历史决定原文读取失败"
      :description="`读取目标：历史决定 #${selected}。上次读取的结果仍保留。`"
      :pending="versionLoading"
      @retry="reloadVersion()"
    />
    <p v-if="displayedVersion && displayedVersion.id !== selected" class="text-muted-foreground text-[13px]">
      显示来源：历史决定 #{{ displayedVersion.id }}；读取目标：历史决定 #{{ selected }}。
    </p>
    <div v-if="displayedVersion" class="rounded-md border bg-card p-3">
      <DecisionVersionDetails :decision="displayedVersion" label="历史决定" />
    </div>

    <TablePagination
      v-if="displayed"
      :page="displayed.page"
      :page-size="displayed.pageSize"
      :total="displayed.total"
      unit="个版本"
      :loading="isLoading || !!error"
      @update:page="page = $event"
      @update:page-size="pageSize = Math.min(50, $event); page = 1"
    />
  </section>
</template>
