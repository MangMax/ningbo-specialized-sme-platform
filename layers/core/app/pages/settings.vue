<script setup lang="ts">
import CredentialSettings from '#core/app/components/settings/CredentialSettings.vue'
import WorkspacePage from '#core/app/components/WorkspacePage.vue'
useHead({ title: '密钥配置 · 专精特新企业称号台账' })
</script>
<template>
  <WorkspacePage title="密钥配置">
    <div class="workspace-list-body overflow-y-auto overscroll-contain" role="region" aria-label="凭据设置表单" tabindex="0">
      <CredentialSettings />
    </div>
  </WorkspacePage>
</template>
