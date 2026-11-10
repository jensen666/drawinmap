import { createMap, flyToView } from './map.js';
import { createTileController } from './tiles.js';
import { addPois } from './pois.js';
import { createRoadLayer } from './roads.js';
import { createShapeEngine } from './shape-engine.js';
import { initAgent } from './agent/ui.js';
import { initUi } from './ui.js';
import { beginTrace, createLogger, initLogging } from './log/index.js';
import { initLogViewer } from './log/ui.js';
import { loadPlaceConfig } from './place-config.js';
import { configureRoadData } from './road-data.js';
import { createSessionStore } from './session/store.js';
import { initSessionUI } from './session/ui.js';
import { loadCityCatalog } from './city/catalog.js';
import { createCityStore } from './city/store.js';
import { initCityUi } from './city/ui.js';

/**
 * 版本标记：用于核对标签页是否跑的当前代码
 * （陈旧标签页是历史故障源，见 web/server.mjs 说明；日志面板状态栏也会显示）。
 */
const APP_REV = 'engine rev 2026-11-09.01（多比例尺候选展示 + 清理基线）';

/**
 * 把地点配置里的城市信息写进页面静态文案（标题/副标题/无障碍标签/按钮）。
 *
 * @param {object} city 当前城市配置
 * @param {HTMLButtonElement|null} locateButton "回到默认视野"按钮
 */
function applyCityCopy(city, locateButton) {
  document.title = `DrawInMap · ${city.title}`;
  const subtitle = document.getElementById('brand-subtitle');
  if (subtitle) {
    subtitle.textContent = city.subtitle;
  }
  const mapEl = document.getElementById('map');
  if (mapEl) {
    mapEl.setAttribute('aria-label', city.mapAriaLabel);
  }
  if (locateButton) {
    locateButton.textContent = `回到${city.label}`;
    locateButton.title = `回到${city.label}默认视野`;
  }
  const placeholder = document.getElementById('agent-input');
  if (placeholder && city.examples?.[0]) {
    placeholder.placeholder = `想画什么？如：${city.examples[0]}`;
  }
  const cityBtnLabel = document.getElementById('city-btn-label');
  if (cityBtnLabel) {
    cityBtnLabel.textContent = city.label;
  }
}

/**
 * 应用入口：加载地点配置 → 创建地图、挂载底图、添加地标、绘制连续路线并初始化界面。
 *
 * 启动过程本身也纳入链路追踪（startup trace）：配置/地图/底图/地标/引擎/智能体
 * 的初始化顺序与耗时可在日志面板按 trace 查看。
 *
 * 城市按需获取（方案 2026-11-08）：默认城市直接用已有路网（R1，不下载任何其他城市）；
 * 其他城市经城市面板选择后向服务器发起获取，完成前当前城市不变（R2）。
 */
async function bootstrap() {
  // 0. 日志系统：最先初始化，保证启动过程与未捕获异常都可追溯（服务端落盘异步探测）
  initLogging({ server: true, version: APP_REV });
  initLogViewer();
  const log = createLogger('app');
  const startup = beginTrace('startup', { rev: APP_REV });

  try {
    const mapEl = document.getElementById('map');
    if (!mapEl) {
      const error = new Error('未找到地图容器 #map');
      log.error('app.map.container.missing', {}, error);
      startup.fail(error);
      return;
    }
    log.info('app.start', { rev: APP_REV });

    // 0.5 地点配置：城市名/地标/别名/匹配策略/视野全部来自配置文件（不写死在代码里）
    const placeConfig = await loadPlaceConfig();
    const city = placeConfig.activeCity;
    configureRoadData({ url: city.roads.dataUrl });
    const locateButton = document.getElementById('locate-btn');
    applyCityCopy(city, locateButton);
    log.info('app.place.config.ready', {
      cityId: city.id,
      pois: city.pois.length,
      districts: city.districts.length,
      aliases: city.aliases.length,
      roadDataUrl: city.roads.dataUrl,
    });

    // 1. 创建地图（默认视野来自城市配置）
    const map = createMap(mapEl, city.view);

    // 2. 初始化界面与状态栏
    const ui = initUi({
      map,
      locateButton,
      statusEls: {
        center: document.getElementById('status-center'),
        zoom: document.getElementById('status-zoom'),
        tiles: document.getElementById('status-tiles'),
      },
      view: city.view,
      locateLabel: `回到${city.label}`,
      cityLabel: city.label,
    });

    // 3. 本地路网数据：点击按钮按需加载并叠加显示（地址来自当前城市配置 roads.dataUrl）
    //    监听器尽早注册，避免路线请求尚未完成时按钮无效。
    //    城市切换时参考层复位（resetRoadLayerUi），下一城市首次打开时按新城数据重建。
    const roadsBtn = document.getElementById('roads-btn');
    let roadLayer = null;
    let roadCount = 0;
    /** 切换城市后复位路网参考层（隐藏并重置按钮文案，等用户按需重新打开） */
    function resetRoadLayerUi() {
      if (roadLayer && map.hasLayer(roadLayer)) {
        map.removeLayer(roadLayer);
      }
      roadLayer = null;
      roadCount = 0;
      roadsBtn.textContent = '路网数据';
      roadsBtn.classList.remove('is-active');
    }
    roadsBtn.addEventListener('click', async () => {
      if (!roadLayer) {
        roadsBtn.disabled = true;
        roadsBtn.textContent = '路网加载中…';
        try {
          const roads = await createRoadLayer(map);
          roadLayer = roads.layer;
          roadCount = roads.roadCount;
          roadLayer.addTo(map);
          roadsBtn.textContent = `路网已开 · ${roadCount} 条`;
          roadsBtn.classList.add('is-active');
          log.info('app.roads.layer.ready', { roadCount });
        } catch (error) {
          roadsBtn.textContent = '路网加载失败';
          log.error('app.roads.layer.failed', {}, error);
        } finally {
          roadsBtn.disabled = false;
        }
        return;
      }

      // 已加载：开/关切换
      if (map.hasLayer(roadLayer)) {
        map.removeLayer(roadLayer);
        roadsBtn.textContent = '路网数据';
        roadsBtn.classList.remove('is-active');
        log.info('app.roads.layer.hidden', { roadCount });
      } else {
        roadLayer.addTo(map);
        roadsBtn.textContent = `路网已开 · ${roadCount} 条`;
        roadsBtn.classList.add('is-active');
        log.info('app.roads.layer.shown', { roadCount });
      }
    });

    // 4. 图形路线引擎（首次规划时加载路网并建图，无自有界面，由智能体调用）
    const engine = createShapeEngine({ map });

    // 4.2 城市按需获取（方案 2026-11-08 §5）：目录 + 状态机 + 面板。
    //     目录加载失败不致命：当前城市照常可用，城市面板与点名路由降级关闭。
    let catalog = null;
    try {
      catalog = await loadCityCatalog();
    } catch (error) {
      log.error('app.city.catalog.failed', {}, error);
      const cityBtn = document.getElementById('city-btn');
      if (cityBtn) {
        cityBtn.title = '城市目录加载失败（见日志）';
      }
    }
    /** 智能体轮次是否进行中（选择器禁用与空闲自动切换共用） */
    let agentBusy = false;
    /** 城市地标标注图层（切换城市时清空重挂） */
    let poiLayer = null;
    /** 重新挂载当前城市地标（pois=[] 的按需城市自然为空层） */
    function reAddPois(cityConfig) {
      if (poiLayer) {
        map.removeLayer(poiLayer);
      }
      poiLayer = addPois(map, cityConfig.pois);
    }
    reAddPois(city);
    const cityStore = catalog
      ? createCityStore({
          catalog,
          placeConfig,
          engine,
          isBusy: () => agentBusy,
          onEvent: (event) => log.info(event.type, event),
          afterSwitch: (cityConfig) => {
            // 控制器失效按城市缓存（道路索引/地点上下文/引导状态）
            agent?.onCitySwitched?.();
            // 路网数据默认地址与文案/视野/地标/参考层全部跟随新城
            configureRoadData({ url: cityConfig.roads.dataUrl });
            applyCityCopy(cityConfig, locateButton);
            reAddPois(cityConfig);
            resetRoadLayerUi();
            flyToView(map, cityConfig.view, cityConfig.label);
            log.info('app.city.switched.ui', { cityId: cityConfig.id, label: cityConfig.label });
          },
        })
      : null;

    // 4.5 会话存储：历史对话、消息与图形快照（本机持久化，刷新不丢）
    const store = createSessionStore();
    // 页面关闭/切后台时立刻落盘（照搬日志层的做法）：写入有 300ms 去抖，
    // 不兜底的话"发送后立刻刷新/关标签页"会丢用户刚发的消息（需求 R4）。
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => store.flush());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          store.flush();
        }
      });
    }

    // 4.6 智能体对话面板（自然语言/图片 → 引擎规划）
    let sessionUI = null;
    const agent = initAgent({
      map,
      engine,
      placeConfig,
      store,
      // 轮次进行中：禁用会话切换/图形切换/新建/删除/城市选择（R6 状态一致）；
      // 轮次结束：落地"获取完成后自动进入新城"的挂起切换（方案 §5.3）
      onBusyChange: (busy) => {
        agentBusy = busy;
        sessionUI?.setBusy(busy);
        cityUi?.setBusy(busy);
        if (!busy) {
          cityStore?.notifyIdle();
        }
      },
      cityStore,
    });

    // 4.7 历史对话列表 + 地图侧图形切换控件
    sessionUI = initSessionUI({
      store,
      engine,
      agent: {
        // 切换对话前：把当前会话的上下文（对话历史 + 引导状态）存回存储
        beforeSwitch: () => {
          const sessionId = store.getActiveId();
          if (sessionId) {
            store.setContext(sessionId, agent.exportContext());
          }
        },
        // 切换对话后：消息与上下文由智能体面板恢复；这里负责地图
        // （R2：进入对话展示该对话"最近一次实际生成的图形"并聚焦——
        //  注意是"最近一次画出来的"，不是"用户上次查看的那一个"）
        afterSwitch: (sessionId) => {
          if (!sessionId) {
            engine.clearDraw();
            return;
          }
          const latest = store.getLatestShape(sessionId);
          // 复位"当前查看"为最新，切换控件的序号指示与地图保持一致
          store.setActiveShape(sessionId, latest ? latest.id : null);
          // drawSnapshot 内有城市归属守卫：别的城市的图形在当前城市视图不绘制
          const drawn = latest ? engine.drawSnapshot(latest) : false;
          // 快照损坏/几何为空时 drawSnapshot 返回 false：清掉旧图，不能让上一对话的图形留着
          if (!drawn) {
            engine.clearDraw();
          }
        },
      },
    });

    // 轮次状态变化时刷新会话控件的可用性（由 onBusyChange 统一驱动）

    // 4.8 启动即展示当前对话的最新图形（需求 R2/R4：刷新后回到最后所在的对话，
    //     地图展示该对话**最近一次实际生成**的图形并聚焦到图形范围）
    const activeSessionId = store.getActiveId();
    const activeShape = activeSessionId ? store.getLatestShape(activeSessionId) : null;
    if (activeShape) {
      store.setActiveShape(activeSessionId, activeShape.id);
      const drawn = engine.drawSnapshot(activeShape);
      if (drawn) {
        log.info('app.session.shape.restored', {
          sessionId: activeSessionId,
          shapeName: activeShape.shapeName,
          reference: activeShape.reference,
        });
      } else {
        // 快照几何损坏/属于其他城市：宁可白图也不留残留
        engine.clearDraw();
        log.warn('app.session.shape.restore.skipped', {
          sessionId: activeSessionId,
          shapeName: activeShape.shapeName,
          shapeCityId: activeShape.cityId ?? null,
        });
      }
    }

    // 5. 挂载 OSM 底图（失败自动切换备用源）
    createTileController(map, {
      onSourceChange: (source) => {
        ui.setTileStatus({ state: 'loading', source });
      },
      onStateChange: (status) => {
        ui.setTileStatus(status);
      },
      onAllFailed: () => {
        ui.setTileStatus({ state: 'failed' });
      },
    });

    // 4.2（续）城市面板：store 建好、agent 就绪后初始化 UI，并与服务器缓存清单重同步
    let cityUi = null;
    if (cityStore) {
      cityUi = initCityUi({ store: cityStore, isBusy: () => agentBusy });
      cityStore
        .refreshCacheStates()
        .then((cacheList) => {
          log.info('app.city.cache.synced', {
            cachedCities: cacheList.length,
            catalogCities: catalog.cities.length,
            activeCityId: placeConfig.activeCityId,
          });
        })
        .catch(() => {});
    }

    log.info('app.ready', { rev: APP_REV });
    startup.end({ rev: APP_REV });
  } catch (error) {
    startup.fail(error);
    const subtitle = document.getElementById('brand-subtitle');
    if (subtitle) {
      subtitle.textContent = '地点配置加载失败，请检查 web/config/place-gazetteer.json';
    }
    throw error;
  }
}

bootstrap().catch((error) => {
  // 启动失败：日志已在 initLogging 安装的全局错误捕获之外，这里再兜底记一次
  createLogger('app').error('app.bootstrap.failed', {}, error);
});
