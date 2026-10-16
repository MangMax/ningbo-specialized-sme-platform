import { useColorMode as useVueUseColorMode } from '@vueuse/core'

const COLOR_MODE_STORAGE_KEY = 'vueuse-color-scheme'

/**
 * The selected roster direction is light by default. Keep a deliberate dark
 * choice, but migrate VueUse's former implicit `auto` default to light so a
 * machine's dark OS setting does not replace the approved page direction.
 */
export function useAppColorMode() {
  if (import.meta.client) {
    try {
      if (window.localStorage.getItem(COLOR_MODE_STORAGE_KEY) === 'auto') {
        window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, 'light')
      }
    } catch {
      // VueUse handles unavailable storage and still applies the light default.
    }
  }

  return useVueUseColorMode({ selector: 'html', initialValue: 'light' })
}
