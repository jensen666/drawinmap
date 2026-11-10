# 参考图模块（web/src/reference）

独立参考图模块：把素材库的 SVG 剪影转换成

- **R**：高保真参考轮廓（回答“它是不是用户想要的东西”）
- **T**：可画目标轮廓（回答“转换后能不能交给现有引擎”）

并输出素材来源/许可/署名、转换指标、R/T 叠加预览；**已接入生产主流程**（本地多候选挑选 +
同源代理在线检索补漏，方案见
`docs/方案设计/2026-10-31-参考图素材扩容与多候选在线检索方案.md`、
实施记录见 `docs/archive/2026-11/实施记录/2026-11-01-参考图素材扩容与多候选在线检索实施记录.md`）。

## 当前范围

支持：

- 单个闭合外轮廓的简单剪影素材；
- `path` / `polygon` / `rect` / `circle` / `ellipse`；
- `g` 与元素上的 `transform`（matrix / translate / scale / rotate / skew）；
- `M/L/H/V/C/S/Q/T/A/Z` 路径命令（含相对命令、隐式重复）；
- 外环 / 孔洞 / 独立部分 / 杂散路径的显式分类；
- 素材 manifest 校验（来源、许可、署名、sha256）；
- R/T 叠加预览（HTML）与 JSON 报告；
- **在线检索 shadow**：PhyloPic（生物剪影）+ Openclipart（公有领域对象）检索、许可过滤、多候选排序、下载缓存、坏候选拒绝记录。

不支持（明确拒绝或警告，不静默误用）：

- 多部分图形（返回 `multi-part`）；
- 碎片化素材（杂散路径超过 8 条，返回 `fragmented-paths`）；
- 孔洞总面积超过主环 5%（返回 `holes-too-large`）；
- 未闭合主轮廓、自交/退化拓扑、空几何；
- 文本、图片、`use`、`clipPath`、`mask`、渐变、样式继承；
- 在线检索结果**接入生产**（当前只跑 shadow，未验收）；
- LLM 生成、用户上传图片提取（后续阶段）。

## 数据约定

- 源坐标：SVG 坐标系（y 向下）；
- T 坐标：`[-0.5, 0.5]`、y 向上、最长边为 1、包围盒居中，与现有 `customShape` 输入一致；
- R 与 T 共用同一套归一化参数，便于对比转换误差；
- T 默认 320 点（上限 512，兼容现有 `normalizeCustomShape`）；Openclipart 马这类带细毛刺的素材会用小容差 RDP 简化到 187 点，并在 `T.simplification` 中记录。

## 公共 API（`index.js`）

| 函数 | 作用 |
| --- | --- |
| `parseSvgDocument(svgText)` | SVG 文本 → 子路径 + viewBox + warnings |
| `parsePathData(d)` | path 数据 → 子路径点列 |
| `classifyRings(subpaths)` | 外环/孔洞/部分/杂散分类 |
| `convertSvg(svgText, options?)` | SVG → `{ status, reasons, warnings, diagnostics, R, T, metrics }` |
| `convertAsset(asset, baseDir, options?)` | 读取素材文件并转换 |
| `loadManifest(path)` / `validateManifest(obj, opts)` | 素材清单校验 |
| `renderOverlaySvg(conversion)` | R/T 叠加 SVG 字符串 |
| `buildReport({ manifestPath, outDir })` | 生成 `report.json`、`r-t/*.svg`、`index.html` |
| `buildNodeSearchUrl` / `buildImagesUrl` | PhyloPic 检索 URL（带 build、小写学名） |
| `parseNodeSearch` / `parseImages` | 解析节点与图片候选（许可/署名/矢量链接） |
| `rankCandidates(candidates, { scientificNames })` | 候选排序：精确节点 > 属/支系 > 许可 > 矢量/raster |
| `resolveReferenceShape({ query, searchCandidates, downloadSvg, convert })` | 检索 → 下载 → 转换 → 自动选择（依赖注入） |
| `fetchJson(url, { fetchImpl, retries })` | 带超时/重试的 JSON 请求 |
| `parseSearch` / `parseDetail` / `buildCandidate` | Openclipart 搜索结果/详情/候选解析（公有领域对象） |
| `relevanceScore` / `titleScore` | Openclipart 标题相关性与“剪影/图标”偏好排序 |

## 在线检索 shadow

```bash
# 冒烟 5 条
node tools/reference/shadow-retrieval.mjs --limit 5

# 全量 114 条冻结查询（有缓存会复用；--refresh 强制重新检索/下载）
node tools/reference/shadow-retrieval.mjs --delay 30

# 只跑指定查询
node tools/reference/shadow-retrieval.mjs --id house,car,sun
```

- 查询集：`web/data/shapes/queries.json`（114 条：PhyloPic 生物 66 条 + Openclipart 对象 48 条）；
- 下载缓存：`web/data/shapes/cache/phylopic/*.svg`、`cache/openclipart/*.svg`（gitignore，可重建）；
- 查询缓存：`web/data/shapes/cache/queries/*.json`；
- 坏候选拒绝记录：`web/data/shapes/cache/rejects.json`（30 天 TTL，避免反复下载/转换）；
- 输出：`tools/reference/out-shadow/report.json` + `index.html`（gitignore）。

对象类素材的已知限制：Openclipart 大量素材是多部件/大孔洞/线稿，单外轮廓策略会显式拒绝（`multi-part` / `holes-too-large`），所以对象查询的选中率明显低于生物剪影；这是素材形态问题，不是转换 bug。

报告口径（重要）：

- `geometryAutoSelectRate`：只表示“有候选池的查询里，自动选出了几何/许可可用的候选”，**不代表语义正确**；
- `matchLevel`：选中候选与查询学名的客观匹配级别（`exact` / `genus-or-clade` / `mismatch`），用于衡量自动选择质量；
- **语义是否真的“像”仍需人工/视觉评审**，不能拿自动选择率冒充出图率。

本机 2026-10-27 全量 shadow 结果与人工预检结论见
`docs/archive/2026-10/测试报告/2026-10-27-第二阶段在线检索shadow报告.md`。

## 多候选编排与在线检索（2026-11-01 接入生产）

两层返回结构（方案 §5.2）：

1. **raw 层**：`retrieval/resolve.js` 的 `resolveReferenceCandidates()`——候选池 → 许可过滤 →
   排序 → 最多 `maxAttempts=6` 次下载/转换，**收集全部成功候选**（raw candidate：
   `{ asset, conversion.T, matchedAlias, sourceSha256, origin, reviewStatus }`，T 是
   `convertSvg` 输出、不是 customShape）；旧单命中 `resolveReferenceShape()` 是"取第一项"的
   兼容包装（shadow 工具继续使用，真实链路验收后随旧主路径删除）。
2. **统一候选层（浏览器）**：`agent/reference.js` 的 `buildReferenceCandidates()`——统一
   `normalizeCustomShape` + `computeReferenceContentHash()`（`hash.js`：stableStringify + 纯 JS
   SHA-256，覆盖素材哈希 + 转换配置/版本 + 归一化版本 + 实际 customShape）；**归一化失败消耗
   候选池位置并记 failures，后续候选补位到 limit=3，不再次请求服务端**（§5.3）。

本地匹配（`browser.js`）：`matchReferenceAssets()` 返回同对象全部素材版本——单字中文别名
语境守卫、ASCII 别名词边界（`cat` 不命中 `category`）、多字别名的地名后缀守卫（月亮湾/苹果园
不劫持）、嵌套别名按最长归并（猫头鹰不被猫拆成两对象）、多对象请求按 ambiguous 整体让位给
LLM 链路；`rankLocalReferenceAssets()` 按 §5.5 分层（shapeName 精确 > traits∩tags >
R→T 最大偏差 > id 稳定；缺失侧整层跳过）。manifest 浏览器加载时过滤非 `approved` 条目。

在线检索（§9）：浏览器只请求同源 `/__reference/*`——

- `GET /__reference/ping`：能力探测（`{ok, sources, experimentalSources}`）；404/非预期结构
  自动关闭在线能力（纯静态托管场景），否定结果按会话缓存；
- `POST /__reference/search`：服务端（`online-service.js`）查询校验 → PhyloPic 检索 →
  主机白名单（不做开放代理）→ 下载缓存（`cache/` 查询 24h / 素材按来源 id / 拒绝记录 30d）→
  `convertSvg` → 返回 raw candidates（≤6 个，不含 customShape）；客户端断开取消上游；
- **Openclipart 是 experimental 源，默认关闭**（依赖 HTML 解析，§9.5）；
  `DRAWINMAP_EXPERIMENTAL_OPENCLIPART=1` 显式开启；
- 在线候选 `reviewStatus='unreviewed'`：必须经当前选择快照的用户确认
  （`chooseReferenceCandidate`）才能正式规划（`target-acceptance.js` 的 UI 之外第二道防御）；
  命中缓存不等于人工审核通过。

降级顺序固定：本地候选 → 在线候选 → 原 LLM 自由轮廓质检链路 → 诚实失败。

## 运行

```bash
# 生成素材清单校验 + R/T 转换报告与预览页
node tools/reference/build-preview.mjs

# 输出到指定目录
node tools/reference/build-preview.mjs --manifest web/data/shapes/manifest.json --out tools/reference/out
```

用浏览器打开 `tools/reference/out/index.html`：左侧原素材，右侧 R（紫虚线）/ T（蓝实线），
下方是宽高比、点数、R→T 偏差、来源/许可/署名。

## 测试

```bash
node test/reference-svg.mjs        # 解析/分类/归一化/拒绝分支（合成 SVG）
node test/reference-library.mjs    # 102 份正式素材全量回归（结构/审核/转换/去重/版本数）
node test/reference-convert.mjs    # 真实素材转换 + 2 个真实反例 + 报告输出
node test/reference-manifest.mjs   # manifest 校验与安全边界（含 review 块）
node test/reference-retrieval.mjs  # 检索/排序/编排/Openclipart 解析
node test/reference-candidates.mjs # 多候选编排 + 归一化补位 + contentHash + §5.5 排序
node test/reference-browser.mjs    # 浏览器本地源匹配（语境/词边界/消歧/碰撞负例）
node test/reference-choice.mjs     # 控制器待选/选择/双 trace/上下文与消息白名单
node test/reference-online.mjs     # 在线服务 + 浏览器客户端 + HTTP 端点
node test/reference-e2e.mjs        # 100 种用户图形 → T 的 E2E
```

测试只跑相关模块，不启动浏览器、不联网。

## 100 种图形 E2E

`test/fixtures/e2e-shapes/manifest.json` 是 100 条“用户可能画的图形”输入（中文标签唯一），
每条绑定一份真实 SVG：PhyloPic 64、Openclipart 19、Font Awesome Free 17。

```bash
node test/reference-e2e.mjs          # 100 条逐项断言 + 汇总
node tools/reference/e2e-convert.mjs # 生成 out-e2e/report.json + index.html
```

本机结果：**100/100 全部转成合法 T**，点数 92~320，最大 R→T 偏差 2.31%（≤3%）。
说明：这是“输入已绑定素材”的转换 E2E，不把检索选中率混入；检索 shadow 结果见下方报告。

## 素材清单

`web/data/shapes/manifest.json` 是唯一入口（2026-11-01 起 102 份：seed 7 + E2E 素材 95，
数量以审核清单为准）：

```json
{
  "version": 1,
  "assets": [
    {
      "id": "horse-phylopic",
      "names": { "zh": ["马"], "en": ["horse"] },
      "aliases": ["马", "horse"],
      "file": "seed/horse-phylopic.svg",
      "source": {
        "name": "PhyloPic",
        "url": "https://www.phylopic.org/images/...",
        "license": "CC0-1.0",
        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
        "attribution": "Andy Wilson"
      },
      "tags": ["行走", "侧面"],
      "sha256": "...",
      "review": { "status": "approved", "visual": "like", "reviewedAt": "2026-11-01", "sha256": "..." }
    }
  ]
}
```

- 许可白名单：`CC0-1.0` / `PDM-1.0` / `Public-Domain` / `CC-BY-4.0`；
- `CC-BY-4.0` 必须带 `attribution`；
- 文件路径必须是 manifest 目录内的相对路径，禁止 `..` 穿越；
- 每个素材都校验 sha256，防止素材被替换后指标失真；
- **人工审核块 `review` 必填**：`status='approved'` 且 `visual='like'` 才能入库，
  `review.sha256` 必须与素材 `sha256` 一致（素材变化后审核失效，Node 校验强制）；
- `tags` 是可选姿态/特征标签（只记图上明确可见内容），供 §5.5 traits 排序；
- 同对象多版本是合法候选（马 3 / 狗 3 / 猫 2），不是重复配置；
- 在线缓存素材不写进正式 manifest，也不继承 curated 身份；
- 素材扩容/合并用 `tools/reference/build-manifest.mjs`（去重/审核结论/转换校验，
  `--write` 才写正式 manifest）。

## 设计取舍

- **R/T 分离**：R 不迁就路网，T 才做可画化；转换误差单独量化，避免“路线贴合度”掩盖“参考图不像”。
- **外环优先 + 显式拒绝**：当前引擎只能消费一个闭合外轮廓；多部分/过大孔洞/碎片化宁可拒绝，也不静默取第一条路径。
- **孔洞处理**：小孔洞按外环填充并记录 warning；孔洞总面积超过 5% 直接拒绝（一笔画路线无法画出内环）。
- **拓扑口径对齐现有引擎**：T 直接使用 `web/src/engine/polygon.js`（纯几何唯一源；`agent/shape-validate.js` 为兼容 re-export）的 `validateSimplePolygon`，保证接入时不会“模块通过、引擎拒绝”。
- **RDP 兜底只针对不可画毛刺**：仅当均匀重采样后拓扑校验失败时才启用 0.2%~2% 的小容差 RDP，并在 `T.simplification` 留痕。

## 主流程接入

- **浏览器端**：`browser.js` 用 fetch 加载 `web/data/shapes/manifest.json` + 素材 SVG，
  `matchReferenceAssets` 匹配同对象多版本后经共享编排 `resolveReferenceCandidates` 下载/转换；
  不依赖 `node:fs`。
- **Agent 适配**：`web/src/agent/reference.js` 把 raw candidates 统一归一化 + contentHash
  （归一化失败补位），`createReferenceCandidateSource()` 组合本地 + 同源在线客户端。
- **控制器**：`web/src/agent/controller.js` 的 `executeIntent()` 内、`resolveTarget()` 之前
  统一解析参考候选（方案 §3）：本地单候选直走；2~3 本地 / 1~3 在线候选返回
  `referenceChoice` 待选（候选卡展示实际 T），`chooseReferenceCandidate()` 校验后开新规划轮
  trace 只规划选中 T；未命中/歧义/失败回退原 LLM 点列。
- **目标验收**：`target-acceptance.js` 按来源/审核状态差异化门槛——本地 curated 需审核哈希
  绑定；在线 unreviewed 未确认一律不得正式规划（§8）。
- **验证**：见 `docs/archive/2026-11/实施记录/2026-11-01-参考图素材扩容与多候选在线检索实施记录.md`。

## 后续（不在本阶段）

1. 在线候选的真实语义验收（需真实外网源 + 用户看图确认，方案前言要求）与 Openclipart
   experimental 评估（`DRAWINMAP_EXPERIMENTAL_OPENCLIPART=1`）；
2. 真实链路验收后删除旧单命中主路径（`resolveReferenceShape` 包装与
   `createReferenceShapeSource`）；
3. LLM 自由轮廓 / 参数化生成的通用多候选另案设计（不与参考素材候选混同）；
4. LLM 兜底策略（点列快速模式 / SVG 质量模式）另案评估。
