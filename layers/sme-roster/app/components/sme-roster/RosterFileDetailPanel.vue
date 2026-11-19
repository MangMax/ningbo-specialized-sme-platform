<script setup lang="ts">
import { computed, ref, watch, watchEffect } from 'vue'
import { currentContentMessage } from '#core/lib/file-content-status'
import DisclosurePanel from '#core/app/components/DisclosurePanel.vue'
import { Input } from '#core/app/components/ui/input'
import { Label } from '#core/app/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { KIND_ORDER, KINDS, SOURCES, SOURCE_ORDER, TITLE_ORDER, TITLES } from '#sme-roster/lib/labels'
import type { RosterFileFields } from '#sme-roster/server/modules/sme-roster/files'
import type { FileRow } from '#core/server/utils/file-store'
import type { FileDetailDraft } from '#core/lib/core/file-categories'

const props = defineProps<{ open: boolean; file: (FileRow & RosterFileFields) | null; pending: boolean }>()
const emit = defineEmits<{ draft: [value: FileDetailDraft] }>()

interface MetadataForm {
  source: string
  kind: string
  year: string
  batch: string
  titleCode: string
}

/** 下拉里表示「清空该字段」的哨兵值(reka-ui 的 SelectItem 不接受空串 value)。 */
const NONE = '__none__'

const form = ref<MetadataForm>({ source: '', kind: '', year: '', batch: '', titleCode: '' })

watch(() => props.open, (value) => {
  if (!value || !props.file) return
  form.value = {
    source: props.file.source ?? '',
    kind: props.file.kind ?? '',
    year: props.file.year != null ? String(props.file.year) : '',
    batch: props.file.batch != null ? String(props.file.batch) : '',
    titleCode: props.file.titleCode ?? '',
  }
}, { immediate: true })

const yearInvalid = computed(
  () => form.value.year.trim().length > 0 && !/^\d{4}$/.test(form.value.year.trim()),
)
const batchInvalid = computed(
  () => form.value.batch.trim().length > 0 && !/^\d+$/.test(form.value.batch.trim()),
)
const needsYear = computed(() => Boolean(form.value.batch.trim()) && !form.value.year.trim())

/** 把哨兵值折成空串(即「清空」)。 */
const blank = (v: string | undefined) => (v === NONE ? '' : (v ?? ''))

const sourceModel = computed({
  get: () => form.value.source || NONE,
  set: (v: string) => (form.value.source = blank(v)),
})
const kindModel = computed({
  get: () => form.value.kind || NONE,
  set: (v: string) => (form.value.kind = blank(v)),
})
const titleModel = computed({
  get: () => form.value.titleCode || NONE,
  set: (v: string) => (form.value.titleCode = blank(v)),
})

/** 下拉项一律从 `layers/sme-roster/lib/labels.ts` 的单一来源取,不在这里重写中文 —— 避免文案漂移。 */
const SOURCE_ITEMS = SOURCE_ORDER.map((code) => ({ value: code, label: SOURCES[code] ?? code }))
const KIND_ITEMS = KIND_ORDER.map((code) => ({ value: code, label: KINDS[code] ?? code }))

const nullable = (value: string) => value.trim() || null
watchEffect(() => {
  if (!props.open || !props.file) return
  emit('draft', {
    valid: !yearInvalid.value && !batchInvalid.value && !needsYear.value,
    patch: {
      source: nullable(form.value.source),
      kind: nullable(form.value.kind),
      year: nullable(form.value.year) === null ? null : Number(form.value.year),
      batch: nullable(form.value.batch) === null ? null : Number(form.value.batch),
      titleCode: nullable(form.value.titleCode),
    },
  })
})
</script>

<template>
  <DisclosurePanel compact title="文件来源核验信息">
    <div class="space-y-2">
      <p role="status" class="text-sm break-words">{{ currentContentMessage(file?.contentIdentity) }}</p>
      <p v-if="file?.parts.length" class="text-sm">
        已有文件段的历史出处绑定未知。{{ file.partsBinding?.inputLineage.status === 'bound' ? '已记录解析输入引用；这不能证明历史文件段来自该输入。' : '解析输入引用未记录。' }}
      </p>
    </div>
  </DisclosurePanel>
  <div class="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
    <div class="flex flex-col gap-1.5">
      <Label for="file-source" class="text-xs">来源</Label>
      <Select v-model="sourceModel" :disabled="pending">
        <SelectTrigger id="file-source" class="w-full">
          <SelectValue placeholder="未设" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="NONE">未设</SelectItem>
          <SelectItem v-for="opt in SOURCE_ITEMS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div class="flex flex-col gap-1.5">
      <Label for="file-kind" class="text-xs">类别</Label>
      <Select v-model="kindModel" :disabled="pending">
        <SelectTrigger id="file-kind" class="w-full">
          <SelectValue placeholder="未设" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="NONE">未设</SelectItem>
          <SelectItem v-for="opt in KIND_ITEMS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div class="flex flex-col gap-1.5">
      <Label for="file-year" class="text-xs">文件发布年份</Label>
      <Input
        id="file-year"
        v-model="form.year"
        :disabled="pending"
        inputmode="numeric"
        maxlength="4"
        placeholder="2024"
        :aria-invalid="yearInvalid || needsYear || undefined"
      />
      <p class="text-muted-foreground text-table leading-relaxed">
        这份文件的发布年份，不是认定或复核年份。
      </p>
    </div>

    <div class="flex flex-col gap-1.5">
      <Label for="file-batch" class="text-xs">文件发布批次</Label>
      <Input
        id="file-batch"
        v-model="form.batch"
        :disabled="pending"
        inputmode="numeric"
        placeholder="1"
        :aria-invalid="batchInvalid || needsYear || undefined"
      />
      <p
        class="text-table leading-relaxed"
        :class="needsYear ? 'text-destructive' : 'text-muted-foreground'"
      >
        {{ needsYear ? '填了批次就要同时填年份。' : '文件发布批次；内容批次请在分段中修改。' }}
      </p>
    </div>

    <div class="flex flex-col gap-1.5 sm:col-span-2">
      <Label for="file-title" class="text-xs">称号</Label>
      <Select v-model="titleModel" :disabled="pending">
        <SelectTrigger id="file-title" class="w-full">
          <SelectValue placeholder="未设" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="NONE">未设</SelectItem>
          <SelectItem v-for="code in TITLE_ORDER" :key="code" :value="code">
            {{ TITLES[code] ?? code }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  </div>
</template>
