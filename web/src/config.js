/**
 * 全局通用配置：地图缩放范围与瓦片源。
 *
 * 城市相关配置（默认视野、地标、示例话术）来自 `web/config/place-gazetteer.json`，
 * 由 `place-config.js` 加载并注入各模块，代码内不写死任何城市/地名。
 *
 * 网络说明（本机实测）：
 * - OSM 官方瓦片 tile.openstreetmap.org 与 CARTO 镜像直连超时；
 * - OSM 德国镜像 tile.openstreetmap.de 可正常访问（约 1~2s/瓦片）。
 * 因此默认使用德国镜像，官方源放在最后作为兜底。
 */

/** 地图缩放范围 */
export const MAP_ZOOM = {
  min: 3,
  max: 19,
};

/**
 * 底图瓦片源，按优先级排列。
 * 加载失败时自动降级到下一个源。
 */
export const TILE_SOURCES = [
  {
    id: 'osm-de',
    name: 'OSM 德国镜像',
    url: 'https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png',
    subdomains: 'abc',
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  },
  {
    id: 'osm-fr',
    name: 'OSM 法国镜像',
    url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
    subdomains: 'abc',
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · tiles by OSM France',
  },
  {
    id: 'osm-official',
    name: 'OSM 官方',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: 'abc',
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  },
];

/** 单个瓦片源判定失败前允许的最大错误瓦片数（未成功加载过任何瓦片时） */
export const TILE_ERROR_THRESHOLD = 8;
