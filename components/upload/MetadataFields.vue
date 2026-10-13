<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { FolderOpen } from '@lucide/vue'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { BatchMeta, KindCode, SourceCode } from '@/lib/upload'
import { KIND_OPTIONS, SOURCE_OPTIONS, landingPath } from '@/lib/upload'

/**
 * 落位信息表单:这一批文件算哪一类,由此决定它们进文件库的哪个格子。
 *
 * 声明是**一组**交出去(`update:meta`),不做四个独立的 v-model ——
 * 服务端校验与提交用的都是整组一致的声明。
 *
 * 文件名不在这里:它由投放的文件自带,只在下面显示为一句只读预览,避免手填的和
 * 实际文件对不上。
 */
const props = withDefaults(
  defineProps<{
    meta: BatchMeta
    /** 队列里下一个待处理文件的文件名,仅作预览(真正发出去的是每个文件自己的名字)。 */
    filename?: string
    /** 实时校验出的问题,由父组件算好(规则在 lib/upload.ts)。 */
    problems?: string[]
    disabled?: boolean
  }>(),
  { filename: '', problems: () => [], disabled: false },
)

const emit = defineEmits<{
  (e: 'update:meta', value: BatchMeta): void
}>()

/** 用户是否动过这一组声明 —— 动过之前不弹错误,免得一进来就是一片红。 */
const touched = ref(false)
watch(
  () => props.meta,
  () => {
    touched.value = true
  },
  { deep: true },
)

function patch(part: Partial<BatchMeta>) {
  touched.value = true
  emit('update:meta', { ...props.meta, ...part })
}

const yearInvalid = computed(
  () => props.meta.year.trim().length > 0 && !/^\d{4}$/.test(props.meta.year.trim()),
)
const batchInvalid = computed(
  () => props.meta.batch.trim().length > 0 && !/^\d+$/.test(props.meta.batch.trim()),
)
const needsYear = computed(() => Boolean(props.meta.batch.trim()) && !props.meta.year.trim())

/** 单行只读预览。 */
const preview = computed(() =>
  landingPath({
    ...props.meta,
    filename: props.filename || '…',
  }),
)

/**
 * 两项必需声明定下来、且手头有文件名之前不显示落位预览:否则路径里会带着占位符
 * (`?/…`)。与其画一条半截的路径,不如等它成为一条真路径再出现 —— 预览要可读,不是装饰。
 */
const showPreview = computed(() => Boolean(props.meta.source && props.meta.kind && props.filename))
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
      <div class="flex flex-col gap-1.5">
        <Label for="upload-source" class="text-xs">来源</Label>
        <Select
          :model-value="meta.source"
          :disabled="disabled"
          @update:model-value="(v) => patch({ source: (v ?? '') as SourceCode | '' })"
        >
          <SelectTrigger id="upload-source" class="w-full">
            <SelectValue placeholder="选择来源" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in SOURCE_OPTIONS" :key="option.value" :value="option.value">
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="upload-kind" class="text-xs">类别</Label>
        <Select
          :model-value="meta.kind"
          :disabled="disabled"
          @update:model-value="(v) => patch({ kind: (v ?? '') as KindCode | '' })"
        >
          <SelectTrigger id="upload-kind" class="w-full">
            <SelectValue placeholder="选择类别" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in KIND_OPTIONS" :key="option.value" :value="option.value">
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="upload-year" class="text-xs">年份</Label>
        <Input
          id="upload-year"
          :model-value="meta.year"
          :disabled="disabled"
          inputmode="numeric"
          maxlength="4"
          placeholder="2024"
          :aria-invalid="yearInvalid || needsYear || undefined"
          @update:model-value="(v) => patch({ year: String(v) })"
        />
        <p class="text-muted-foreground text-xs">可留空;填就填四位。</p>
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="upload-batch" class="text-xs">批次</Label>
        <Input
          id="upload-batch"
          :model-value="meta.batch"
          :disabled="disabled"
          inputmode="numeric"
          placeholder="1"
          :aria-invalid="batchInvalid || needsYear || undefined"
          @update:model-value="(v) => patch({ batch: String(v) })"
        />
        <p class="text-muted-foreground text-xs" :class="needsYear && 'text-destructive'">
          {{ needsYear ? '填了批次就要同时填年份' : '可留空;导出表、年份区间不落这一段。' }}
        </p>
      </div>
    </div>

    <!-- 落位预览:填的时候就能看见东西会去哪,不必等传完。 -->
    <div v-if="showPreview" class="bg-muted/60 flex items-center gap-2 rounded-md border px-2.5 py-1.5">
      <FolderOpen aria-hidden="true" class="text-muted-foreground size-3.5 shrink-0" />
      <span class="text-muted-foreground shrink-0 text-xs">将落位到</span>
      <code class="min-w-0 flex-1 truncate font-mono text-xs" :title="preview">
        {{ preview }}
      </code>
    </div>

    <!-- 校验提示只在**用户动过之后**出现;一进来就红一片(「请选择来源」)是指责,不是帮忙。 -->
    <p v-if="problems.length && touched" class="text-destructive text-xs">
      {{ problems.join(';') }}
    </p>
  </div>
</template>
