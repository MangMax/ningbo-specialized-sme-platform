<script setup lang="ts">
import { shallowRef } from 'vue'
import { TASK_EXPORTS } from '../../../lib/sme-roster/task-exports'
import { Button } from '#core/app/components/ui/button'
import { Label } from '#core/app/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#core/app/components/ui/select'
const emit = defineEmits<{ created: [jobId: string] }>()
const title = shallowRef('specialized_sme')
const pending = shallowRef(false)
const failed = shallowRef(false)
let request: { titleCode: string; clientRequestId: string } | null = null
async function submit() {
  if (pending.value) return
  if (!request || request.titleCode !== title.value)
    request = { titleCode: title.value, clientRequestId: crypto.randomUUID() }
  pending.value = true
  failed.value = false
  try {
    const result = await $fetch<{ jobId: string }>(
      '/api/roster/correspondences/tasks',
      {
        method: 'POST',
        headers: { 'x-task-center-browser': '1' },
        body: request,
      },
    )
    request = null
    emit('created', result.jobId)
  } catch {
    failed.value = true
  } finally {
    pending.value = false
  }
}
</script>
<template>
  <section
    aria-label="生成公布事件候选"
    class="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
  >
    <div class="flex flex-wrap items-end gap-3">
      <div class="flex min-w-0 flex-col gap-2">
        <Label for="candidate-task-title">公布事件范围</Label>
        <Select v-model="title" :disabled="pending">
          <SelectTrigger id="candidate-task-title"
            ><SelectValue
          /></SelectTrigger>
          <SelectContent
            ><SelectGroup
              ><SelectItem
                v-for="entry in TASK_EXPORTS"
                :key="entry.titleCode"
                :value="entry.titleCode"
                >{{ entry.label }}</SelectItem
              ></SelectGroup
            ></SelectContent
          >
        </Select>
      </div>
      <Button :disabled="pending" @click="submit">{{
        pending ? '正在提交…' : failed ? '重试生成候选' : '生成候选'
      }}</Button>
    </div>
    <p class="text-muted-foreground text-sm">
      按事件顺序处理本称号的前200条正式认定/复核事件；完成后可继续下一片。仅生成待核候选，保留既有人工结论。新归档会自动处理受影响事件。
    </p>
    <p v-if="failed" role="alert" class="text-destructive text-sm">
      未确认受理，已保留所选范围。可显式重试，重复请求不会新建任务。
    </p>
  </section>
</template>
