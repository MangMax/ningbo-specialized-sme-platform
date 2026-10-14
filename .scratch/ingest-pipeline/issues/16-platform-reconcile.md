# 16 — 平台两接口:解释差异(外地/注销/外迁)

**What to build:** 接工信部平台的两个接口,给比对差异**加解释**:「为什么在平台内、不在公布文件内」。

**Blocked by:** 09

**Status:** ready

## 两接口(已实测)

| 接口 | 用途 |
|---|---|
| `POST /zxqy/ZjtxxjrBusInfoManageBLH/businessList` | 企业关联记录;`rdjb`:1 创新型 / 2 专精特新 / 3 小巨人。`tyshxydm` 传统代。 |
| `POST /zxqy/YzzxqyApplayBLH/queryList` | 申报记录,字段多,**分页**(`numPerPage`/`pageNum`)。 |

**已实测**:`businessList` 带用户给的 cookie **返回 200**,但**是 HTML 表格**(旧式 `dwz` 的 `businessListGrid`),**不是 JSON** ⇒ **按 HTML 表格解析**。

**cookie 会过期**(会话级)⇒ **必须可配**(页面/环境变量),且**过期要有明确提示**(不是静默空结果)。

## 口径(用户原话归纳)

> **以公布文件为准**,对照导出文件;**不在公布文件的需补充**(可能是**外地企业**),**不在导出文件的**(可能**注销 / 外迁**)。

⇒ 比对页的每一行差异,尽量**给一句解释**:
- `missing_in_miit`(在经信局、不在工信部)→ 查平台:`businessList` 有无 → 无 = 确未纳入 / 有 = 平台侧另有记录;
- `extra_in_miit`(在工信部、不在经信局)→ 查平台:**外地注册 / 已注销 / 已外迁 / 漏公布**。

## 要做的

1. `pipeline` 侧封装这两个接口(**可配 cookie**),解析 HTML 表格(别当 JSON)。
2. 给 `enterprise` 或比对行补**解释字段**(如 `reconcile_note` + `explained_by`),**不改判据**。
3. 比对页把这句解释**显示在行上**(shadcn `Badge`/`Tooltip`)。
4. **缓存**:同一企业别反复打外网;结果落本地(带时间戳)。

## 测试

- [ ] 解析器的 fixture:一段真实 HTML 表格 → 结构化行。
- [ ] cookie 失效 → **显式报错**,不返回空。
- [ ] 缓存命中不重复请求。

## 验收

- [ ] 抽 5 家「应出未出」,平台能解释出「外地 / 注销 / 外迁」中的哪一类。
- [ ] 比对页那 5 行**显示解释**。
- [ ] 测试全绿。

**分支**:`feat/platform-reconcile`。
