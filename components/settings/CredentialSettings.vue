<script setup lang="ts">
import { shallowRef, watch } from 'vue'
import { LoaderCircle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import CredentialField from './CredentialField.vue'
import { useCredentialSettings } from '@/composables/useCredentialSettings'
const { adminToken, replacement, state, raw, busy, failed, message, canRead, load, save, clear, reveal } = useCredentialSettings()

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
  <div class="flex max-w-3xl flex-col gap-6" :aria-busy="busy">
    <form class="space-y-3 rounded-lg border p-5" @submit.prevent="load">
      <Label for="settings-admin-token">API 管理 token</Label>
      <div class="flex flex-col gap-3 sm:flex-row">
        <Input id="settings-admin-token" v-model="adminToken" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="输入现有管理 token" class="min-w-0 flex-1" />
        <Button type="submit" variant="outline" :disabled="busy || !adminToken.trim()">
          <LoaderCircle v-if="busy" class="animate-spin motion-reduce:animate-none" />{{ busy ? '正在处理…' : '读取配置' }}
        </Button>
      </div>
      <p class="text-muted-foreground text-sm">管理授权仅在当前页面使用，离开后清理。</p>
    </form>

    <Tabs v-if="state" v-model="activePlatform" class="gap-4">
      <TabsList aria-label="平台密钥配置" class="max-w-full overflow-x-auto">
        <TabsTrigger v-for="platform in platforms" :key="platform.key" :value="platform.key" :disabled="busy">
          {{ platform.tab }}
        </TabsTrigger>
      </TabsList>
      <TabsContent v-for="platform in platforms" :key="platform.key" :value="platform.key">
        <CredentialField
          v-if="state[platform.key]"
          :id="platform.id"
          :label="platform.label"
          :status="state[platform.key]"
          :raw="raw[platform.key]"
          v-model:replacement="replacement[platform.key]"
          :busy="busy"
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
