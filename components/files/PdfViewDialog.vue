<script setup lang="ts">
import { computed, ref } from 'vue'
import FilePreview from '@/components/preview/FilePreview.vue'
import PageImageGallery from '@/components/preview/PageImageGallery.vue'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fileNameOf } from '~~/lib/preview'

/**
 * PDF 的查看弹窗:**原文 / 页图** 两个视图(票 13 的页图在这里看)。
 *
 * ── 为什么页图不另开一个行操作按钮 ──────────────────────────────────────
 * 文件表在 1440 视口下总宽 **1118px**、容器 **1124px** —— 只剩 6px。「编辑 / 预览 / 移出」
 * 三颗字按钮正好占满 138px 的操作列;再加一颗(即便只加 32px 的图标按钮)整张表就会回到
 * 横向滚动。而「1440 下不再横滚」是 `/files` 上一轮 UI 验收**逐列量过宽度**才拿到的结论
 * (见 `.scratch/ingest-pipeline/UI-ACCEPTANCE-files.md` 的列宽表),不能为了一颗按钮丢掉。
 *
 * PDF 的内容本来就有两种看法:**原文**(排版本身就是信息)与**页图**(逐页像素,给 OCR 用)。
 * 把这组选择放进"正在看这份文件"的那个弹窗里,既不挤表格,也让它在用户真正需要的地方出现。
 *
 * ── 几个刻意的选择 ──────────────────────────────────────────────────────
 *  - **视图选择保留上次的选择**:翻着看好几份 PDF 的页图是常见动作,每开一次都跳回「原文」
 *    等于每次都要多一次点击。关掉弹窗下次打开仍是上次那个视图。
 *  - **未激活的视图不挂载**(`Tabs` 默认行为,没开 `forceMount`):停在「页图」时 EmbedPDF
 *    根本不会初始化 —— 一个 PDF 查看器的开销不该为一个只看缩略图的人付。
 *  - **文件名常驻在切换条上**:弹窗是 92vh × 96vw 的近乎全屏,而两个视图各自带工具栏
 *    (页图那格的工具栏还没有文件名) —— 不摆一个,用户看到满屏的页图却没法确认这是哪一份。
 *    放在**次级位置**(`text-xs`、`text-muted-foreground`)是刻意的:它要能读到,不能跟
 *    主操作抢注意力。切换条因此从 `w-fit` 变成整行,文件名贴着 tab 之后、开关之前。
 *  - 弹窗**透明、不画框**(与 `FilePreviewDialog` 同一套做法):两个视图各自带卡片外壳,
 *    弹窗再画一层就成了卡片套卡片。视图切换条自己是一条卡片,是为了让右上角的关闭按钮
 *    压在**实心面**上 —— 直接浮在半透明遮罩上的深色图标等于看不见。
 *
 * 关闭按钮的**可点区**放宽到 32×32(见模板里的 `[&_[data-slot=dialog-close]]`):shadcn
 * 默认只有图标那么大(16px),在近乎全屏的弹窗里点起来太费劲。图标外观保持不变 ——
 * 只加 `size-8` 与居中,`X` 仍是 16px。这条是**本弹窗局部**的类,不动共享的
 * `components/ui/dialog/*`(它会同时改到别的弹窗)。
 */
const open = defineModel<boolean>('open', { default: false })

const props = withDefaults(
  defineProps<{
    /** 源 PDF 的地址(台账 / 文件页用 `fileUrl()` 拼成 `/api/files/<rel_path>`)。 */
    src: string
    /** 文件名,给两个视图的标题。 */
    name?: string
    /** 源 PDF 相对文件库根的路径 —— 页图接口按它取图。 */
    file: string
  }>(),
  { name: '' },
)

const title = computed(() => props.name || fileNameOf(props.src))
const view = ref<'pdf' | 'pages'>('pdf')
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="flex h-[92vh] w-[96vw] flex-col border-0 bg-transparent p-0 shadow-none sm:max-w-[min(1600px,96vw)] [&_[data-slot=dialog-close]]:top-3 [&_[data-slot=dialog-close]]:right-3 [&_[data-slot=dialog-close]]:z-10 [&_[data-slot=dialog-close]]:flex [&_[data-slot=dialog-close]]:size-8 [&_[data-slot=dialog-close]]:items-center [&_[data-slot=dialog-close]]:justify-center [&_[data-slot=dialog-close]]:rounded-md"
    >
      <DialogTitle class="sr-only">{{ title }}</DialogTitle>
      <DialogDescription class="sr-only">
        PDF 原文与页图两个视图。按 Esc 或点右上角关闭。
      </DialogDescription>

      <Tabs v-model="view" class="flex min-h-0 flex-1 flex-col">
        <!-- 文件名与视图切换同一条:近乎全屏的弹窗里,得有个地方能确认「这是哪一份」。
             它吃剩余宽度并 `truncate`,长文件名不会把两个 tab 挤走;`pr-9` 给右上角的
             关闭按钮留出位置,免得长名字压到它底下。 -->
        <div
          class="bg-card flex shrink-0 items-center gap-2 rounded-lg border py-1 pr-9 pl-1.5"
        >
          <TabsList aria-label="PDF 视图">
            <TabsTrigger value="pdf">原文</TabsTrigger>
            <TabsTrigger value="pages">页图</TabsTrigger>
          </TabsList>
          <span
            class="text-muted-foreground min-w-0 flex-1 truncate text-xs"
            :title="title"
          >
            {{ title }}
          </span>
        </div>

        <TabsContent value="pdf" class="flex min-h-0 flex-1 flex-col">
          <FilePreview class="min-h-0 flex-1" :src="src" :name="title" />
        </TabsContent>

        <TabsContent value="pages" class="flex min-h-0 flex-1 flex-col">
          <PageImageGallery class="min-h-0 flex-1" :file="file" />
        </TabsContent>
      </Tabs>
    </DialogContent>
  </Dialog>
</template>
