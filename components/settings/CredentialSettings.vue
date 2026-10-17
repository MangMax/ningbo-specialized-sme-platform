<script setup lang="ts">
import { shallowRef, watch } from 'vue'
import { AnimatePresence, motion, useReducedMotion } from 'motion-v'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import CredentialField from './CredentialField.vue'
import LoadingIndicator from './LoadingIndicator.vue'
import { useCredentialSettings } from '@/composables/useCredentialSettings'
const { replacement, state, raw, busy, pending, failed, message, canRead, load, save, clear, reveal } = useCredentialSettings()
const reducedMotion = useReducedMotion()

const activePlatform = shallowRef('ocrToken')
const platforms = [
  { key: 'ocrToken', tab: 'OCR', id: 'ocr-token', label: 'OCR token', description: '保存后供新任务使用，不会自动发起 OCR。' },
  { key: 'miitCookie', tab: '工信部平台', id: 'miit-cookie', label: '平台 Cookie', description: '保存后供新查询和核查任务使用，不会自动登录、刷新会话或发起核查。' },
] as const

// Switching platforms preserves drafts but removes any explicitly revealed secret.
watch(activePlatform, () => {
  raw.value = { ocrToken: '', miitCookie: '' }
  message.value = ''
  failed.value = false
})
watch(state, value => { if (!value) activePlatform.value = 'ocrToken' })
</script>

<template>
  <div class="flex w-full flex-col gap-6" :aria-busy="busy">
    <AnimatePresence>
      <motion.p v-if="!state && busy" role="status" class="text-muted-foreground flex items-center gap-2 text-sm"
        :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }" :transition="{ duration: reducedMotion ? 0 : 0.16 }">
        <LoadingIndicator :active="true" />正在读取密钥配置…
      </motion.p>
    </AnimatePresence>
    <Button v-if="!state && !busy" type="button" variant="outline" class="self-start" aria-label="重试加载密钥配置" @click="load">重试加载</Button>

    <Tabs v-if="state" v-model="activePlatform" class="gap-4">
      <div class="flex items-center justify-between gap-3">
        <TabsList aria-label="平台密钥配置" class="min-w-0 max-w-full overflow-x-auto">
          <TabsTrigger v-for="platform in platforms" :key="platform.key" :value="platform.key" :disabled="busy" class="disabled:opacity-100">
            {{ platform.tab }}
          </TabsTrigger>
        </TabsList>
        <Button type="button" variant="ghost" size="sm" aria-label="刷新密钥配置" :aria-busy="pending?.type === 'load'" :disabled="busy" @click="load">
          <LoadingIndicator :active="pending?.type === 'load'" />刷新
        </Button>
      </div>
      <TabsContent v-for="platform in platforms" :key="platform.key" :value="platform.key">
        <CredentialField
          v-if="state[platform.key]"
          :id="platform.id"
          :label="platform.label"
          :status="state[platform.key]"
          :raw="raw[platform.key]"
          v-model:replacement="replacement[platform.key]"
          :busy="busy"
          :operation="pending?.key === platform.key ? pending.type : undefined"
          :can-read="canRead[platform.key]"
          :description="platform.description"
          @save="save(platform.key)"
          @clear="clear(platform.key)"
          @reveal="reveal(platform.key, $event)"
        />
      </TabsContent>
    </Tabs>
    <p v-if="message" :role="failed ? 'alert' : 'status'" :class="failed ? 'text-destructive' : 'text-muted-foreground'" class="text-sm">{{ message }}</p>
  </div>
</template>
