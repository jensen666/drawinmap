# E2E 100 种用户图形样本

本目录是**测试夹具**，不是生产素材库：

- `manifest.json`：100 条“用户可能画的图形”输入，每条绑定一份真实 SVG 素材；
- 100 个 `.svg`：素材原件（约 600KB）；
- 用途：`node tools/reference/e2e-convert.mjs` 与 `node test/reference-e2e.mjs`，验证 100/100 都能转换成合法 T 点序列。

## 来源与许可

| 来源 | 数量 | 许可 |
| --- | ---: | --- |
| PhyloPic | 64 | CC0-1.0 / PDM-1.0 / CC-BY-4.0（逐条见 manifest） |
| Openclipart | 19 | Public-Domain |
| Font Awesome Free 6.7.2 | 17 | CC-BY-4.0 |

- 所有条目都在 `manifest.json` 中记录了 `source.name`、`source.url`、`source.license`、`source.attribution`；
- CC-BY-4.0 素材必须保留署名：PhyloPic 作者见对应条目，Font Awesome 署名为 `Font Awesome Free 6.7.2`；
- 这些文件仅用于测试转换链路，**不要**直接并入正式 manifest；
- 正式素材库仍是 `web/data/shapes/manifest.json` 的 7 个精选 seed。

## 生成方式

素材来自三处已审核的候选（PhyloPic 在线检索结果、Openclipart 公有领域对象、Font Awesome Free 实体图标），
通过脚本复制为夹具；每条输入的中文标签唯一，覆盖动物、建筑、交通、物品、食物、自然、符号、工具、角色、文化、音乐/运动等类型。
