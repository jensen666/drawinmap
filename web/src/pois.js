import * as L from '../vendor/leaflet.esm.js';
import { createLogger } from './log/index.js';

/** 模块 logger */
const log = createLogger('pois');

/**
 * 创建地标圆点图标：使用 divIcon 避免 Leaflet 默认图片图标的资源路径问题。
 *
 * @returns {L.DivIcon} 地标图标
 */
function createPoiIcon() {
  return L.divIcon({
    className: 'poi-icon',
    html: '<span class="poi-dot"></span>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

/**
 * 在地图上添加地标标记（悬浮显示名称，点击弹出详情）。
 *
 * @param {L.Map} map Leaflet 地图实例
 * @param {Array<{name: string, category: string, lat: number, lng: number}>} pois 地标列表（来自地点配置）
 * @returns {L.LayerGroup} 地标图层组
 */
export function addPois(map, pois = []) {
  const group = L.layerGroup();
  const icon = createPoiIcon();

  for (const poi of pois) {
    const marker = L.marker([poi.lat, poi.lng], {
      icon,
      title: poi.name,
      riseOnHover: true,
    });

    marker.bindTooltip(poi.name, {
      direction: 'top',
      offset: [0, -10],
      className: 'poi-tooltip',
    });

    marker.bindPopup(`
      <div class="poi-popup">
        <strong>${poi.name}</strong>
        <span>${poi.category}</span>
        <span class="poi-coord">${poi.lat.toFixed(4)}, ${poi.lng.toFixed(4)}</span>
      </div>
    `);

    group.addLayer(marker);
  }

  group.addTo(map);
  log.info('poi.added', { count: pois.length });
  return group;
}
