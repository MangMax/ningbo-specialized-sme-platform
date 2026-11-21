<script setup lang="ts">
import type { SidebarProps } from '#core/app/components/ui/sidebar'
import { getAppModules } from '~~/lib/app-modules'
import NavMain from '#core/app/components/NavMain.vue'
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '#core/app/components/ui/sidebar'

const props = withDefaults(defineProps<SidebarProps>(), {
  collapsible: 'icon',
})

const colorMode = useAppColorMode()

const modules = getAppModules()
const businessModules = modules.flatMap(({ id, name, nav }) =>
  id !== 'core' && nav?.length ? [{ id, name, nav }] : [],
)
const coreNav = modules.find(module => module.id === 'core')?.nav ?? []
const sharedBusinessNav = coreNav.filter(item => item.placement === 'business')
const platformNav = coreNav.filter(item => item.placement !== 'business')
</script>

<template>
  <Sidebar v-bind="props">
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="lg"
            as-child
            tooltip="返回首页"
            class="group-data-[collapsible=icon]:justify-center"
          >
            <NuxtLink to="/" aria-label="返回首页">
              <img
                :src="colorMode === 'dark' ? '/brand/symbol-small-white.svg' : '/brand/symbol-small.svg'"
                alt=""
                width="24"
                height="24"
                class="size-6 shrink-0"
              />
              <span class="truncate text-sm font-medium group-data-[collapsible=icon]:hidden">
                专精特新
              </span>
            </NuxtLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>

    <SidebarContent>
      <section v-if="sharedBusinessNav.length || businessModules.length" aria-label="业务模块">
        <NavMain v-if="sharedBusinessNav.length" :items="sharedBusinessNav" />
        <NavMain
          v-for="module in businessModules"
          :key="module.id"
          :label="module.name"
          :items="module.nav"
        />
      </section>
      <section v-if="platformNav.length" aria-label="平台管理" class="mt-auto">
        <NavMain label="平台管理" :items="platformNav" />
      </section>
    </SidebarContent>

    <SidebarRail />
  </Sidebar>
</template>
