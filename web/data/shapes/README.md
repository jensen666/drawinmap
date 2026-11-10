# 参考图素材数据

正式素材库：**102 份**（2026-11-01 审核批次，seed 7 + E2E 素材合并 95；数量以审核清单为准，
不为凑数放行未审核资产）。同一对象的多版本是合法参考候选（马 3 / 狗 3 / 猫 2，其余 94 对象
单版本）。`queries.json` 是在线检索 shadow 的冻结查询集；在线下载物进 `cache/`（gitignore），
**不进入正式库、不继承 curated 身份**。

```
web/data/shapes/
├── manifest.json       # 唯一入口：来源、许可、署名、sha256、tags、人工审核块 review
├── queries.json        # 在线检索 shadow 的冻结查询集（114 条：PhyloPic + Openclipart）
├── README.md
├── seed/               # 首批精选 SVG 原文件（7 个）
├── library/            # 2026-11-01 审核批次并入的素材（95 个，源自 E2E 素材库）
└── cache/              # 在线检索下载/查询缓存与拒绝记录（gitignore，只由 Node 服务写入）
```

## 首批 seed 素材

| id | 中文 | 来源 | 许可 | 作者 |
| --- | --- | --- | --- | --- |
| `horse-phylopic` | 马 | PhyloPic（Equus ferus przewalskii） | CC0-1.0 | Andy Wilson |
| `cat-phylopic` | 猫 | PhyloPic（Felis chaus） | CC0-1.0 | Margot Michaud |
| `dog-phylopic` | 狗 | PhyloPic（Canis familiaris familiaris） | CC0-1.0 | Margot Michaud |
| `human-phylopic` | 人 | PhyloPic（Homo sapiens njarasensis） | CC0-1.0 | T. Michael Keesey |
| `pigeon-phylopic` | 鸽子 | PhyloPic（Columba livia） | CC0-1.0 | Amy Beauvois |
| `horse-openclipart` | 马 | Openclipart #282999 | Public-Domain | GDJ |
| `dog-openclipart` | 狗 | Openclipart #169096 | Public-Domain | nehtaeh79 |

## 扩容批次（2026-11-01）

- 合并工具：`node tools/reference/build-manifest.mjs --write`（SHA 去重、审核结论应用、
  全量转换校验；报告与审核图库写 `tools/reference/out-merge/`，gitignore）；
- 审核结论（visual=like + tags）在 `tools/reference/review-verdicts.json`，与素材 SHA 绑定，
  素材文件变化后必须重新审核；
- 入库需同时通过：许可白名单 + CC-BY 署名非空 + `convertSvg → normalizeCustomShape` 双通过 +
  人工视觉审核 like（审核图库做"原始 SVG ↔ T 轮廓"对照）；
- 语义拒绝：`heart` / `fa-star`（与内置星/心/矩形冲突，方案 §4.3 负例）、`tower`
  （针形跨度不达标，normalizeCustomShape 拒收）；
- 名称治理：`fa-cross` 中文别名定为「十字架」（避免「十字路口」劫持）；alias 负例冻结在
  `test/reference-browser.mjs`。

## 约束

- 所有素材均来自允许的开放许可；`manifest.json` 里有逐条源链接与许可链接。
- 给人看的署名表是 [ATTRIBUTION.md](ATTRIBUTION.md)（本目录不适用仓库根目录的 MIT 许可）。
- 不存在 CC-BY-NC / CC-BY-SA 素材；CC-BY-4.0 条目必须在 manifest 中保留署名字段。
- 素材文件变更后必须同步更新 `sha256` 与 `review.sha256`（二者必须一致），否则
  `loadManifest` 拒绝加载；浏览器加载时过滤非 `approved` 条目。
- 真实反例（多部分坐猫、碎片化霸王龙）放在 `test/fixtures/unsupported/`，**不进正式库**。
- 同对象多版本共享同一组中文名（如三匹马都叫「马」），版本差异靠 `tags` 与 §5.5 排序表达。

## 重新生成预览

```bash
node tools/reference/build-preview.mjs
```

生成物写入 `tools/reference/out/`（已 gitignore，可随时重建）。
