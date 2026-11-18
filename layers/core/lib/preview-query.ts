export function positiveInt(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw) : raw
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null
}

/** 只认**站内相对路径**:`/` 开头、但不是 `//host`(协议相对)也不是 `/\`。 */
export function isSafeBackPath(
  raw: unknown,
  applicationOrigin: string =
    typeof globalThis.location === 'undefined' ? 'http://app.invalid' : globalThis.location.origin,
): raw is string {
  if (
    typeof raw !== 'string' ||
    !/^\/(?!\/|\\)/.test(raw) ||
    /[\u0000-\u001f\u007f-\u009f]/.test(raw)
  ) {
    return false
  }

  try {
    const base = new URL(applicationOrigin)
    return new URL(raw, base).origin === base.origin
  } catch {
    return false
  }
}

export interface EvidencePreviewQuery {
  /** 相对文件库根的来源路径;没有就是空串(页面据此显示「缺 file 参数」)。 */
  file: string
  /** PDF 实际页序;给不出 / 不合法一律 `null`(不取整、不回落成 1)。 */
  page: number | null
  /** 返回目标(站内相对路径);不合法一律空串,由页面回落到台账首页。 */
  back: string
}

/**
 * 地址栏 → 预览页状态。**与 `evidencePreviewHref` 成对**,由单测做往返。
 *
 * `page` 非法时**丢掉**而不是夹到边界:地址栏里出现 `page=abc` / `page=0` / `page=-3`
 * 只可能是手改或拼接出错,这时最安全的动作是「打开这份文件但不定位」——
 * 硬凑成第 1 页会把一个坏参数变成一条看起来正常的定位。
 */
export function parseEvidencePreviewQuery(
  query: Record<string, unknown> | undefined,
  applicationOrigin?: string,
): EvidencePreviewQuery {
  const pick = (raw: unknown): string => {
    const v = Array.isArray(raw) ? raw[0] : raw
    return typeof v === 'string' ? v : ''
  }
  const back = pick(query?.back)
  return {
    file: pick(query?.file).trim(),
    page: positiveInt(pick(query?.page)),
    back: isSafeBackPath(back, applicationOrigin) ? back : '',
  }
}
