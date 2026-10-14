# 10 — 上传与元数据:页面接 tus + 手动设来源/年份/批次

**What to build:** 把已存在的 tus 上传端点接到 `/files` 页;上传时可由用户**手动设置**来源 / 类别 / 年份 / 批次;也可留空(交给票 12 回写)。

**Blocked by:** 09

**Status:** ready

## 现状

- `server/utils/tus.ts` + `server/middleware/tus.ts` 已是**可用的写路径**,落位规则 `landingSegments`(纯函数)。
- `components/upload/` 下已有 `UploadPanel` / `UploadDropzone` / `MetadataFields` / `UploadItem`(oil-ui 打磨过)。**复用它们**,不要重写。

## 要做的

1. 把 `UploadPanel` 挂进 `/files` 页(或它的弹窗里)。
2. 上传完成后,把落位结果**登记进 `stored_file`**(票 09 的表):`rel_path`、大小、sha256;`source/kind/year/batch` 取用户填的,没填就是 `null` + `category_state='unset'`。
3. **metadata 校验**:来源/类别走白名单(沿用 `tus.ts` 的 `SOURCES`/`KINDS`);年份为四位数字;批次为正整数或空。
4. 若用户在**文件名**里已写明年份批次(如 `…2024年第2批…`),`MetadataFields` 可给**建议值**(复用 `lib/upload.ts` 的 `suggestBatch`/`fingerprint`),但**最终以用户填写为准**。

## 测试

- [ ] 上传成功 → `stored_file` 出现一行,`rel_path` 与磁盘一致。
- [ ] 元数据非法(来源不在白名单、年份非四位)→ 400,不落库。
- [ ] 上传未填元数据 → 行存在、`category_state='unset'`。

## 验收

- [ ] 在页面上传一个 PDF,能在列表看到它、来源/年份/批次与所填一致。
- [ ] 磁盘上文件落在 `files/<source>/<kind>/<year>/<batch>/` 规则路径。
- [ ] app 测试全绿。

**分支**:`feat/upload-metadata`。
