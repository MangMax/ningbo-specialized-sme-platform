<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery, useQueryCache } from '@pinia/colada'
import WorkspacePage from '#core/app/components/WorkspacePage.vue'
import EnterpriseBatchSupplementDrawer from '#core/app/components/enterprise-library/EnterpriseBatchSupplementDrawer.vue'
import { Badge } from '#core/app/components/ui/badge'
import { Button } from '#core/app/components/ui/button'
import { Field, FieldError, FieldLabel } from '#core/app/components/ui/field'
import { Textarea } from '#core/app/components/ui/textarea'
import { describeFetchError } from '#core/lib/file-content-status'
import type { BatchSupplementDecision } from '#core/lib/core/enterprise-batch-supplement'
import { announcementSubjectDecisions } from '#sme-roster/lib/announcement-intake-review'
import { titleLabel } from '#sme-roster/lib/roster/review-display'
import { ROSTER_FILES_PATH } from '#sme-roster/lib/sme-roster/routes'
import type {
  RosterAnnouncementIntake, SupplementAnnouncementRequest, SupplementAnnouncementPreflightResult,
  SupplementAnnouncementResult,
} from '#sme-roster/lib/roster-import-client'

type IntakeSummary = {
  id: number
  status: RosterAnnouncementIntake['status']
  sourceName: string
  sourceIdentity: string
  issueDate: string | null
  rowCount: number
}
type IntakeDetail = Pick<RosterAnnouncementIntake, 'intakeId' | 'sourceDigest' | 'status' | 'announcement' | 'officialEvidencePreflightRequired'>

useHead({ title: '公布名单入库' })
const endpoint = '/api/roster/import/intake'
const cache = useQueryCache()
const catalogKey = ['sme-roster', 'announcement-intakes']
const { data, error, isPending, refetch } = useQuery({
  key: catalogKey,
  query: () => $fetch<IntakeSummary[]>(`${endpoint}/browser`),
})
const intakes = computed(() => data.value?.filter(row => row.status !== 'removed') ?? [])
const { data: context, error: contextError, refetch: retryContext } = useQuery({
  key: ['sme-roster', 'browser-context'],
  query: () => $fetch<{ writeEnabled: boolean }>('/api/roster/browser-context'),
})

const detail = ref<IntakeDetail>()
const loadingId = ref<number>()
const loadError = ref('')
const notice = ref('')
const basis = ref('')
const decisions = ref<BatchSupplementDecision[]>([])
const ready = ref(false)
const submitting = ref(false)
const submitError = ref('')
const preview = ref<{ result: SupplementAnnouncementPreflightResult; request: SupplementAnnouncementRequest }>()
const lastAction = ref<'preflight' | 'commit'>('preflight')

const drawerRows = computed(() => detail.value?.announcement.records.map((row, index) => {
  const eventSummaries = row.events?.map(event => [
    event.year == null ? null : `${event.year} 年`,
    event.decidedYear == null ? null : `${event.decidedYear} 年公布`,
    event.batchSeq == null ? null : `第 ${event.batchSeq} 批`,
    ...new Set(event.evidence?.map(item => {
      const page = item.page ?? item.publishedRow?.page
      return [
        item.sourceFile, item.attachment, page == null ? null : `第 ${page} 页`,
        item.listNo == null ? null : `序号 ${item.listNo}`,
      ].filter(Boolean).join(' ')
    })),
  ].filter(Boolean).join(' · ')).filter(Boolean) ?? []
  return {
    key: String(index), ...row.enterprise,
    businessSummary: [titleLabel(row.titleCode), ...eventSummaries].join(' · '),
  }
}) ?? [])

const canPreflight = computed(() => context.value?.writeEnabled === true && ready.value && !!basis.value.trim() && !submitting.value)
const canCommit = computed(() => canPreflight.value && !!preview.value && preview.value.result.conflicts.length === 0 &&
  (!detail.value?.officialEvidencePreflightRequired || !!preview.value.result.officialEvidencePlanHash))
let reviewVersion = 0

function invalidatePreview() {
  reviewVersion += 1
  preview.value = undefined
  submitError.value = ''
}
watch(basis, invalidatePreview, { flush: 'sync' })

function updateDecisions(value: BatchSupplementDecision[], complete: boolean) {
  if (JSON.stringify(value) !== JSON.stringify(decisions.value) || complete !== ready.value) invalidatePreview()
  decisions.value = value
  ready.value = complete
}

async function openIntake(id: number) {
  if (loadingId.value !== undefined) return
  loadingId.value = id
  loadError.value = ''
  notice.value = ''
  try {
    const result = await $fetch<IntakeDetail>(`${endpoint}/${id}/browser`)
    if (result.status !== 'staged') {
      void refetch()
      loadError.value = '此名单的入库状态已变更。'
      return
    }
    basis.value = ''
    updateDecisions([], false)
    invalidatePreview()
    detail.value = result
  } catch (cause) {
    loadError.value = describeFetchError(cause, '名单原行读取失败，请重试。')
  } finally {
    loadingId.value = undefined
  }
}

async function submit(action: 'preflight' | 'commit') {
  const intake = detail.value
  if (!intake || !(action === 'commit' ? canCommit.value : canPreflight.value)) return
  submitting.value = true
  submitError.value = ''
  lastAction.value = action
  try {
    const url = `${endpoint}/${intake.intakeId}/browser-supplement`
    if (action === 'preflight') {
      const request = {
        sourceDigest: intake.sourceDigest, basis: basis.value.trim(), rows: announcementSubjectDecisions(decisions.value),
      }
      const version = reviewVersion
      const result = await $fetch<SupplementAnnouncementPreflightResult>(url, { method: 'POST', body: { ...request, preflight: true } })
      if (version === reviewVersion) preview.value = { result, request }
    } else {
      const { result, request } = preview.value!
      const receipt = await $fetch<SupplementAnnouncementResult>(url, {
        method: 'POST', body: { ...request, officialEvidencePlanHash: result.officialEvidencePlanHash },
      })
      if (receipt.status === 'failed') {
        preview.value = undefined
        lastAction.value = 'preflight'
        submitError.value = [receipt.error, ...receipt.items.map(item => item.error?.message)].filter(Boolean).join(' · ')
        return
      }
      detail.value = undefined
      notice.value = `已提交入库，共关联 ${new Set(receipt.owners).size} 家企业。`
      cache.setQueryData<IntakeSummary[]>(catalogKey, data.value?.map(row =>
        row.id === intake.intakeId ? { ...row, status: 'supplemented' } : row) ?? [])
      void cache.invalidateQueries({ key: catalogKey })
      void cache.invalidateQueries({ key: ['enterprise-library'] })
    }
  } catch (cause) {
    submitError.value = describeFetchError(cause, action === 'preflight' ? '预检失败，请重试。' : '提交失败，请重试。')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <WorkspacePage title="公布名单入库">
    <template #actions>
      <Button as-child variant="outline"><NuxtLink :to="ROSTER_FILES_PATH">返回名单文件</NuxtLink></Button>
    </template>
    <p v-if="notice" role="status" class="text-sm">{{ notice }}</p>
    <FieldError v-if="loadError" role="alert">{{ loadError }}</FieldError>
    <div v-if="error" class="flex flex-wrap items-center gap-2">
      <FieldError role="alert">{{ describeFetchError(error, '批次列表读取失败。') }}</FieldError>
      <Button variant="outline" size="sm" @click="refetch()">重试加载</Button>
    </div>
    <p v-if="isPending" role="status" class="text-sm text-muted-foreground">正在加载公布名单…</p>
    <p v-else-if="!error && !intakes.length" class="text-sm text-muted-foreground">暂无公布名单批次。</p>
    <ul v-if="intakes.length" aria-label="公布名单批次" class="min-h-0 divide-y overflow-y-auto rounded-xl border bg-card">
      <li v-for="intake in intakes" :key="intake.id" class="flex min-w-0 flex-wrap items-center justify-between gap-3 p-3 sm:p-4">
        <div class="min-w-0 flex-1 basis-52 space-y-1">
          <h2 class="wrap-anywhere text-sm font-medium">{{ intake.sourceName }}</h2>
          <p class="wrap-anywhere text-sm text-muted-foreground">{{ intake.sourceIdentity }} · {{ intake.rowCount }} 行<span v-if="intake.issueDate"> · {{ intake.issueDate }}</span></p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Badge :variant="intake.status === 'staged' ? 'outline' : 'secondary'">{{ intake.status === 'staged' ? '待入库' : '已入库' }}</Badge>
          <Button v-if="intake.status === 'staged'" size="sm" variant="outline" :disabled="loadingId !== undefined"
            @click="openIntake(intake.id)">{{ loadingId === intake.id ? '正在读取…' : '核对名单' }}</Button>
        </div>
      </li>
    </ul>

    <EnterpriseBatchSupplementDrawer v-if="detail" :open="true" :rows="drawerRows"
      title="核对公布名单" :description="detail.announcement.sourceDocument.title"
      :submitting="submitting" :disabled="context?.writeEnabled !== true"
      @update:open="value => { if (!value) detail = undefined }" @update:decisions="updateDecisions">
      <template #header-extra>
        <p v-if="context?.writeEnabled === false" role="status" class="text-sm text-muted-foreground">当前为只读模式，可查看名单，暂不能预检或提交。</p>
        <div v-else-if="contextError" class="space-y-2">
          <FieldError role="alert">无法读取写入状态。</FieldError>
          <Button size="sm" variant="outline" @click="retryContext()">重试读取写入状态</Button>
        </div>
      </template>
      <template #footer-extra>
        <Field>
          <FieldLabel for="announcement-review-basis">核实依据（必填）</FieldLabel>
          <Textarea id="announcement-review-basis" v-model="basis" required maxlength="4000" rows="2"
            class="field-sizing-fixed resize-none" :disabled="submitting || context?.writeEnabled !== true" />
        </Field>
        <div v-if="preview || submitError" class="max-h-24 space-y-1 overflow-y-auto text-sm">
          <FieldError v-if="submitError" role="alert" class="wrap-anywhere">{{ submitError }}</FieldError>
          <div v-if="preview" role="status" class="space-y-1 wrap-anywhere">
            <p>预检 {{ drawerRows.length }} 行 · 新增 {{ preview.request.rows.filter(row => row.action === 'create').length }} ·
              关联 {{ preview.request.rows.filter(row => row.action === 'attach').length }} · 同一主体引用 {{ preview.request.rows.filter(row => row.action === 'same_subject').length }} ·
              冲突 {{ preview.result.conflicts.length }}</p>
            <p v-if="preview.result.officialEvidencePlanHash">计划哈希 <code>{{ preview.result.officialEvidencePlanHash }}</code></p>
            <p v-else-if="detail.officialEvidencePreflightRequired && !preview.result.conflicts.length">缺少公布证据计划哈希，请重试预检。</p>
            <ul v-if="preview.result.conflicts.length">
              <li v-for="(item, index) in preview.result.conflicts" :key="index">{{ item.ref }} · {{ item.error?.message || item.kind }}</li>
            </ul>
          </div>
        </div>
      </template>
      <template #footer-actions>
        <Button variant="outline" :disabled="!canPreflight" @click="submit('preflight')">
          {{ submitting && lastAction === 'preflight' ? '预检中…' : submitError || preview?.result.conflicts.length ? '重试预检' : '执行预检' }}
        </Button>
        <Button :disabled="!canCommit" @click="submit('commit')">
          {{ submitting && lastAction === 'commit' ? '提交中…' : submitError && lastAction === 'commit' ? '重试提交入库' : '确认提交入库' }}
        </Button>
      </template>
    </EnterpriseBatchSupplementDrawer>
  </WorkspacePage>
</template>
