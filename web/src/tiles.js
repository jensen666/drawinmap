import * as L from '../vendor/leaflet.esm.js';
import { TILE_SOURCES, TILE_ERROR_THRESHOLD } from './config.js';
import { createLogger } from './log/index.js';

/** 模块 logger（瓦片失败是网络问题定位的重要证据） */
const log = createLogger('tiles');

/**
 * 底图控制器：负责挂载瓦片图层，并在当前源加载失败时自动切换备用源。
 *
 * 判定规则：当前源未成功加载过任何瓦片、且累计错误瓦片数达到阈值时，
 * 视为该源不可用，自动切换到下一个源；全部源都失败时回调 onAllFailed。
 */
export function createTileController(map, { onSourceChange, onStateChange, onAllFailed } = {}) {
  /** 当前源索引 */
  let sourceIndex = 0;
  /** 已尝试过的源索引集合，避免重复尝试 */
  const tried = new Set();
  /** 当前源累计错误瓦片数 */
  let errorCount = 0;
  /** 当前源累计成功瓦片数 */
  let loadedCount = 0;
  /** 当前 Leaflet 瓦片图层 */
  let layer = null;

  /** 上报状态变化，供 UI 更新 */
  function reportState(state) {
    const source = TILE_SOURCES[sourceIndex];
    log.info('tiles.state', { state, source: source.name, sourceId: source.id, index: sourceIndex });
    if (onStateChange) {
      onStateChange({ state, source: TILE_SOURCES[sourceIndex], index: sourceIndex });
    }
  }

  /** 挂载指定索引的瓦片源 */
  function mount(index) {
    const source = TILE_SOURCES[index];
    if (!source) {
      return;
    }

    if (layer) {
      map.removeLayer(layer);
    }

    sourceIndex = index;
    tried.add(index);
    errorCount = 0;
    loadedCount = 0;

    layer = L.tileLayer(source.url, {
      subdomains: source.subdomains,
      maxZoom: source.maxZoom,
      minZoom: 0,
      attribution: source.attribution,
      crossOrigin: true,
      updateWhenIdle: false,
      detectRetina: false,
    });

    // 瓦片成功加载：记录，供 fallback 判定使用
    layer.on('tileload', () => {
      loadedCount += 1;
      if (loadedCount === 1) {
        reportState('ready');
      }
    });

    // 瓦片加载失败：未成功加载且错误数达到阈值时切换到下一个源
    layer.on('tileerror', (event) => {
      errorCount += 1;
      log.warn('tiles.tile.error', {
        src: event.tile?.src ?? '(unknown)',
        errorCount,
        loadedCount,
        source: TILE_SOURCES[sourceIndex].name,
      });
      if (loadedCount === 0 && errorCount >= TILE_ERROR_THRESHOLD) {
        fallback();
      }
    });

    layer.addTo(map);
    reportState('loading');

    if (onSourceChange) {
      onSourceChange(source, index);
    }
  }

  /** 切换到下一个可用源 */
  function fallback() {
    for (let i = 0; i < TILE_SOURCES.length; i += 1) {
      if (!tried.has(i)) {
        log.warn('tiles.fallback', {
          from: TILE_SOURCES[sourceIndex].name,
          to: TILE_SOURCES[i].name,
          errorCount,
          loadedCount,
        });
        mount(i);
        return;
      }
    }
    log.error('tiles.all.failed', { tried: [...tried], sources: TILE_SOURCES.map((item) => item.name) });
    reportState('failed');
    if (onAllFailed) {
      onAllFailed();
    }
  }

  mount(0);

  return {
    /** 获取当前源配置 */
    get current() {
      return TILE_SOURCES[sourceIndex];
    },
  };
}
