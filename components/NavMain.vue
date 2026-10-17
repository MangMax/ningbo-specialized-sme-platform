<script setup lang="ts">
import type { LucideIcon } from '@lucide/vue'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

defineProps<{
  label?: string
  items: {
    title: string
    url: string
    icon?: LucideIcon
  }[]
}>()

const route = useRoute()
/** 当前路由高亮:首页精确匹配,其余按前缀匹配(如 /enterprises/:id 归台账)。 */
const isActive = (url: string) =>
  url === '/' ? route.path === '/' : route.path.startsWith(url)
</script>

<template>
  <SidebarGroup>
    <SidebarGroupLabel v-if="label">{{ label }}</SidebarGroupLabel>
    <SidebarMenu>
      <SidebarMenuItem v-for="item in items" :key="item.title">
        <SidebarMenuButton as-child :is-active="isActive(item.url)" :tooltip="item.title">
          <NuxtLink :to="item.url">
            <component :is="item.icon" v-if="item.icon" />
            <span>{{ item.title }}</span>
          </NuxtLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  </SidebarGroup>
</template>
