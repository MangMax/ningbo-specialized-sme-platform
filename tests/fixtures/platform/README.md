# 平台接口夹具(RL-03)

来源:用户在已登录桌面 Chrome 会话中代取的真实响应
`orchestration-notes/platform-capture-91330211255994457P.json`(USCC `91330211255994457P`,
2026-10-15T17:11:21Z,四个请求均 HTTP 200)。

这些文件是**裁剪后的摘录**:每行只保留非空字段(真实响应每行有 ~347 个键,绝大多数恒为空串),
HTML 外壳与页尾 `(function(data){…})( {"zrarData":…} );` 脚本形态**逐字保留**。
**不含任何凭证 / cookie / token**;不放原始全文。

| 文件 | 对应请求 | 形态 | 用途 |
|---|---|---|---|
| `business-list-rdjb3.html` | businessList rdjb=3 | HTML + 内嵌 zrarData | 6 条关联逐条保留 |
| `business-list-rdjb1-empty.html` | businessList rdjb=1 | HTML + 内嵌 zrarData | 真实 `no_record`(0 行) |
| `business-list-rdjb2-empty.html` | businessList rdjb=2 | HTML + 内嵌 zrarData | 真实 `no_record`(0 行) |
| `apply-list.json` | queryList | 纯 JSON(Content-Type 却是 text/html) | 2 条申报记录 |
| `session-expired.json` | 会话过期 | HTTP 200 + statusCode 301 | `failed` ≠ `no_record` |
| `rendered-table.html` | — | 合成的最小已渲染表 | 三级回退的第三级(非真实响应) |
