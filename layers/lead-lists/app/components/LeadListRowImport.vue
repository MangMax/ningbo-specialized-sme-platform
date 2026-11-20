<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { ClipboardPaste, FileSpreadsheet, Upload } from '@lucide/vue'
import TablePagination from '#core/app/components/TablePagination.vue'
import { Button } from '#core/app/components/ui/button'
import { Card, CardContent } from '#core/app/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#core/app/components/ui/collapsible'
import { Field, FieldError, FieldLabel } from '#core/app/components/ui/field'
import { Input } from '#core/app/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '#core/app/components/ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '#core/app/components/ui/table'
import { Textarea } from '#core/app/components/ui/textarea'
import { MAX_LEAD_WORKBOOK_BYTES, readLeadWorkbook, readPastedLeadRows, type LeadImport } from '../../lib/import-rows'

const props = defineProps<{ sourceWorkbook?: { id: number; name: string } }>()
const imported = defineModel<LeadImport | null>({ required: true })
const busy = defineModel<boolean>('reading', { required: true })
const fileInput = ref<{ $el: HTMLInputElement }>()
const pasteOpen = ref(false)
const workbook = shallowRef<Awaited<ReturnType<typeof readLeadWorkbook>>>()
const sheet = ref('0')
const clipboard = ref('')
const clipboardPreview = ref<LeadImport>()
const error = ref('')
const page = ref(1)
const pageSize = ref(25)
const shown = computed(() => imported.value?.rows.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
watch([imported, pageSize], () => { page.value = 1 })
watch(clipboard, () => {
  if (imported.value && imported.value === clipboardPreview.value) imported.value = null
})

function pickSheet(value: unknown) {
  if (!workbook.value || typeof value !== 'string') return
  sheet.value = value
  error.value = ''
  imported.value = null
  try {
    imported.value = workbook.value.read(Number(value))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取工作表。'
  }
}

function openLocalWorkbook(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void importWorkbook(async () => file)
}

function openSourceWorkbook() {
  const source = props.sourceWorkbook
  if (!source) return
  void importWorkbook(async () => {
    const response = await fetch(`/api/files/${source.id}`)
    if (!response.ok || response.headers.get('x-file-content-status') !== 'verified'
        || response.headers.get('x-file-id') !== String(source.id)) {
      throw new Error('无法确认原工作簿，请重新选择原件或另选核对工作簿。')
    }
    if (Number(response.headers.get('content-length')) > MAX_LEAD_WORKBOOK_BYTES) {
      void response.body?.cancel()
      throw new Error('原工作簿超过 10 MB，请另选核对工作簿或从表格粘贴。')
    }
    return new File([await response.blob()], source.name)
  })
}

async function importWorkbook(loadFile: () => Promise<File>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    workbook.value = await readLeadWorkbook(await loadFile())
    pickSheet('0')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法打开工作簿。'
  } finally {
    busy.value = false
  }
}

async function previewClipboard() {
  const text = clipboard.value
  busy.value = true
  error.value = ''
  try {
    const preview = await readPastedLeadRows(text)
    if (clipboard.value !== text) return
    clipboardPreview.value = preview
    imported.value = preview
    workbook.value = undefined
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取粘贴内容。'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Card class="min-w-0 gap-0 overflow-hidden py-0 shadow-none">
    <CardContent class="flex min-w-0 flex-col gap-3 p-3">
      <Collapsible v-model:open="pasteOpen">
        <div class="flex flex-wrap items-center gap-2">
          <Button v-if="sourceWorkbook" type="button" :disabled="busy" @click="openSourceWorkbook">
            <FileSpreadsheet aria-hidden="true" />使用原工作簿
          </Button>
          <Input ref="fileInput" class="hidden" type="file" accept=".xlsx" tabindex="-1" aria-hidden="true" @change="openLocalWorkbook" />
          <Button type="button" variant="outline" :disabled="busy" @click="fileInput?.$el.click()">
            <Upload aria-hidden="true" />{{ busy ? '正在读取…' : '导入 Excel 工作簿' }}
          </Button>
          <CollapsibleTrigger as-child>
            <Button type="button" variant="ghost"><ClipboardPaste aria-hidden="true" />从表格粘贴</Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent class="flex flex-col items-start gap-2 pt-2">
          <Field class="gap-1.5">
            <FieldLabel for="lead-clipboard">粘贴名单</FieldLabel>
            <Textarea id="lead-clipboard" v-model="clipboard" rows="3" class="max-h-40"
              placeholder="企业名称、统一社会信用代码、区县、备注" />
          </Field>
          <Button type="button" variant="outline" size="sm" :disabled="busy || !clipboard.trim()" @click="previewClipboard">预览粘贴内容</Button>
        </CollapsibleContent>
      </Collapsible>
      <Field v-if="workbook && workbook.names.length > 1" orientation="horizontal">
        <FieldLabel for="lead-worksheet" class="shrink-0">工作表</FieldLabel>
        <Select :model-value="sheet" @update:model-value="pickSheet">
          <SelectTrigger id="lead-worksheet" class="w-full min-w-0"><SelectValue /></SelectTrigger>
          <SelectContent class="w-(--reka-select-trigger-width) max-w-(--reka-select-content-available-width)">
            <SelectGroup>
              <SelectItem v-for="(name, index) in workbook.names" :key="index" :value="String(index)">
                <span class="min-w-0 wrap-anywhere">{{ name }}</span>
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <FieldError v-if="error">{{ error }}</FieldError>
      <p v-if="!imported" class="text-muted-foreground text-sm">表头至少包含「企业名称」。</p>
    </CardContent>
    <template v-if="imported">
      <CardContent class="flex flex-wrap items-start justify-between gap-2 border-t px-3 py-2.5">
        <p class="flex min-w-0 items-start gap-2 text-sm font-medium">
          <FileSpreadsheet class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span class="wrap-anywhere">{{ imported.name }}</span>
        </p>
        <span role="status" class="shrink-0 text-sm font-medium tabular-nums">{{ imported.rows.length }} 家企业</span>
      </CardContent>
      <CardContent class="data-table-scroll border-t p-0" role="region" aria-label="名单预览" tabindex="0">
        <Table class="data-table table-fixed">
          <TableCaption class="sr-only">名单预览</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead class="w-14">原行</TableHead>
              <TableHead>企业名称</TableHead>
              <TableHead class="hidden w-48 sm:table-cell">统一社会信用代码</TableHead>
              <TableHead class="hidden w-20 sm:table-cell">区县</TableHead>
              <TableHead class="hidden w-1/5 sm:table-cell">备注</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="row in shown" :key="row.rowNumber">
              <TableCell class="align-top tabular-nums">{{ row.rowNumber }}</TableCell>
              <TableCell class="whitespace-normal wrap-anywhere">
                <p class="font-medium">{{ row.name }}</p>
                <dl v-if="row.uscc || row.district || row.note" class="text-muted-foreground mt-1 space-y-0.5 sm:hidden">
                  <div v-if="row.uscc"><dt class="sr-only">统一社会信用代码</dt><dd class="font-mono">{{ row.uscc }}</dd></div>
                  <div v-if="row.district"><dt class="sr-only">区县</dt><dd>{{ row.district }}</dd></div>
                  <div v-if="row.note"><dt class="sr-only">备注</dt><dd>{{ row.note }}</dd></div>
                </dl>
              </TableCell>
              <TableCell class="hidden font-mono whitespace-normal wrap-anywhere sm:table-cell">{{ row.uscc ?? '—' }}</TableCell>
              <TableCell class="hidden whitespace-normal wrap-anywhere sm:table-cell">{{ row.district ?? '—' }}</TableCell>
              <TableCell class="hidden whitespace-normal wrap-anywhere sm:table-cell">{{ row.note ?? '—' }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
      <TablePagination v-if="imported.rows.length > 25" v-model:page="page" v-model:page-size="pageSize" in-card :total="imported.rows.length" unit="家" />
    </template>
  </Card>
</template>
