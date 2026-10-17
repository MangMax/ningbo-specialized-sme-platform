<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import CredentialField from './CredentialField.vue'
import { useCredentialSettings } from '@/composables/useCredentialSettings'
const { adminToken, replacement, state, raw, busy, failed, message, canRead, load, save, clear, reveal } = useCredentialSettings()
</script>

<template>
  <div class="max-w-3xl space-y-6" :aria-busy="busy">
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

    <template v-if="state">
      <CredentialField id="ocr-token" label="OCR token" :status="state.ocrToken" :raw="raw.ocrToken" v-model:replacement="replacement.ocrToken" :busy="busy" :can-read="canRead.ocrToken" description="保存后供新任务使用，不会自动发起 OCR。" @save="save('ocrToken')" @clear="clear('ocrToken')" @reveal="reveal('ocrToken', $event)" />
      <CredentialField v-if="state.miitCookie" id="miit-cookie" label="平台 Cookie" :status="state.miitCookie" :raw="raw.miitCookie" v-model:replacement="replacement.miitCookie" :busy="busy" :can-read="canRead.miitCookie" description="保存后供新查询和核查任务使用，不会自动登录、刷新会话或发起核查。" @save="save('miitCookie')" @clear="clear('miitCookie')" @reveal="reveal('miitCookie', $event)" />
    </template>
    <p v-if="message" :role="failed ? 'alert' : 'status'" :class="failed ? 'text-destructive' : 'text-muted-foreground'" class="text-sm">{{ message }}</p>
  </div>
</template>
