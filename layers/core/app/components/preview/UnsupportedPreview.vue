<script setup lang="ts">
import { computed } from 'vue'
import PreviewStates from '#core/app/components/preview/PreviewStates.vue'
import PreviewToolbar from '#core/app/components/preview/PreviewToolbar.vue'
import { describeUnsupported, fileNameOf, resolvePreviewKind } from '#core/lib/preview'

/**
 * 打不开的文件也要有一条工具栏。
 *
 * 之前这里只有一个空壳加一句提示:用户看得到「无法预览」,却看不到
 * **是哪个文件**打不开,也没法下载下来自己用 Office 打开。
 * 工具栏补上文件名与下载,说明复用 PreviewStates,措辞和图标与其它错误态一致。
 */
const props = withDefaults(
  defineProps<{
    src: string
    name?: string
  }>(),
  { name: '' },
)

const title = computed(() => props.name || fileNameOf(props.src))
const info = computed(() => resolvePreviewKind(props.src))
</script>

<template>
  <div class="bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
    <PreviewToolbar
      :title="title"
      :kind-label="info?.label ?? '不支持预览'"
      :unit="null"
      :href="src"
    />
    <PreviewStates status="unsupported" :message="describeUnsupported(src)" />
  </div>
</template>
