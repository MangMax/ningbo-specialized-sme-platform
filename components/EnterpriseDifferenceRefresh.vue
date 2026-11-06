<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/components/ui/button'

const props = defineProps<{ enterpriseIds: number[]; disabled?: boolean }>()
const emit = defineEmits<{ refreshed: [] }>()
const pending = ref(false)
const message = ref('')
const failure = ref(false)
async function refresh() {
  if (pending.value || props.disabled || !props.enterpriseIds.length) return
  const enterpriseIds = [...props.enterpriseIds]
  pending.value = true
  message.value = ''
  failure.value = false
  try {
    const result = await $fetch<{ refreshed: number; unchanged: number }>('/api/roster/differences/refresh', {
      method: 'POST', headers: { 'x-task-center-browser': '1' }, body: { enterpriseIds },
    })
    message.value = `已刷新 ${enterpriseIds.length} 家企业：${result.refreshed} 项更新，${result.unchanged} 项未变化`
    emit('refreshed')
  } catch {
    failure.value = true
    message.value = '刷新差异失败，请重试'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <Button variant="outline" size="sm" :disabled="disabled || pending || !enterpriseIds.length" @click="refresh">
      {{ pending ? '正在刷新…' : '刷新本页差异' }}
    </Button>
    <span v-if="message" role="status" class="text-xs" :class="failure ? 'text-destructive' : 'text-muted-foreground'">{{ message }}</span>
  </div>
</template>
