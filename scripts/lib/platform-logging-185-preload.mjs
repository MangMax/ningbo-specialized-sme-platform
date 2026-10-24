/** Test process only. Route platform fetches to real controlled HTTP; block external egress. */
const target = new URL(process.env.PLATFORM185_UPSTREAM)
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port) throw Error('Expected private loopback upstream')
if (process.env.MIIT_COOKIE !== '' && !process.env.MIIT_COOKIE?.startsWith('session=PRIVATE185_')) throw Error('Expected synthetic platform session')
const nativeFetch = globalThis.fetch
const paths = new Set(['/zxqy/YzzxqyApplayBLH/queryList', '/zxqy/ZjtxxjrBusInfoManageBLH/businessList', '/zxqy/ZjtxxjrBusInfoManageBLH/queryBusList'])
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.origin === 'https://zjtx.miit.gov.cn' && paths.has(url.pathname)) {
    if (init?.headers?.Cookie !== process.env.MIIT_COOKIE) throw Error('Expected synthetic request session')
    return nativeFetch(new URL(url.pathname, target), { ...init, redirect: 'error' })
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') throw Error('External fixture egress forbidden')
  return nativeFetch(input, { ...init, redirect: 'error' })
}
