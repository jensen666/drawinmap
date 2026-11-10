# 第三方声明

仓库根目录的 [LICENSE](LICENSE)（MIT）只覆盖项目自有代码与文档。
下面这些材料各自保留原许可，不因随仓库分发而变成 MIT。

## Leaflet 1.9.4

`web/vendor/` 下的 `leaflet.esm.js`、`leaflet.css` 与 `images/` 是 Leaflet 1.9.4 的本地副本。

- 许可：BSD-2-Clause
- 版权：Copyright (c) 2010-2023 Volodymyr Agafonkin；Copyright (c) 2010-2011 CloudMade
- 全文：[web/vendor/leaflet-LICENSE.txt](web/vendor/leaflet-LICENSE.txt)

## OpenStreetMap

路网几何来自 OpenStreetMap 的衍生数据库（广州核心区裁剪，以及运行时按需下载的其他城市路网）。

- 许可：Open Database License 1.0（ODbL）
- 许可文本：<https://opendatacommons.org/licenses/odbl/1-0/>
- 署名：© OpenStreetMap contributors
- 版权与署名说明：<https://www.openstreetmap.org/copyright>
- 生成方式见 [mapdata/README.md](mapdata/README.md)

这些 JSON **不在** MIT 授权内。公开分发路网文件时，必须保留上述署名，并且衍生数据库继续以 ODbL 提供。

底图瓦片默认使用 OSM 社区镜像（`tile.openstreetmap.de`、`tile.openstreetmap.fr`，官方源仅作兜底）。
各瓦片服务有各自的使用政策。生产环境请自建瓦片或改用合规商业底图，不要用公共瓦片扛流量。
页面地图角标保留 “© OpenStreetMap contributors”。

## 参考素材

`web/data/shapes/`（正式库）与 `test/fixtures/e2e-shapes/`（测试夹具）中的 SVG 来自第三方，逐条许可记录在各自的 `manifest.json`。

| 来源 | 许可 | 义务 |
| --- | --- | --- |
| PhyloPic | CC0-1.0、PDM-1.0 或 CC-BY-4.0（逐条） | CC-BY 必须署名作者 |
| Openclipart | Public-Domain | 无强制署名；manifest 仍记录作者 |
| Font Awesome Free 6.7.2（仅图标 SVG） | CC-BY-4.0 | 署名为 “Font Awesome Free 6.7.2” |

- 正式库署名表：[web/data/shapes/ATTRIBUTION.md](web/data/shapes/ATTRIBUTION.md)
- 测试夹具说明：[test/fixtures/e2e-shapes/README.md](test/fixtures/e2e-shapes/README.md)
- Font Awesome Free 许可说明：<https://fontawesome.com/license/free>
- 在线检索只接受上述四类许可，CC-BY-SA / CC-BY-NC 会拒绝（见 `web/src/reference/licenses.js`）

## 名称

“DrawInMap” 这个名称不在 MIT 授权范围内。
