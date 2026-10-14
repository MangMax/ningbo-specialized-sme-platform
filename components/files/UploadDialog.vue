<script setup lang="ts">
import { ref, watch } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import UploadPanel from '@/components/upload/UploadPanel.vue'
import { describeFetchError, toRegisterBody, type UploadedFile } from '@/lib/upload-register'

/**
 * 「上传文件」弹窗(票 10):把已打磨过的 `UploadPanel` 装进弹窗,并在 tus 传完之后
 * 把落位结果**登记进 `stored_file`**。
 *
 * 为什么登记是**单独一次请求**,而不是让 tus 的 `onUploadFinish` 直接写库:
 *  - `server/utils/tus.ts` 的落位规则要保住「纯函数」这个性质(它现在可单测);
 *  - 写库失败时,文件**已经**落到磁盘了,在 tus 的完成响应里没法回滚 ——
 *    分开一次请求,失败就**看得见、说实话**,而且登记本身幂等,重试即可。
 *
 * 落位路径以 **tus 响应头 `X-Upload-Path`** 为准(同名防覆盖会加 ` (n)` 后缀,客户端
 * 算不出来),这里一个字都不重推。
 */
const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{
  /** 一份文件已登记进库 —— 调用方据此刷新列表。 */
  (e: 'registered'): void
}>()

/** 登记失败的说明;非空时显示。一份传完但没登记上的文件,必须说清它现在在哪。 */
const failure = ref('')
/** 已经因登记失败而滞留的落位路径(它们停在磁盘上,库里还没有)。 */
const stranded = ref<string[]>([])

watch(open, (value) => {
  if (!value) {
    failure.value = ''
    stranded.value = []
  }
})

async function onUploaded(file: UploadedFile) {
  failure.value = ''
  try {
    await $fetch('/api/files/register', { method: 'POST', body: toRegisterBody(file) })
    stranded.value = stranded.value.filter((p) => p !== file.relPath)
    emit('registered')
  } catch (error) {
    // 文件已落盘、库里没有 —— 不能假装成功,也不能把它藏起来。
    if (!stranded.value.includes(file.relPath)) stranded.value.push(file.relPath)
    failure.value = describeFetchError(error, '登记失败,请重试。')
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>上传文件</DialogTitle>
        <DialogDescription>
          拖入文件并填好落位信息;传完会自动登记进文件库列表。
        </DialogDescription>
      </DialogHeader>

      <!-- 登记失败:文件在盘上、库里没有。给路径,让人能自己去核对或重传。 -->
      <Alert v-if="failure" variant="destructive">
        <!-- `!` 是必须的:`alertVariants` 的 destructive 用
             `*:data-[slot=alert-description]:text-destructive/90` 给说明文字加了 90% 透明,
             深色下只剩 4.25:1(低于 4.5:1)。那条规则与 `.text-destructive` 同权重、
             位置更靠后,只有 important 压得过(与删除弹窗同一处处理)。 -->
        <AlertDescription class="text-destructive! font-medium">{{ failure }}</AlertDescription>
      </Alert>

      <div v-if="stranded.length" class="bg-muted/60 flex flex-col gap-1 rounded-md border px-3 py-2">
        <span class="text-muted-foreground text-xs">
          {{
            stranded.length === 1
              ? '它已经在文件库里,只是还没进列表。'
              : '它们已经在文件库里,只是还没进列表。'
          }}
        </span>
        <code
          v-for="path in stranded"
          :key="path"
          class="font-mono text-[13px] leading-relaxed break-all"
          >{{ path }}</code
        >
      </div>

      <!-- 面板自带无外壳布局:弹窗已经有标题,再套一层卡片就成了卡片套卡片。 -->
      <UploadPanel @uploaded="onUploaded" />
    </DialogContent>
  </Dialog>
</template>
