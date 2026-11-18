<script setup lang="ts">
import { shallowRef, watch } from 'vue'
import { AnimatePresence, motion, useReducedMotion } from 'motion-v'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import CredentialField from './CredentialField.vue'
import LoadingIndicator from './LoadingIndicator.vue'
import { useCredentialSettings } from '@/composables/useCredentialSettings'
import { credentialGroups } from '@/lib/app-modules'
const { replacement, state, raw, busy, pending, failed, message, resetPresentation, load, save, clear, reveal } = useCredentialSettings()
const reducedMotion = useReducedMotion()

const initialModule = credentialGroups[0]?.id ?? ''
const activeModule = shallowRef(initialModule)

// Switching modules preserves drafts but removes any explicitly revealed secret.
watch(activeModule, resetPresentation)
watch(state, value => { if (!value) activeModule.value = initialModule })
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

    <Tabs v-if="state" v-model="activeModule" class="gap-4">
      <div class="flex items-center justify-between gap-3">
        <TabsList aria-label="模块密钥配置" class="min-w-0 max-w-full overflow-x-auto">
          <TabsTrigger v-for="group in credentialGroups" :key="group.id" :value="group.id" :disabled="busy" class="disabled:opacity-100">
            {{ group.name }}
          </TabsTrigger>
        </TabsList>
        <Button type="button" variant="ghost" size="sm" aria-label="刷新密钥配置" :aria-busy="pending?.type === 'load'" :disabled="busy" @click="load">
          <LoadingIndicator :active="pending?.type === 'load'" />刷新
        </Button>
      </div>
      <TabsContent v-for="group in credentialGroups" :key="group.id" :value="group.id" class="space-y-4">
        <template v-for="credential in group.credentials" :key="credential.key">
          <CredentialField
            v-if="state[credential.key]"
            :id="credential.key"
            :label="credential.name"
            :status="state[credential.key]"
            :raw="raw[credential.key]"
            v-model:replacement="replacement[credential.key]"
            :busy="busy"
            :operation="pending?.key === credential.key ? pending.type : undefined"
            :description="credential.description"
            :sensitive="credential.sensitive"
            @save="save(credential.key)"
            @clear="clear(credential.key)"
            @reveal="reveal(credential.key, $event)"
          />
        </template>
      </TabsContent>
    </Tabs>
    <p v-if="message" :role="failed ? 'alert' : 'status'" :class="failed ? 'text-destructive' : 'text-muted-foreground'" class="text-sm">{{ message }}</p>
  </div>
</template>
