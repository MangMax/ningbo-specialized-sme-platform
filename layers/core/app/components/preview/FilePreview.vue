<script setup lang="ts">
import { computed } from 'vue'
import TextFilePreview from '#core/app/components/preview/TextFilePreview.vue'
import ImagePreview from '#core/app/components/preview/ImagePreview.vue'
import OfficePreview from '#core/app/components/preview/OfficePreview.vue'
import PdfPreview from '#core/app/components/preview/PdfPreview.vue'
import UnsupportedPreview from '#core/app/components/preview/UnsupportedPreview.vue'
import { resolvePreviewKind } from '#core/lib/preview'

/**
 * 文件预览入口。按扩展名分派到对应的预览器:
 *
 *   docx / xlsx / pptx → OfficePreview(@silurus/ooxml,画布渲染)
 *   pdf                → PdfPreview(EmbedPDF headless，共享只读阅读器)
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
    /** Standalone text pages already show the filename in their page heading. */
    hideTextName?: boolean
  }>(),
  { name: '', alt: '' },
)

const emit = defineEmits<{ error: [message: string] }>()

const info = computed(() => resolvePreviewKind(props.src) ?? (props.src.startsWith('blob:') ? resolvePreviewKind(props.name) : null))
</script>

<template>
  <TextFilePreview
    v-if="info && (info.kind === 'markdown' || info.kind === 'text')"
    :src="src"
    :name="name"
    :hide-name="hideTextName"
    :format="info.kind"
    :language="info.language"
    @error="emit('error', $event)"
  />
  <OfficePreview
    v-else-if="info && ['docx', 'xlsx', 'pptx'].includes(info.kind)"
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
