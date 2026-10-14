<script setup lang="ts">
import { computed } from 'vue'
import FilePreview from '@/components/preview/FilePreview.vue'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { fileNameOf } from '~~/lib/preview'

/**
 * 出处预览弹窗。把一个来源文件放大到接近整屏来读。
 *
 * **弹窗自己不画框、不画标题行,只借预览器那条工具栏。**
 *
 * 因为 `FilePreview` 的根元素已经带 `rounded-lg border bg-card`,弹窗再加一层
 * 就是套两层壳;上一版我先试了「弹窗透明 + 浮一条标题行」,结果是标题浮在
 * 应用自己的顶栏/侧栏上面,背景是页面本身,读起来像坏了。
 *
 * 现在的做法:弹窗透明无框,关闭按钮**挪进预览器工具栏那一行**的右端
 * (用 `[&_[data-slot=dialog-close]]` 改它的位置,`[&_[role=toolbar]]:pr-10`
 * 给工具栏留出这块空间)。这样全屏里只有一条工具栏、一个关闭按钮。
 * 标题走 `sr-only`,只为读屏保留。
 *
 * 打开即加载、关闭即销毁:查看器会连画布/引擎一起释放,不留着占内存。
 */
const open = defineModel<boolean>('open', { default: false })

const props = withDefaults(
  defineProps<{
    /** 文件地址(台账里用 fileUrl() 拼成 `/api/files/<source_file>`)。 */
    src: string
    /** 文件名,给工具栏标题;不给则取地址末段。 */
    name?: string
  }>(),
  { name: '' },
)

const title = computed(() => props.name || fileNameOf(props.src))
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="flex h-[92vh] w-[96vw] flex-col border-0 bg-transparent p-0 shadow-none sm:max-w-[min(1600px,96vw)] [&_[data-slot=dialog-close]]:top-2 [&_[data-slot=dialog-close]]:right-2 [&_[data-slot=dialog-close]]:z-10 [&_[role=toolbar]]:pr-10"
    >
      <DialogTitle class="sr-only">{{ title }}</DialogTitle>
      <DialogDescription class="sr-only">来源文件预览。按 Esc 或点右上角关闭。</DialogDescription>

      <FilePreview class="min-h-0 flex-1" :src="src" :name="title" />
    </DialogContent>
  </Dialog>
</template>
