<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { KIND_ORDER, KINDS, SOURCES, SOURCE_ORDER, TITLE_ORDER, TITLES } from '~~/lib/labels'
import type { StoredFileRow } from '~~/server/utils/stored-files'
/**
 * 编辑一个文件的**元数据**(票 09)。
 *
 * 只改分类(`source` / `kind` / `year` / `batch` / `title_code`):
 * **不动 `rel_path`、不动磁盘文件** —— 所以文件名那一行是**只读**展示,让人看清在改谁。
 *
 * 「清空」用下拉里的一项显式表达,而不是靠输入框留空 —— 空串要区分「没填」还是
 * 「就是要清掉」,显式一项不会含糊。
 */
const open = defineModel<boolean>('open', { default: false })

const props = withDefaults(
  defineProps<{
    file: StoredFileRow | null
    pending?: boolean
    failure?: string
  }>(),
  { pending: false, failure: '' },
)

export interface MetadataForm {
  source: string
  kind: string
  year: string
  batch: string
  titleCode: string
}

const emit = defineEmits<{ save: [form: MetadataForm] }>()

/** 下拉里表示「清空该字段」的哨兵值(reka-ui 的 SelectItem 不接受空串 value)。 */
const NONE = '__none__'

const form = ref<MetadataForm>({ source: '', kind: '', year: '', batch: '', titleCode: '' })

watch(open, (value) => {
  if (!value || !props.file) return
  form.value = {
    source: props.file.source ?? '',
    kind: props.file.kind ?? '',
    year: props.file.year != null ? String(props.file.year) : '',
    batch: props.file.batch != null ? String(props.file.batch) : '',
    titleCode: props.file.titleCode ?? '',
  }
})

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

/** 下拉项一律从 `lib/labels.ts` 的单一来源取,不在这里重写中文 —— 避免文案漂移。 */
const SOURCE_ITEMS = SOURCE_ORDER.map((code) => ({ value: code, label: SOURCES[code] ?? code }))
const KIND_ITEMS = KIND_ORDER.map((code) => ({ value: code, label: KINDS[code] ?? code }))
const canSave = computed(
  () => !yearInvalid.value && !batchInvalid.value && !needsYear.value && !props.pending,
)
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>编辑文件元数据</DialogTitle>
        <DialogDescription class="break-all">
          {{ file?.filename }}
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-4">
        <!-- 只读:路径是磁盘事实,不由这里改。 -->
        <div class="bg-muted/60 flex flex-col gap-1 rounded-md border px-2.5 py-2">
          <span class="text-muted-foreground text-xs">库内路径(只读)</span>
          <code class="font-mono text-xs break-all">{{ file?.relPath }}</code>
        </div>

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
            <Label for="file-year" class="text-xs">公布年份</Label>
            <Input
              id="file-year"
              v-model="form.year"
              :disabled="pending"
              inputmode="numeric"
              maxlength="4"
              placeholder="2024"
              :aria-invalid="yearInvalid || needsYear || undefined"
            />
            <p class="text-muted-foreground text-[13px] leading-relaxed">
              目录给出的公布年份;留空表示未定。
            </p>
          </div>

          <div class="flex flex-col gap-1.5">
            <Label for="file-batch" class="text-xs">公布批次</Label>
            <Input
              id="file-batch"
              v-model="form.batch"
              :disabled="pending"
              inputmode="numeric"
              placeholder="1"
              :aria-invalid="batchInvalid || needsYear || undefined"
            />
            <p
              class="text-[13px] leading-relaxed"
              :class="needsYear ? 'text-destructive' : 'text-muted-foreground'"
            >
              {{ needsYear ? '填了批次就要同时填年份。' : '目录给出的公布批次;没有就留空。' }}
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

        <!-- `!` 压过 alertVariants 给说明文字加的那层 /90(深色下只剩 4.25:1)。 -->
        <Alert v-if="failure" variant="destructive">
          <AlertDescription class="text-destructive! font-medium">{{ failure }}</AlertDescription>
        </Alert>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="pending" @click="open = false">取消</Button>
        <Button :disabled="!canSave" @click="emit('save', form)">
          {{ pending ? '保存中…' : '保存' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
