import * as L from '../vendor/leaflet.esm.js';
import { MAP_ZOOM } from './config.js';
import { createLogger } from './log/index.js';

/** 模块 logger */
const log = createLogger('map');

/** 未提供城市视野时的通用世界视野（仅兜底，正常由地点配置提供） */
const FALLBACK_VIEW = { center: { lat: 20, lng: 0 }, zoom: 2 };

/**
 * 把配置里的视野对象转成 Leaflet 需要的 [lat, lng]。
 *
 * @param {{center: {lat: number, lng: number}, zoom: number}} view 视野配置
 * @returns {{center: [number, number], zoom: number}} Leaflet 视野
 */
function toLeafletView(view) {
  return { center: [view.center.lat, view.center.lng], zoom: view.zoom };
}

/**
 * 创建地图实例：视野由地点配置注入，缩放范围与控件在此统一设置。
 *
 * @param {HTMLElement} container 地图容器 DOM
 * @param {{center: {lat: number, lng: number}, zoom: number}} [view] 默认视野
 * @returns {L.Map} Leaflet 地图实例
 */
export function createMap(container, view = FALLBACK_VIEW) {
  const initial = toLeafletView(view);
  const map = L.map(container, {
    center: initial.center,
    zoom: initial.zoom,
    minZoom: MAP_ZOOM.min,
    maxZoom: MAP_ZOOM.max,
    zoomControl: false,
    worldCopyJump: true,
  });

  // 缩放控件放右上角，避免与品牌卡、状态栏重叠
  L.control.zoom({ position: 'topright' }).addTo(map);

  // 比例尺放右下角
  L.control.scale({ position: 'bottomright', imperial: false, maxWidth: 140 }).addTo(map);

  // 署名前缀标注本项目
  map.attributionControl.setPrefix(
    'DrawInMap · <a href="https://leafletjs.com/" target="_blank" rel="noopener">Leaflet</a>',
  );

  log.info('map.created', { center: initial.center, zoom: initial.zoom });
  return map;
}

/**
 * 平滑飞回默认视野（按钮文案由调用方按城市配置设置）。
 *
 * @param {L.Map} map Leaflet 地图实例
 * @param {{center: {lat: number, lng: number}, zoom: number}} view 目标视野
 * @param {string} [label] 日志用标签
 */
export function flyToView(map, view, label = 'default') {
  const target = toLeafletView(view);
  map.flyTo(target.center, target.zoom, { duration: 0.8 });
  log.info('map.fly.toView', { label, center: target.center, zoom: target.zoom });
}
