<script setup lang="ts">
import { ref, watch } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'

/**
 * 移出文件库的确认框(票 09)。
 *
 * 默认**只移出库与索引,不删磁盘** —— 台账的出处仍指得到这个文件,所以默认动作是安全的。
 * 真删磁盘要**另勾一个框**(二次确认),因为那是不可逆的:出处会指向一个不存在的文件。
 *
 * 被记录引用时把引用数说出来,让用户知道后果,而不是替他决定能不能删。
 */
const open = defineModel<boolean>('open', { default: false })

const props = withDefaults(
  defineProps<{
    filename: string
    relPath: string
    /** 被多少条记录引用。> 0 时给一句提醒。 */
    referenceCount?: number
    pending?: boolean
    /** 上一次失败的说明;非空时显示。 */
    failure?: string
  }>(),
  { referenceCount: 0, pending: false, failure: '' },
)

const emit = defineEmits<{ confirm: [deleteDisk: boolean] }>()

/** 磁盘删除的二次确认勾选。每次打开都重置 —— 不能记住上次的危险选择。 */
const deleteDisk = ref(false)
watch(open, (value) => {
  if (value) deleteDisk.value = false
})
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>移出文件库</DialogTitle>
        <DialogDescription class="break-all">
          {{ filename }}
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-3">
        <p class="text-sm">
          将从文件库与索引里移除这个文件。
          <span class="text-foreground font-medium">磁盘上的文件默认保留。</span>
        </p>

        <p class="text-muted-foreground font-mono text-xs break-all">{{ relPath }}</p>

        <Alert v-if="referenceCount > 0" variant="destructive">
          <AlertDescription>
            有 {{ referenceCount }} 条记录把它作为出处。移出后这些记录的出处会指不到文件。
          </AlertDescription>
        </Alert>

        <!-- 危险动作单独勾选:默认不删盘,删盘是不可逆的。 -->
        <div class="flex items-start gap-2.5 rounded-md border border-destructive/40 p-2.5">
          <Checkbox
            id="delete-disk"
            :model-value="deleteDisk"
            class="mt-0.5"
            @update:model-value="(v) => (deleteDisk = v === true)"
          />
          <Label for="delete-disk" class="flex-col items-start gap-0.5 font-normal">
            <span class="text-sm">连磁盘文件一起删掉</span>
            <span class="text-muted-foreground text-xs">不可恢复,且无法再从台账预览它。</span>
          </Label>
        </div>

        <Alert v-if="failure" variant="destructive">
          <AlertDescription>{{ failure }}</AlertDescription>
        </Alert>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="pending" @click="open = false">取消</Button>
        <Button
          :variant="deleteDisk ? 'destructive' : 'default'"
          :disabled="pending"
          @click="emit('confirm', deleteDisk)"
        >
          {{ pending ? '处理中…' : deleteDisk ? '移出并删除磁盘文件' : '移出文件库' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
