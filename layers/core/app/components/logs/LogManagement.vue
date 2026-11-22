<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { LogFilter } from '#core/lib/logging/contract'
import {
  logBrowserHeaders,
  logErrorCode,
  logErrorMessage,
  useLogRead
} from '#core/app/composables/useLogRead'
import TableFailureState from '#core/app/components/TableFailureState.vue'
import { Button } from '#core/app/components/ui/button'
import { Alert, AlertDescription } from '#core/app/components/ui/alert'
import { Separator } from '#core/app/components/ui/separator'
import { Skeleton } from '#core/app/components/ui/skeleton'
import LogPolicyCollection from './LogPolicyCollection.vue'
import LogPolicyRetention from './LogPolicyRetention.vue'
import LogPolicyReviewDialog from './LogPolicyReviewDialog.vue'
import { configPatch, type PolicyView, type Review } from './logPolicy'
import { useLogCollectionDraft } from './useLogCollectionDraft'
import { useLogCollectionPresentation } from './useLogCollectionPresentation'
import { useLogFieldDraft } from './useLogFieldDraft'

const props = defineProps<{ filter: LogFilter }>()
const emit = defineEmits<{ changed: [] }>()
const { data, loading, error, refresh } = useLogRead(ref('policy'), () =>
  $fetch<PolicyView>('/api/logs/policy', { retry: 0, headers: logBrowserHeaders })
)

const days = ref<string | number>(7)
const bytes = ref<string | number>(536870912)
const initialized = ref(false)
const collection = useLogCollectionDraft(data)
const fields = useLogFieldDraft(data)
const { supportsCollection, unwiredIntegrations, changedSources, changedIntegrations } = collection
const { fieldChanges } = fields
const { sections, dirtyCollectionLabels, reviewParentReasons } = useLogCollectionPresentation(collection, fields)

/** 草稿只在首次读取或保存成功后的真实响应上初始化；刷新/失败不覆盖用户编辑。 */
function initializeDrafts(policy: PolicyView) {
  days.value = policy.retentionDays
  bytes.value = policy.maxBytes
  collection.reset(policy.collection)
  fields.reset(policy)
}
watch(data, (value) => {
  if (value && !initialized.value) {
    initializeDrafts(value)
    initialized.value = true
  }
})

const pending = ref(false)
const notice = ref('')
const failure = ref('')
const review = ref<Review | null>(null)
const busy = computed(() => pending.value || loading.value || !!error.value)
const validPolicy = computed(
  () =>
    typeof days.value === 'number' &&
    Number.isInteger(days.value) &&
    days.value >= 1 &&
    days.value <= 365 &&
    typeof bytes.value === 'number' &&
    Number.isInteger(bytes.value) &&
    bytes.value >= 1048576 &&
    bytes.value <= 4294967296
)
const clearAllowed = computed(
  () =>
    !!props.filter.from &&
    !!props.filter.to &&
    !Number.isNaN(Date.parse(props.filter.from)) &&
    !Number.isNaN(Date.parse(props.filter.to)) &&
    Date.parse(props.filter.from) <= Date.parse(props.filter.to)
)

const retentionChanged = computed(
  () => !!data.value && Number(days.value) !== data.value.retentionDays
)
const capacityChanged = computed(
  () => !!data.value && Number(bytes.value) !== data.value.maxBytes
)
const hasChanges = computed(
  () =>
    retentionChanged.value ||
    capacityChanged.value ||
    changedSources.value.length > 0 ||
    changedIntegrations.value.length > 0 ||
    fieldChanges.value.length > 0
)
const dirtyModuleLabels = computed(() => {
  const labels = new Set(dirtyCollectionLabels.value)
  if (retentionChanged.value || capacityChanged.value) labels.add('保留策略')
  return [...labels]
})

/** 对话框关闭后把焦点还给触发它的核对按钮；取消/Escape 不把焦点丢给 body。 */
function dismissReview() {
  review.value = null
  void nextTick(() => {
    const button = document.querySelector(
      '[data-testid="log-policy-review"]'
    ) as HTMLButtonElement | null
    button?.focus()
  })
}
function reviewConfig() {
  if (busy.value || !data.value || !validPolicy.value || !hasChanges.value) return
  review.value = {
    kind: 'config',
    retentionDays: Number(days.value),
    maxBytes: Number(bytes.value),
    retentionChanged: retentionChanged.value,
    capacityChanged: capacityChanged.value,
    sources: changedSources.value,
    integrations: changedIntegrations.value,
    fields: fieldChanges.value
  }
}
function reviewClear() {
  if (!clearAllowed.value || busy.value || !data.value) return
  const { cursor: _cursor, limit: _limit, ...filter } = props.filter
  review.value = { kind: 'clear', filter: { ...filter, from: filter.from!, to: filter.to! } }
}

let active = true
onBeforeUnmount(() => {
  active = false
})
async function confirm() {
  if (!review.value || pending.value) return
  const target = review.value
  pending.value = true
  notice.value = ''
  failure.value = ''
  try {
    if (target.kind === 'config') {
      const result = await $fetch<PolicyView>('/api/logs/policy', {
        method: 'PATCH',
        retry: 0,
        headers: logBrowserHeaders,
        body: configPatch(target)
      })
      if (active) {
        notice.value = '日志配置已保存。'
        // PATCH 成功响应就是真实生效值；先落到草稿，finally 再刷新概览与真实值。
        if (result) {
          initializeDrafts(result)
          initialized.value = true
        } else {
          initialized.value = false
        }
      }
    } else {
      const result = await $fetch<{ deleted: number; hasMore: boolean }>('/api/logs/clear', {
        method: 'POST',
        retry: 0,
        headers: logBrowserHeaders,
        body: { ...target.filter, confirm: true }
      })
      if (active) {
        notice.value = `已确认范围 ${target.filter.from} 至 ${target.filter.to}，筛选 ${JSON.stringify(target.filter)}。本次已清理 ${result.deleted} 条运行日志。${result.hasMore ? '范围内仍有日志；核对后可再次确认清理。' : '本次范围清理已完成。'}业务审计、回执和源文件不受影响。`
        emit('changed')
      }
    }
  } catch (cause) {
    if (active) failure.value = logErrorMessage(logErrorCode(cause))
  } finally {
    if (active) {
      pending.value = false
      review.value = null
      void refresh()
    }
  }
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-5">
    <!-- 范围在 tab 内容里说明一次；保留策略与清理各自带后果，不再重复免责声明。 -->
    <p class="text-muted-foreground text-table leading-5" data-testid="log-settings-scope">
      只影响运行日志，不改动业务审计、回执与源文件。
    </p>
    <!-- 全局保存是唯一提交入口：这里只说明草稿归属，不提供第二个保存按钮。 -->
    <p
      v-if="data"
      data-testid="log-unsaved-summary"
      aria-live="polite"
      class="text-table leading-5"
    >
      <template v-if="pending">正在提交，完成后会用真实响应回填。</template>
      <template v-else-if="dirtyModuleLabels.length"
        >未保存：{{ dirtyModuleLabels.join('、') }}。核对并确认后才会提交；刷新页面不会自动保存。</template
      >
      <template v-else>当前配置与已生效配置相同。</template>
    </p>
    <Skeleton v-if="loading && !data" class="h-24 w-full" aria-label="正在读取日志配置" />
    <TableFailureState
      v-if="error"
      title="日志配置读取失败"
      :description="`${logErrorMessage(error)} ${data ? '保留上次读取的配置；当前状态需重新加载确认。' : ''}`"
      :pending="loading"
      @retry="refresh"
    />
    <template v-if="data">
      <LogPolicyCollection
        :supported="supportsCollection"
        :sections="supportsCollection ? sections : []"
        :unwired-integrations="unwiredIntegrations"
        :busy="busy"
      />
      <Separator v-if="supportsCollection" />
      <LogPolicyRetention
        v-model:days="days"
        v-model:bytes="bytes"
        :data="data"
        :busy="busy"
        :valid-policy="validPolicy"
        :has-changes="hasChanges"
        @review="reviewConfig"
      />
      <Separator />
      <section aria-labelledby="log-clear-heading" class="flex min-w-0 flex-col gap-2">
        <div class="flex flex-col gap-1">
          <h2 id="log-clear-heading" class="text-sm font-medium">范围清理</h2>
          <p class="text-muted-foreground text-table leading-5">
            沿用运行日志中已应用的筛选，只删除运行日志。
          </p>
        </div>
        <div class="flex flex-col items-start gap-2">
          <Button
            variant="destructive"
            :disabled="busy || !clearAllowed"
            @click="reviewClear"
            >清理当前筛选范围</Button
          >
          <p class="text-muted-foreground text-table leading-5">
            请先在筛选中应用明确的开始和结束时间。每次最多清理 1000 条；所有已应用的筛选同时生效。
            业务审计、回执、源文件和任务产物不受影响。
          </p>
        </div>
      </section>
    </template>
    <Alert v-if="notice || failure" :variant="failure ? 'destructive' : 'default'" role="status"
      ><AlertDescription>{{ failure || notice }}</AlertDescription></Alert
    >
    <LogPolicyReviewDialog
      :review="review"
      :data="data"
      :pending="pending"
      :review-parent-reasons="reviewParentReasons"
      @dismiss="dismissReview"
      @cancel="review = null"
      @confirm="confirm"
    />
  </div>
</template>
