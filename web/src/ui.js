import { flyToView } from './map.js';

/**
 * 初始化界面交互：状态栏（中心坐标/缩放级别/底图状态）与"回到默认视野"按钮。
 *
 * @param {object} options
 * @param {L.Map} options.map Leaflet 地图实例
 * @param {HTMLButtonElement} options.locateButton "回到默认视野"按钮
 * @param {{center: HTMLElement, zoom: HTMLElement, tiles: HTMLElement}} options.statusEls 状态栏节点
 * @param {{center: {lat: number, lng: number}, zoom: number}} options.view 默认视野（来自地点配置）
 * @param {string} [options.locateLabel] 回到视野按钮文案
 * @param {string} [options.cityLabel] 城市显示名（日志用）
 * @returns {{ setTileStatus: (status: {state: string, source?: {name: string}}) => void }}
 */
export function initUi({ map, locateButton, statusEls, view, locateLabel, cityLabel }) {
  /** 当前底图源名称 */
  let sourceName = '--';

  /** 刷新中心坐标与缩放级别 */
  function updateViewStatus() {
    const center = map.getCenter();
    statusEls.center.textContent = `${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`;
    statusEls.zoom.textContent = String(map.getZoom());
  }

  map.on('moveend', updateViewStatus);
  map.on('zoomend', updateViewStatus);
  updateViewStatus();

  /**
   * 更新底图状态文案。
   *
   * @param {{state: 'loading'|'ready'|'failed', source?: {name: string}}} status 底图状态
   */
  function setTileStatus(status) {
    if (status.state === 'failed') {
      statusEls.tiles.textContent = '底图加载失败';
      statusEls.tiles.classList.add('is-error');
      return;
    }

    if (status.source) {
      sourceName = status.source.name;
    }

    statusEls.tiles.classList.remove('is-error');
    const suffix = status.state === 'loading' ? ' · 加载中…' : '';
    statusEls.tiles.textContent = `${sourceName}${suffix}`;
  }

  // "回到默认视野"：平滑飞行回配置里的城市视野
  if (locateLabel) {
    locateButton.textContent = locateLabel;
  }
  locateButton.addEventListener('click', () => {
    flyToView(map, view, cityLabel);
  });

  return { setTileStatus };
}
