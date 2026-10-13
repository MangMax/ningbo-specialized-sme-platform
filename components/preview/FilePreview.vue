<script setup lang="ts">
import { computed } from 'vue'
import ImagePreview from '@/components/preview/ImagePreview.vue'
import OfficePreview from '@/components/preview/OfficePreview.vue'
import PdfPreview from '@/components/preview/PdfPreview.vue'
import UnsupportedPreview from '@/components/preview/UnsupportedPreview.vue'
import { resolvePreviewKind } from '~~/lib/preview'

/**
 * 文件预览入口。按扩展名分派到对应的预览器:
 *
 *   docx / xlsx / pptx → OfficePreview(@silurus/ooxml,画布渲染)
 *   pdf                → PdfPreview(EmbedPDF,自带完整界面)
 *   png / jpg / webp…  → ImagePreview(自研)
 *
 * 调用方只给一个地址和名字,不用关心后面用哪个库。
 * 不支持的格式在这里给一句说得清楚的说明,不让它掉到空白里。
 *
 * 组件不自带高度 —— 它撑满父容器。放在弹窗、抽屉还是整页里由调用方决定,
 * 所以父级要给一个确定的高度(如 `h-[80vh]` 或 flex 布局里的 `flex-1`)。
 */
const props = withDefaults(
  defineProps<{
    /** 文件地址:URL、同源路径或 blob:。 */
    src: string
    /** 文件名,用于工具栏标题;不给则取地址末段。 */
    name?: string
    /** 图片的替代文本。 */
    alt?: string
  }>(),
  { name: '', alt: '' },
)

const emit = defineEmits<{ error: [message: string] }>()

const info = computed(() => resolvePreviewKind(props.src))
</script>

<template>
  <OfficePreview
    v-if="info && info.kind !== 'pdf' && info.kind !== 'image'"
    :src="src"
    :name="name"
    :kind="info.kind"
    @error="emit('error', $event)"
  />
  <PdfPreview
    v-else-if="info && info.kind === 'pdf'"
    :src="src"
    :name="name"
    @error="emit('error', $event)"
  />
  <ImagePreview
    v-else-if="info && info.kind === 'image'"
    :src="src"
    :name="name"
    :alt="alt"
    @error="emit('error', $event)"
  />
  <UnsupportedPreview v-else :src="src" :name="name" />
</template>
