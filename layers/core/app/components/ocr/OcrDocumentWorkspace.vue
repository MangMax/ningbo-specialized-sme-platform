<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { FileSearch, FileText, FileWarning, RefreshCw } from '@lucide/vue'
import { Alert, AlertDescription } from '#core/app/components/ui/alert'
import { Button } from '#core/app/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '#core/app/components/ui/empty'
import { Skeleton } from '#core/app/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '#core/app/components/ui/tabs'
import type { OcrView } from '#core/app/composables/useOcrNavigation'
import type { WorkbenchRow } from '#core/lib/ocr-workbench'
import OcrPageRow from './OcrPageRow.vue'

const {
  currentRow,
  rowFailure,
} = defineProps<{
  selectedPath: string
  loadedPath: string
  contentMessage: string
  detailLoading: boolean
  detailError: string
  totalPages: number
  visibleCount: number
  currentRow: WorkbenchRow | null
  imageVersion: string | null
  editing: boolean
  dirty: boolean
  pendingPage: number | null
  rowFailure: { page: number; message: string; action: 'save' | 'delete' | 'read' | 'conflict' } | null
  needsRead: boolean
  justSaved: number | null
}>()
const emit = defineEmits<{
  reload: []
  retry: []
  clearFilters: []
  save: [page: number, markdown: string]
  remove: []
  preview: [trigger?: HTMLElement]
  render: []
}>()
const view = defineModel<OcrView>('view', { required: true })
const draft = defineModel<string>('draft', { required: true })
const workspace = useTemplateRef<HTMLElement>('workspace')
const pageRow = useTemplateRef<InstanceType<typeof OcrPageRow>>('pageRow')

const currentFailure = computed(() =>
  rowFailure && rowFailure.page === currentRow?.page ? rowFailure : null,
)

function focusEditor(reset?: boolean) {
  pageRow.value?.focusEditor(reset)
}

function focusCompare() {
  workspace.value?.querySelector<HTMLElement>('[aria-label="打开当前页对照"]')?.focus()
}

defineExpose({ focusEditor, focusCompare })
</script>

<template>
  <main
    ref="workspace"
    class="ocr-workspace-scroll relative min-h-0 flex-1 overflow-hidden"
    aria-label="校对内容"
  >
    <div
      v-if="!selectedPath"
      class="flex h-full items-center justify-center p-6"
    >
      <Empty class="border-0 bg-transparent">
        <EmptyHeader>
          <EmptyMedia variant="icon"><FileSearch /></EmptyMedia>
          <EmptyTitle>选择一份 PDF 开始校对</EmptyTitle>
        </EmptyHeader>
      </Empty>
    </div>

    <div
      v-else-if="detailLoading && !loadedPath"
      class="flex h-full flex-col gap-2 p-3"
    >
      <Skeleton class="h-10 w-full" />
      <Skeleton class="h-full w-full" />
    </div>

    <div
      v-else-if="detailError && !loadedPath"
      class="flex h-full items-center justify-center p-6"
    >
      <Empty class="border-0 bg-transparent">
        <EmptyHeader>
          <EmptyMedia variant="icon"><FileWarning /></EmptyMedia>
          <EmptyTitle>读不到这份文件的结果</EmptyTitle>
          <EmptyDescription>{{ detailError }}</EmptyDescription>
        </EmptyHeader>
        <Button
          variant="outline"
          size="sm"
          :disabled="detailLoading"
          @click="emit('reload')"
        >
          <RefreshCw />
          重试
        </Button>
      </Empty>
    </div>

    <div
      v-else-if="!totalPages"
      class="flex h-full items-center justify-center p-6"
    >
      <Empty class="border-0 bg-transparent">
        <EmptyHeader>
          <EmptyMedia variant="icon"><FileText /></EmptyMedia>
          <EmptyTitle>这一页还没有可校对的内容</EmptyTitle>
          <EmptyDescription>
            读不到这份 PDF 的页数（文件可能已损坏或被移走），所以列不出页码。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>

    <div
      v-else-if="!visibleCount && !currentRow"
      class="flex h-full items-center justify-center p-6"
    >
      <Empty class="border-0 bg-transparent">
        <EmptyHeader>
          <EmptyMedia variant="icon"><FileText /></EmptyMedia>
          <EmptyTitle>没有命中页</EmptyTitle>
          <EmptyDescription>
            调整条件或清除当前筛选，恢复这份文件的全部实际页。
          </EmptyDescription>
        </EmptyHeader>
        <Button
          variant="outline"
          size="sm"
          :disabled="dirty"
          @click="emit('clearFilters')"
          >清除页筛选</Button
        >
      </Empty>
    </div>

    <div v-else class="flex h-full min-h-0 flex-col">
      <!-- Native wrapper: the Reka Tabs root sits under motion-v's LayoutGroup,
           so a class/data-v placed on the Vue component root never lands on a DOM
           node. The wrapper is the element the scoped short-viewport rules target. -->
      <div class="ocr-view-tabs shrink-0 py-1.5 lg:hidden">
        <Tabs
          :model-value="view"
          class="gap-0"
          @update:model-value="(value) => view = String(value) as OcrView"
        >
          <TabsList class="grid w-full grid-cols-3" aria-label="校对视图">
            <TabsTrigger value="text">文本</TabsTrigger>
            <TabsTrigger value="image">页图</TabsTrigger>
            <TabsTrigger value="compare">对照</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <p v-if="loadedPath && contentMessage !== detailError" role="status" class="py-2 text-sm break-words">{{ contentMessage }}</p>
      <Alert
        v-if="detailError && loadedPath"
        variant="destructive"
        class="mt-2 shrink-0"
      >
        <AlertDescription class="text-destructive! font-medium">
          {{ detailError }}
          <Button
            variant="outline"
            size="sm"
            class="ml-2"
            @click="emit('retry')"
            >重试读取</Button
          >
        </AlertDescription>
      </Alert>

      <ul role="list" class="ocr-workspace-list min-h-0 flex-1">
        <Transition
          enter-active-class="transition duration-150 ease-snap motion-reduce:transition-none"
          enter-from-class="translate-y-1 opacity-0"
          leave-active-class="hidden"
        >
          <OcrPageRow
            v-if="currentRow"
            ref="pageRow"
            :key="`${selectedPath}:${currentRow.page}`"
            :row="currentRow"
            :file-path="selectedPath"
            :image-version="imageVersion"
            :editing="editing"
            :draft="draft"
            :pending="pendingPage === currentRow.page"
            :failure="currentFailure?.message ?? ''"
            :failure-action="currentFailure?.action ?? ''"
            :disabled="detailLoading || !!detailError || needsRead"
            :highlight="justSaved === currentRow.page"
            :view="view"
            class="h-full"
            @update:draft="draft = $event"
            @save="(page, markdown) => emit('save', page, markdown)"
            @remove="emit('remove')"
            @preview="(_page, trigger) => emit('preview', trigger)"
            @retry="emit('retry')"
            @render="emit('render')"
          />
        </Transition>
      </ul>
    </div>
  </main>
</template>

<style scoped>
/* Keep the document readable while the bottom bar stays in the shell. */
@media (max-height: 640px) {
  .ocr-workspace-scroll {
    overflow-y: auto;
  }
  .ocr-workspace-list {
    min-height: 340px;
  }
  .ocr-workspace-scroll :deep([data-ocr-page-row]) {
    min-height: 340px;
  }
  .ocr-workspace-scroll :deep(li:has(> div[data-ocr-compare-row])) {
    min-height: 520px;
  }
}

@media (max-height: 560px) {
  .ocr-view-tabs {
    padding-top: 0;
    padding-bottom: 0;
  }
  .ocr-view-tabs :deep([data-slot='tabs-list']) {
    height: 1.75rem;
  }
  .ocr-workspace-list {
    padding: 0;
  }
  .ocr-workspace-scroll :deep([data-ocr-pane-header]) {
    height: 2rem;
  }
  .ocr-workspace-scroll :deep([data-ocr-pane-footer]),
  .ocr-workspace-scroll :deep([data-ocr-horizontal-hint]) {
    display: none;
  }
}
</style>
