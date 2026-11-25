<script setup lang="ts">
import { computed, nextTick, ref, watch, type ComponentPublicInstance } from 'vue'
import { useQuery } from '@pinia/colada'
import { useDebounce } from '@vueuse/core'
import { ChevronLeft, ChevronRight, ExternalLink, FileText, RefreshCw, Search } from '@lucide/vue'
import DatePicker from '#core/app/components/DatePicker.vue'
import { Alert, AlertDescription } from '#core/app/components/ui/alert'
import { Button } from '#core/app/components/ui/button'
import { Card, CardContent, CardHeader } from '#core/app/components/ui/card'
import ModalDialog from '#core/app/components/ModalDialog.vue'
import { DialogFooter } from '#core/app/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '#core/app/components/ui/field'
import { Input } from '#core/app/components/ui/input'
import { Pagination, PaginationContent, PaginationNext, PaginationPrevious } from '#core/app/components/ui/pagination'
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { describeFetchError } from '#core/lib/file-content-status'
import { versionInput, type LeadCatalog } from '../../lib/contracts'
import type { LeadImport } from '../../lib/import-rows'
import LeadListRowImport from './LeadListRowImport.vue'

type OriginalFile = { id: number; displayName: string; relPath: string }
type Step = 'source' | 'rows' | 'confirm'
const props = defineProps<{ catalog: LeadCatalog }>()
const emit = defineEmits<{ registered: [id: number] }>()
const open = defineModel<boolean>('open', { required: true })
const step = ref<Step>('source')
const newSeriesOption = 'create'
const seriesOption = ref(props.catalog.versions.length ? '' : newSeriesOption)
const newSeriesName = ref('')
const existingSeries = computed(() => [...new Set(props.catalog.versions.map(version => version.series))])
const isCreatingSeries = computed(() => !existingSeries.value.length || seriesOption.value === newSeriesOption)
const series = computed(() => isCreatingSeries.value
  ? newSeriesName.value.trim()
  : existingSeries.value.find(name => `series:${name}` === seriesOption.value) ?? '')
const channel = ref('')
const listType = ref('')
const acquiredOn = ref('')
const search = ref('')
const selectedFile = ref<OriginalFile>()
const sourceWorkbook = computed(() => {
  const file = selectedFile.value
  const name = file?.relPath.split('/').at(-1)
  return file && name && /\.xlsx$/i.test(name) ? { id: file.id, name } : undefined
})
const selectedRows = ref<LeadImport | null>(null)
const readingRows = ref(false)
const saving = ref(false)
const error = ref('')
const errorSummary = ref<ComponentPublicInstance>()
const stepBody = ref<HTMLElement>()
const query = useDebounce(search, 250)
const page = ref(1)
const pageSize = 10
const files = useQuery({
  key: () => ['lead-lists', 'source-files', query.value.trim(), page.value] as const,
  query: ({ entry }) => $fetch<{ rows: OriginalFile[]; total: number }>('/api/file-library', {
    query: { q: entry.key[2], page: entry.key[3], pageSize },
  }),
  enabled: () => open.value && step.value === 'source' && !selectedFile.value,
})
const loadingFiles = computed(() => search.value.trim() !== query.value.trim() || files.isLoading.value)
const firstFileNumber = computed(() => (page.value - 1) * pageSize + 1)
const selectedChannel = computed(() => props.catalog.channels.find(item => item.code === channel.value)?.name)
const selectedType = computed(() => props.catalog.listTypes.find(item => item.code === listType.value)?.name)

watch(query, () => { page.value = 1 })

function directory(file: OriginalFile) {
  return file.relPath.slice(0, Math.max(0, file.relPath.lastIndexOf('/')))
}
function chooseFile(file: OriginalFile) {
  selectedFile.value = file
  error.value = ''
  void nextTick(() => document.getElementById('lead-change-source')?.focus())
}
function changeFile() {
  selectedRows.value = null
  selectedFile.value = undefined
  void nextTick(() => {
    document.getElementById('lead-file-search')?.focus()
    void files.refetch()
  })
}
function showStep(value: Step) {
  error.value = ''
  step.value = value
  void nextTick(() => {
    if (stepBody.value) stepBody.value.scrollTop = 0
    stepBody.value?.querySelector<HTMLElement>(`[data-lead-step="${value}"] h2`)?.focus()
  })
}
function fail(message: string) {
  error.value = message
  void nextTick(() => (errorSummary.value?.$el as HTMLElement | undefined)?.focus())
}

async function advance() {
  if (saving.value || readingRows.value) return
  if (step.value === 'source') {
    if (!selectedFile.value) { fail('请选择原文件。'); return }
    if (!series.value || !channel.value || !listType.value || !acquiredOn.value) {
      fail('请填完整所属系列、获取日期、名单来源和名单类型。')
      return
    }
    if (isCreatingSeries.value && existingSeries.value.includes(series.value)) {
      fail('已有同名系列，请从列表中选择。')
      return
    }
    showStep('rows')
    return
  }
  if (step.value === 'rows') {
    if (!selectedRows.value) { fail('请导入或粘贴名单并查看预览。'); return }
    showStep('confirm')
    return
  }
  const result = versionInput.safeParse({
    series: series.value, channel: channel.value, listType: listType.value,
    acquiredOn: acquiredOn.value, fileId: selectedFile.value?.id, rows: selectedRows.value?.rows,
  })
  if (!result.success) { fail('请返回检查原件、版本资料和名单。'); return }

  error.value = ''
  saving.value = true
  try {
    const response = await $fetch<{ id: number }>('/api/lead-lists/versions/browser-create', {
      method: 'POST', headers: { 'x-lead-list-browser': '1' }, body: result.data,
    })
    open.value = false
    step.value = 'source'
    seriesOption.value = newSeriesName.value = channel.value = listType.value = acquiredOn.value = search.value = ''
    selectedFile.value = undefined
    selectedRows.value = null
    page.value = 1
    emit('registered', response.id)
  } catch (cause) {
    fail(describeFetchError(cause, '名单保存失败，请重试。'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <ModalDialog
    :open="open"
    title="新增名单"
    description="选择原件，预览名单，然后保存。"
    hide-description
    size="lg"
    :prevent-close="saving || readingRows"
    bare-body
    @update:open="value => { if (!saving && !readingRows) open = value }"
  >
    <template #header-extra>
      <ol aria-label="新增名单进度" class="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <li :aria-current="step === 'source' ? 'step' : undefined" class="aria-[current=step]:text-primary aria-[current=step]:font-semibold">原件与资料</li>
        <li :aria-current="step === 'rows' ? 'step' : undefined" class="aria-[current=step]:text-primary aria-[current=step]:font-semibold">名单预览</li>
        <li :aria-current="step === 'confirm' ? 'step' : undefined" class="aria-[current=step]:text-primary aria-[current=step]:font-semibold">确认名单</li>
      </ol>
    </template>
    <form class="flex min-h-0 flex-1 flex-col" novalidate @submit.prevent="advance">
      <div ref="stepBody" class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6">
          <section v-if="step === 'source'" data-lead-step="source" class="space-y-5">
            <Card class="min-w-0 gap-0 overflow-hidden py-0 shadow-none">
              <CardHeader class="flex-row flex-wrap items-center justify-between gap-2 space-y-0 p-3 pb-0">
                <h2 tabindex="-1" class="text-sm font-semibold outline-none">{{ selectedFile ? '已选原文件' : '选择原文件' }}</h2>
                <div v-if="!selectedFile" class="flex items-center gap-2">
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="刷新文件列表"
                    :disabled="loadingFiles" @click="files.refetch()"><RefreshCw aria-hidden="true" /></Button>
                  <Button as-child variant="outline" size="sm">
                    <NuxtLink to="/files" target="_blank" rel="noopener">文件库上传<ExternalLink aria-hidden="true" /></NuxtLink>
                  </Button>
                </div>
              </CardHeader>
              <CardContent v-if="selectedFile" class="flex min-w-0 items-start gap-3 px-3 py-3">
                <FileText class="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <div class="min-w-0 flex-1 space-y-1">
                  <p class="wrap-anywhere text-sm font-medium">{{ selectedFile.displayName }}</p>
                  <p v-if="directory(selectedFile)" class="text-muted-foreground wrap-anywhere text-sm">{{ directory(selectedFile) }}</p>
                </div>
                <Button id="lead-change-source" type="button" variant="ghost" size="sm" @click="changeFile">更换</Button>
              </CardContent>
              <CardContent v-else class="flex min-w-0 flex-col gap-2 px-3 pt-2 pb-3">
                <div class="relative">
                  <Search class="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4" aria-hidden="true" />
                  <Input id="lead-file-search" v-model="search" aria-label="搜索原文件" class="pl-9"
                    placeholder="搜索文件名关键词" @keydown.enter.prevent />
                </div>
                <p v-if="loadingFiles" role="status" class="text-muted-foreground py-3 text-sm">正在查找文件…</p>
                <Alert v-else-if="files.error.value" variant="destructive">
                  <AlertDescription class="flex flex-wrap items-center gap-2">
                    文件列表加载失败。
                    <Button type="button" variant="outline" size="sm" @click="files.refetch()">重新加载</Button>
                  </AlertDescription>
                </Alert>
                <p v-else-if="!files.data.value?.rows.length" role="status" class="text-muted-foreground py-3 text-sm">没有匹配的文件。</p>
                <ul v-else aria-label="匹配的原文件" class="max-h-44 min-w-0 space-y-0.5 overflow-y-auto overscroll-contain p-1">
                    <li v-for="file in files.data.value.rows" :key="file.id" class="min-w-0">
                      <Button type="button" variant="ghost" class="h-auto w-full min-w-0 justify-start gap-2.5 px-2 py-2 text-left whitespace-normal" @click="chooseFile(file)">
                        <FileText class="text-muted-foreground size-4 self-start" aria-hidden="true" />
                        <span class="min-w-0 flex-1 space-y-0.5">
                          <span class="block wrap-anywhere">{{ file.displayName }}</span>
                          <span v-if="directory(file)" class="text-muted-foreground block wrap-anywhere font-normal">{{ directory(file) }}</span>
                        </span>
                        <ChevronRight class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
                      </Button>
                    </li>
                </ul>
              </CardContent>
              <CardContent v-if="!selectedFile && !loadingFiles && !files.error.value && files.data.value && files.data.value.total > pageSize"
                class="flex flex-wrap items-center gap-2 border-t px-3 py-1.5">
                <span class="text-muted-foreground mr-auto text-sm tabular-nums">
                  {{ firstFileNumber }}–{{ firstFileNumber + files.data.value.rows.length - 1 }} / {{ files.data.value.total }} 个
                </span>
                <Pagination v-model:page="page" :items-per-page="pageSize" :total="files.data.value.total" aria-label="原文件分页" class="mx-0 w-auto">
                  <PaginationContent>
                    <PaginationPrevious type="button" size="sm" aria-label="上一页"><ChevronLeft aria-hidden="true" /></PaginationPrevious>
                    <PaginationNext type="button" size="sm" aria-label="下一页"><ChevronRight aria-hidden="true" /></PaginationNext>
                  </PaginationContent>
                </Pagination>
              </CardContent>
            </Card>
            <FieldGroup class="grid gap-4 sm:grid-cols-2">
              <Field class="gap-1.5">
                <FieldLabel :for="existingSeries.length ? 'lead-series' : 'lead-series-name'">所属系列</FieldLabel>
                <Select v-if="existingSeries.length" v-model="seriesOption">
                  <SelectTrigger id="lead-series" class="w-full min-w-0 *:data-[slot=select-value]:min-w-0">
                    <SelectValue placeholder="选择系列" />
                  </SelectTrigger>
                  <SelectContent class="w-(--reka-select-trigger-width) max-w-(--reka-select-content-available-width)">
                    <SelectGroup>
                      <SelectItem v-for="name in existingSeries" :key="name" :value="`series:${name}`">
                        <span class="min-w-0 wrap-anywhere">{{ name }}</span>
                      </SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup><SelectItem :value="newSeriesOption">新建系列</SelectItem></SelectGroup>
                  </SelectContent>
                </Select>
                <template v-if="isCreatingSeries">
                  <FieldLabel v-if="existingSeries.length" for="lead-series-name">新系列名称</FieldLabel>
                  <Input id="lead-series-name" v-model="newSeriesName" maxlength="120" required placeholder="例如：年度企业走访" />
                </template>
              </Field>
              <Field class="gap-1.5">
                <FieldLabel for="lead-date">获取日期</FieldLabel>
                <DatePicker id="lead-date" v-model="acquiredOn" label="获取日期" size="default" class="w-full" />
              </Field>
              <Field class="gap-1.5">
                <FieldLabel for="lead-channel">名单来源</FieldLabel>
                <Select v-model="channel" required>
                  <SelectTrigger id="lead-channel" class="w-full"><SelectValue placeholder="选择名单来源" /></SelectTrigger>
                  <SelectContent><SelectGroup><SelectItem v-for="item in props.catalog.channels" :key="item.code" :value="item.code">{{ item.name }}</SelectItem></SelectGroup></SelectContent>
                </Select>
              </Field>
              <Field class="gap-1.5">
                <FieldLabel for="lead-type">名单类型</FieldLabel>
                <Select v-model="listType" required>
                  <SelectTrigger id="lead-type" class="w-full"><SelectValue placeholder="选择名单类型" /></SelectTrigger>
                  <SelectContent><SelectGroup><SelectItem v-for="item in props.catalog.listTypes" :key="item.code" :value="item.code">{{ item.name }}</SelectItem></SelectGroup></SelectContent>
                </Select>
              </Field>
            </FieldGroup>
          </section>
          <section v-show="step === 'rows'" data-lead-step="rows" class="space-y-3">
            <h2 tabindex="-1" class="text-sm font-semibold outline-none">核对后的名单</h2>
            <LeadListRowImport :key="selectedFile?.id" v-model="selectedRows" v-model:reading="readingRows"
              :source-workbook="sourceWorkbook" />
          </section>
          <section v-if="step === 'confirm'" data-lead-step="confirm" class="space-y-4">
            <h2 tabindex="-1" class="text-sm font-semibold outline-none">核对名单资料</h2>
            <dl class="grid min-w-0 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div class="space-y-1"><dt class="text-muted-foreground">所属系列</dt><dd class="wrap-anywhere font-medium">{{ series }}</dd></div>
              <div class="space-y-1"><dt class="text-muted-foreground">获取日期</dt><dd class="font-medium tabular-nums">{{ acquiredOn }}</dd></div>
              <div class="space-y-1"><dt class="text-muted-foreground">名单来源</dt><dd class="font-medium">{{ selectedChannel }}</dd></div>
              <div class="space-y-1"><dt class="text-muted-foreground">名单类型</dt><dd class="font-medium">{{ selectedType }}</dd></div>
              <div class="space-y-1 sm:col-span-2"><dt class="text-muted-foreground">原文件</dt><dd class="wrap-anywhere font-medium">{{ selectedFile?.displayName }}</dd></div>
              <div class="space-y-1 sm:col-span-2"><dt class="text-muted-foreground">名单</dt><dd class="wrap-anywhere font-medium">{{ selectedRows?.rows.length }} 家 · {{ selectedRows?.name }}</dd></div>
            </dl>
          </section>
        </div>
        <DialogFooter class="bg-surface-sunken/40 shrink-0 flex-row flex-wrap items-center justify-end border-t px-5 py-3 sm:px-6">
          <FieldError v-if="error" ref="errorSummary" tabindex="-1" class="w-full">{{ error }}</FieldError>
          <Button v-if="step !== 'source'" type="button" variant="outline" :disabled="saving || readingRows" class="mr-auto"
            @click="showStep(step === 'confirm' ? 'rows' : 'source')">上一步</Button>
          <Button type="submit" :disabled="saving || readingRows">
            {{ saving ? '正在保存…' : step === 'source' ? '下一步：导入名单' : step === 'rows' ? '下一步：确认名单' : '保存名单' }}
          </Button>
        </DialogFooter>
      </form>
  </ModalDialog>
</template>
