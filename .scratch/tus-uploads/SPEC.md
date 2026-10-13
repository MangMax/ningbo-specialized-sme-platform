# tus 上传接入(File Store 写路径)

> 追踪器:本地文件(`.scratch/tus-uploads/issues/`)。调研结论见 `../../.research/tus-research.md`;
> 边界见 [ADR-tus 上传落在 app](../docs/adr/2026-10-14-tus-uploads-in-app.md)。

## 问题陈述

文件库 `app/files/` 现在是**只读内化**的:源文件靠 pipeline 的 `build:files` 脚本一次性拷进来。没有让**用户**上传的能力——经办人拿到一份新公布文件,只能等开发者跑脚本;而文件是本台账的核心输入,理应由 app 承接。

## 解决方案

在 **app** 内接入 **tus** 断点续传上传:

- 服务端 `@tus/server` + `@tus/file-store`,经一个 Nitro 中间件 `server/middleware/tus.ts` 挂在 `/api/uploads`。
- 上传完成后,由服务端**按文件库规则**落位:把现有 `app/files/` 内化的 22 个文件,**重新按 tus 的落位规则上传一遍**验证一致。
- 前端用 `tus-js-client` 封装一个上传组件,**用 `oil-ui` 技能按现有 shadcn 组件库风格打磨**,含进度、拖拽、断点续传与错误提示。

## 关键约束(取自调研)

- **落位由服务端裁决**:客户端在 `Upload-Metadata` 里**声明** `source/kind/year/batch/filename`;服务端**白名单校验**(`source∈{jxj,miit}`、`kind∈{announcement,export}`、`year` 四位、`batch` 安全段、`filename` 无分隔符/`..`),再拼路径 `files/<source>/<kind>/<year>/<batch>/<filename>` 并 `rename`;**同名不覆盖**,追加 ` (n)`。
- **工作目录** `.incoming/` 与 `files/` 同卷。
- 中间件入口(不用 catch-all 路由);不引入 h3 v2。
- `maxSize` 设上限;`allowedOrigins` 限定;协议无鉴权 → 中间件先校验。

## 用户故事

1. 作为经办人,我想把一份新的公布文件拖进上传区,以便不依赖开发者就能入库。
2. 作为经办人,我想看到上传进度与结果(成功落在哪个路径),以便确认。
3. 作为经办人,我想在大文件断网后**继续传**,以便不从头再来。
4. 作为经办人,我想在元数据填错(来源/类别)时得到明确报错,以便改正。
5. 作为维护者,我想上传的落位规则与 `build:files` **完全一致**,以便两条写入路径不打架。
6. 作为维护者,我想同名文件**不被覆盖**,以便不丢历史。

## 实现决策

- **端点**:`server/middleware/tus.ts`,拦截 `event.path.startsWith('/api/uploads')`;`server/utils/tus.ts` 放 `Server` 单例与落位钩子。
- **落位钩子**:`onUploadCreate` 校验白名单,`onUploadFinish` 拼路径 + `rename`(防覆盖加后缀)。
- **重传验证**:把现有 `app/files/` 的 22 个文件走一遍 tus 上传,断言落到**相同路径**(或规则的等价路径)。
- **前端组件**:`tus-js-client` + shadcn-vue 组件,按 `oil-ui` 技能打磨(见票 04)。
- **不影响台账读路径**:上传只写 `app/files/`,不改数据库。

## 测试决策

- **落位规则**:单测(给一组 metadata → 目标路径;非法 metadata → 拒绝)。
- **协议端到端**:起 Nitro,用 `tus-js-client` 完成「创建 → 分片 → 中断 → 续传 → 落位」,断言文件存在且**逐字节一致**。
- **重传现有 22 个文件**:断言全部落到规则路径、内容一致。
- 只测外部行为(协议响应、落盘路径与内容),不测实现细节。

## 范围之外

- tus 的鉴权接入真实登录体系(本期先留接口/最小校验)。
- 对象存储(`@tus/s3-store`)。
- 从 PDF 自动提取替代手工 OCR。
