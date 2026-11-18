const invisible = /[\u200B-\u200D\uFEFF\u3000]/gu

export function normalizeEnterpriseName(raw: string | number | boolean | null | undefined): string {
  return raw == null ? '' : String(raw)
    .replace(invisible, '')
    .replace(/[\s\u00A0]+/gu, '')
    .replace(/[（）()]/g, '')
    .replace(/[√✓、,，.。;；]+$/g, '')
    .trim()
}
