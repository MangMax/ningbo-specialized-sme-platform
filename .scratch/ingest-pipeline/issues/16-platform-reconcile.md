# 16 — 平台两接口:解释差异(外地/注销/外迁)

**What to build:** 接工信部平台的两个接口,给比对差异**加解释**:「为什么在平台内、不在公布文件内」。

**Blocked by:** 09

**Status:** review —— 已实现,**待主代理复核 + oil-ui 验收**(交付说明见文末)

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

---

## 交付(2026-10-14)

### 两个分支

| 仓库 | 分支 |
|---|---|
| `app` | `feat/platform-reconcile` |
| `pipeline` | `feat/platform-reconcile` |

### 实测更正:响应形态

票里写「`businessList` 返回 HTML 表格,不是 JSON」——**两半都对,但只看一半会静默出错**。实测(真实响应对照见 `pipeline/tests/fixtures/platform/`):

- `businessList` **不带** `?type=cx` ⇒ 返回 dwz 的整页 HTML:`<table name="businessListGrid">` **只有表头,tbody 是空的**,还有一句 `共0条`;真正的数据在**页尾嵌入式脚本** `(function(data){…})( {"zrarData":…} )` 里(`maxCount=4`)。
  ⇒ **只按 `<table>` 抓会得到 0 行**,把「平台有记录」误判成「平台亦无记录」——正是票里警告的「空结果蒙混」。
- `businessList?type=cx`(**分页表单自己的 action**)⇒ 直接返回同一份 `zrarData` JSON。
- `queryList` ⇒ 返回 `zrarData.grid.applyGrid` JSON(申报记录,`tyshxydm` 过滤有效)。

所以解析顺序定为 **JSON 信封 → HTML 里嵌入的 zrarData → 已渲染的 `<table>` 行**,三者都拿不到就**报错**,不返回空。客户端**发的是页地址本身**(不附加 `?type=cx`),所以线上走的就是 **HTML 那条路**,`?type=cx` 的 JSON 只是容错(报告里每条都记了实际走的是哪条:`parse=html-script` / `parse=json`)。

另一条兜底也收紧了:**表体空、又没有嵌入的 zrarData ⇒ 报错**(不把「表体空」当成 0 条)。真实 HTML 正好是「thead 在、tbody 空、页脚写共0条、数据在脚本里」,一旦脚本段没了,静默 0 条就会把「平台有记录」翻成「平台亦无记录」。

另一个实测:`businessList` 的过滤是 **(rdjb, tyshxydm) 双条件** —— 只给 `tyshxydm` 恒返回 0 条。

### 实现

**pipeline**(`feat/platform-reconcile`)

| 文件 | 作用 |
|---|---|
| `src/platform.ts` | 两个接口的客户端。HTML/JSON 双形态解析、会话过期识别、cookie 惰性读取、5xx 退避重试、本地 JSON 缓存(同企业不重复打外网) |
| `src/reconcile.ts` | **纯函数**差异解释;不改判据 |
| `scripts/reconcile.ts` | CLI(`pnpm reconcile`):调 app 自己的 `getComparison`(口径唯一来源)拿差异行 → 查平台 → 写解释缓存 + 证据报告 |
| `.env.example` | `MIIT_COOKIE` / `MIIT_COOKIE_FILE` 占位(凭据不入库) |
| `.gitignore` / `vite.config.ts` | 忽略 `.cache/`;夹具与生成报告排除格式化(夹具必须逐字节保留) |

**app**(`feat/platform-reconcile`)

| 文件 | 作用 |
|---|---|
| `lib/reconcile.ts` | 读解释缓存 + 按 `(统代\|name:<nameNorm>, 称号, 方向)` 附加到比对行 |
| `lib/labels.ts` | `RECONCILE_LABELS` / `RECONCILE_VARIANTS` / 文案 |
| `server/api/comparison.get.ts` | 读取时附加(缓存不存在 ⇒ `explanation: null`,比对不受影响) |
| `components/ComparisonReconcile.vue` | shadcn `Badge` + `Tooltip` |
| `pages/comparison.vue` | 新增「平台解释」列 + 脚注 |
| `nuxt.config.ts` | `reconcilePath` → `<app>/data/platform-reconcile.json`(可用 `NUXT_RECONCILE_PATH` 覆盖) |

**零 schema 变更**:不动 `db/schema.ts`、不建迁移、不写 `enterprise`/记录表。解释只落本地 JSON(计算在读取时)。

**流向与 `roster.db` 一致**:pipeline ──写──▶ `app/data/`,app 只读自己的 `data/`。解释缓存刻意**不放在 pipeline 目录里**,避免 app 反向依赖 pipeline(pipeline README 的「单向依赖」是硬约束)。

### 解释判据(按优先级)

1. 本地 `reg_status` 为注销/吊销 ⇒ **已注销**(平台两个接口都不提供注销状态);
2. 统代登记地**不在宁波**(行政区划码 ≠ 3302)⇒ **外地注册**(用户口径:「厂区在宁波但注册地在外省」);
3. 统代登记地在宁波、平台关联记录**全部**落在外地 ⇒ **已外迁**;
4. 关联记录全是「撤回」⇒ **已撤回**;
5. 关联记录非空 ⇒ **平台有记录**(`missing_in_miit` 方向措辞为「平台侧另有记录」);
6. 两者都空 ⇒ **平台亦无记录**;查询失败 ⇒ **未查询**(不冒充「无记录」)。

**判据不按方向白名单**:票的正文明说 `missing_in_miit` 只谈「有无平台记录」、`extra_in_miit` 才谈外地/注销/外迁;而 SPEC 引的用户原话是「不在**公布文件**的可能是外地企业,不在**导出文件**的可能注销/外迁」——**两句把同一批原因挂在了相反的方向上**。这里按证据判(外地/外迁/注销 是企业的性质,换个方向看还是同一件事),方向只影响措辞。

### 抽检:5 家「应出未出」

命令(pipeline 目录;cookie 走 `MIIT_COOKIE_FILE`,文件放在仓库外、不入库):

```bash
MIIT_COOKIE_FILE=<repo 外 0600 文件> pnpm reconcile \
  --title specialized_sme,innovative_sme --direction extra_in_miit \
  --report reports/platform-reconcile-20261014.md
```

底层两个请求(与客户端发出的完全一致 —— `businessList` 就是**页地址本身**,没有 `?type=cx`):

```bash
curl -sS --url 'https://zjtx.miit.gov.cn/zxqy/ZjtxxjrBusInfoManageBLH/businessList' \
  -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \
  -H 'X-Requested-With: XMLHttpRequest' -b "$MIIT_COOKIE" \
  --data-raw 'rdjb=2&tyshxydm=91440300MA5G2DGE3R&pageNum=1&numPerPage=50'
curl -sS --url 'https://zjtx.miit.gov.cn/zxqy/YzzxqyApplayBLH/queryList' \
  -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \
  -H 'X-Requested-With: XMLHttpRequest' -b "$MIIT_COOKIE" \
  --data-raw 'tyshxydm=91440300MA5G2DGE3R&pageNum=1&numPerPage=50'
```

报告里每条都记了**实际走的是哪条解析路径**:本次 59 家 businessList **全是 `parse=html-script`**
(即 `?` 的 HTML 分支),说明线上确实在按 HTML 读。

| # | 企业 | 统代 | 抽检结论 |
|---|---|---|---|
| 1 | 一临云（宁波）科技有限公司 | `91440300MA5G2DGE3R` | **外地注册**(统代登记地 440300 深圳) |
| 2 | 宁波尚闻科技（集团）有限公司 | `91110113MA004GK42A` | **外地注册**(110113 北京) |
| 3 | 宁波摩西网络科技有限公司 | `91330110MA2GMDFH58` | **外地注册**(330110 杭州) |
| 4 | 浙江扬铭科技发展有限公司 | `91110108330388458K` | **外地注册**(110108 北京) |
| 5 | 舜驱动力科技（宁波）有限公司 | `91310115MA1K4FBW1W` | **外地注册**(310115 上海) |

5 家都落在「外地」这一类(注销/外迁本批 0 家,见「已知缺口」)。响应摘要(HTML 响应里 `zrarData.grid.businessListGrid` 解析出的行,`parse=html-script`):

- **一临云（宁波）科技有限公司**(`91440300MA5G2DGE3R`,`rdjb=2`,maxCount=4)
  `qymc=一临云（深圳）科技有限公司 szsfmc=深圳市 cszt=终审通过 whpc=2023-1` / `qymc=一临云（宁波）科技有限公司 szsfmc=宁波市 cszt=待审核`
- **宁波尚闻科技（集团）有限公司**(`91110113MA004GK42A`,`rdjb=2`,maxCount=3)
  `qymc=北京尚闻科技（集团）有限公司 szsfmc=北京市 cszt=待审核 sqsj=2023-04-25 14:47:02` / `…szsfmc=宁波市`
- **宁波摩西网络科技有限公司**(`91330110MA2GMDFH58`,`rdjb=2`,maxCount=5)
  `qymc=杭州摩西科技发展有限公司 szsfmc=浙江省 cszt=市已审 whpc=2023-5` / `…浙江省 cszt=终审通过 whpc=2023-7` / `qymc=宁波摩西网络科技有限公司 szsfmc=宁波市 cszt=待审核`
- **浙江扬铭科技发展有限公司**(`91110108330388458K`,`rdjb=2`,maxCount=4)
  `qymc=北京扬铭科技发展有限责任公司 szsfmc=北京市 cszt=待审核 sqsj=2023-05-16 18:54:58`(4 条全在北京)
- **舜驱动力科技（宁波）有限公司**(`91310115MA1K4FBW1W`,`rdjb=2`,maxCount=1)
  `qymc=舜驱动力科技(南通)有限公司 szsfmc=江苏省 cszt=终审通过 whpc=2025-1`

> 注意平台回显的名称与本地名录**不是同一个写法**(深圳/北京/杭州/南通/江苏 主体),
> 这正是「外地注册」这条解释的直观证据。

全量(两个称号的 `extra_in_miit`,59 家)分布:**外地注册 18 · 平台有记录 41**。逐条原始响应片段见 `pipeline/reports/platform-reconcile-20261014.md`。

### 截图(app)

- `app/.scratch/ingest-pipeline/evidence/16-comparison-badges.png` —— 比对页「平台解释」列,25 行全部有徽章,其中 5 行 `外地注册`(上述抽检 1/2/3/4/5 都在第 1 页)。
- `app/.scratch/ingest-pipeline/evidence/16-comparison-tooltip.png` —— 悬停 一临云 的 `外地注册` 徽章,展开平台证据:`统代登记地 440300(非宁波);平台 4 条记录在深圳市、宁波市` + `平台关联 4 条 · 申报 0 条` + 取数时间。

> `.scratch/**/evidence/` 已 gitignore,截图只在本地;路径如上,复核时可直接打开。

### 测试

- pipeline `vp check` 全绿(0 error / 0 warning);`vp test run` **81 passed**(新增 28 条)。
  - HTML 表格解析:真实 HTML 响应做夹具,断言「它不是 JSON」「只按 `<table>` 抓会得到 0 行」以及从页尾脚本结构化出 4 行;另有合成夹具覆盖「已渲染成行」的兜底路径。
  - JSON 信封 / 外地省市记录 / 会话过期(301)· 登录页 · 看不懂的响应 · HTTP 5xx ⇒ 都**显式报错**,不返回空。
  - cookie 缺失 / 文件不存在、惰性读取(缓存命中不需要凭据)、缓存命中不重复请求、`refresh` 才重取、5xx 退避重试、4xx 与过期不重试。
  - 解释判据 7 类逐一断言。
- app `pnpm typecheck` 退出码 0;`pnpm test` **180 passed**(新增 10 条)。

### 交付清单

**已完成**

- 两个接口的客户端(HTML/JSON 双形态、`(rdjb, tyshxydm)` 过滤、分页参数)+ 会话过期显式报错。
- cookie 走 `MIIT_COOKIE` / `MIIT_COOKIE_FILE`,仓库只有 `.env.example` 占位。
- 本地 JSON 缓存(带时间戳,已 gitignore),同企业不重复打外网。
- 解释缓存 → app 读取时附加 → 比对页「平台解释」列(shadcn `Badge` + `Tooltip`);零 schema 变更、不改比对口径。
- 5 家抽检 + 全量 59 家分布 + 截图 + 报告。

**未完成**

- **`missing_in_miit`(应纳未纳)方向没有生成解释** —— 只跑了 `extra_in_miit`(票的验收面)。代码与 CLI 都支持,只是没执行:`--direction missing_in_miit` 会额外打 166 + 567 家的外网,没在那次窗口里跑。
- **oil-ui 验收未做** —— 按 README 规则,本票动了 `pages/`、组件,须另派 oil-ui 会话验收,由主代理执行;我没有自判通过。

**已知缺口**

- **「已注销」本批 0 家**:平台两个接口**都不提供注销状态**,该判据只能吃本地 `enterprise.reg_status`,而当前库里**全是 null**。也就是说这条解释目前**没有数据支撑,等于不可用** —— 要么补登记状态(工商侧),要么承认平台接口答不了「注销」。
- **「已外迁」本批 0 家**:本批 59 家里没有「统代登记在宁波、平台记录全在外地」的组合。判据可测(单测覆盖),但**没有真实样本**证明它在真实数据上会发生。
- **`businessList` 的省份字段是「申报省份」,不是「登记地」**:对外地企业,两者常一致(抽样 5 家一致);但理论上企业可在 A 地登记、到 B 地申报,那时「外地注册」说的是统代登记地,备注里会同时给出平台记录的省市,由经办人判断。
- **解释缓存要有人生成**:`app/data/platform-reconcile.json` 由 pipeline 写,过期/缺失时比对页那一列全是「—」(不报错)。生产部署要有人定期跑 `pnpm reconcile`;指不到文件时用 `NUXT_RECONCILE_PATH`。
- **缓存无 TTL 默认**(`maxAgeMs=null` 即永不过期),过期靠 `--refresh`;cookie 过期时**不写缓存**,所以不会把「会话过期」固化下来。

### 独立评审(Standards + Spec 两轴)与处理

按规程跑了 `code-review` 技能(两个并行子代理,分别只看标准与只看规格),下面是**意见与处理**:

| 评审意见 | 处理 |
|---|---|
| **app 反向依赖 pipeline**:`reconcilePath` 指向 `../pipeline/.cache/`,违反 pipeline README 的「单向依赖:pipeline → app」 | **已改**:解释缓存改写到 **`app/data/platform-reconcile.json`**(与 `roster.db` 同一流向),`nuxt.config.ts` 默认指本仓库 `data/` |
| **「按 HTML 解析」被反过来做**:客户端一律附加 `?type=cx` 拿 JSON,HTML 分支线上不可达 | **已改**:`businessList` 改问**页地址本身**(HTML),`?type=cx` 只留作容错;本次 59 家实测 `parse=html-script`,HTML 分支**真在跑**。另收紧了表体兜底:表体空且无嵌入数据 ⇒ **报错**(不再可能静默 0 条) |
| **`missing_in_miit` 措辞与票的口径不符**(该方向只谈「有无平台记录」) | **已改**:该方向有记录时措辞为「平台侧另有记录」。判据仍不按方向白名单,理由见上(票与 SPEC 的口径互相矛盾,已在代码注释与本文件写明) |
| **`isNingboUscc` 假设前两位是数字**,登记部门代码带字母时会误判 | **已改**:改为只比第 3–8 位(`/^.{2}3302/`),并补了民政(52)与字母前缀两种用例 |
| **新 CLI 没走 `vp run <script>` 约定、README 组成表未更新** | **已改**:加 `pnpm reconcile` 脚本,README 补「用法 / 组成 / 对照工信部平台」三处 |
| **`.env.example` 声称 `.secrets/` 已 gitignore,但实际没有** | **已改**:文案改为「优先放仓库外」,并把 `.secrets/` 也加进 `.gitignore` 作保险 |
| **跨仓库重复**:`reconcileKey` / 标签表 / 证据类型在两边各一份 | **保留**:两个独立仓库,没有共享包可放;两边注释都写明「必须同值」。这是已知的、有意的重复 |
| **一个原因要改两个仓库四处** | **保留**(同上);新增原因时改 `RECONCILE_REASONS` + `REASON_LABELS`(pipeline)与 `RECONCILE_LABELS` + `RECONCILE_VARIANTS`(app) |
| **`CachedPlatformClient` 与 `PlatformClient` 重复拼请求参数** | **已改**:抽出 `businessBody` / `applyBody`,请求体与缓存键共用 |
| **`direction: string` 而非 `ComparisonDirection`** | **已改**(app 侧);pipeline 侧仍是 `string` —— 那是跨仓库的传输格式,不引 app 的类型 |
| **`ReconcileEntry` 同时存 key 与构成它的字段** | **保留**:`key` 是留证与排障用的,app 侧在 `key` 缺失时会按字段重算,冗余是有用的 |
| 超出票面的东西(reason 码、`reconcile` 响应字段、fmt ignore、`.cache/` gitignore、报告文件) | **保留**:票里「实现方式自选」授权了;`.gitignore` / `fmt ignore` 是新产物的必要配套 |
