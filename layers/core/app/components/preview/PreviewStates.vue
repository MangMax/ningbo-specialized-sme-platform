<script setup lang="ts">
import { computed } from 'vue'
import { FileWarning, Loader2, Unplug } from '@lucide/vue'
import { Button } from '#core/app/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '#core/app/components/ui/empty'
import { Progress } from '#core/app/components/ui/progress'

/**
 * 预览器内部的加载态与错误态。三个预览器共用,保证「正在读」和「读不了」
 * 在哪儿都长一个样。
 *
 * 「读不到」和「读不了」用**两个不同的图标**分开:前者是文件不在/连不上
 * (断开的插头),后者是格式不受支持(带警示的文档)。只差一行文案的话,
 * 扫一眼分不出来。
 */
const props = withDefaults(
  defineProps<{
    status: 'loading' | 'ready' | 'error' | 'unsupported'
    /** 错误 / 不支持时的一句说明。 */
    message?: string
    /** 加载进度 0–100;不给就转圈。 */
    progress?: number | null
    /** 出错时可否重试。 */
    retryable?: boolean
  }>(),
  { message: '', progress: null, retryable: false },
)

defineEmits<{ retry: [] }>()

const isLoading = computed(() => props.status === 'loading')
const hasProgress = computed(() => isLoading.value && props.progress != null)
const isUnsupported = computed(() => props.status === 'unsupported')
</script>

<template>
  <div
    v-if="isLoading"
    class="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8"
    role="status"
    aria-live="polite"
  >
    <Loader2 class="size-5 motion-safe:animate-spin" aria-hidden="true" />
    <div v-if="hasProgress" class="flex w-56 flex-col items-center gap-2">
      <Progress :model-value="progress ?? 0" class="h-1" />
      <span class="text-xs tabular-nums">正在读取 {{ Math.round(progress ?? 0) }}%</span>
    </div>
    <span v-else class="text-xs">正在读取文件…</span>
  </div>

  <Empty v-else class="flex-1 border-0">
    <EmptyHeader>
      <EmptyMedia variant="icon">
        <FileWarning v-if="isUnsupported" />
        <Unplug v-else />
      </EmptyMedia>
      <EmptyTitle>{{ isUnsupported ? '这个格式打不开' : '文件打不开' }}</EmptyTitle>
      <EmptyDescription>
        {{ message || (isUnsupported ? '当前格式不在预览范围内。' : '读取文件时出错了。') }}
      </EmptyDescription>
    </EmptyHeader>
    <Button v-if="retryable" variant="outline" size="sm" @click="$emit('retry')">重试</Button>
  </Empty>
</template>
