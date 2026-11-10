/**
 * 路网数据加载：带缓存，避免页面各模块重复请求同一份大 JSON。
 *
 * 数据地址不在代码里写死：由地点配置的 `cities[].roads.dataUrl` 提供，
 * 页面启动时调用 `configureRoadData()` 设置默认地址；也可调用 `loadRoadData(url)` 直接指定。
 */

/** 默认路网数据地址（由 configureRoadData 设置；未配置时请求直接报错） */
let defaultUrl = null;

/** 按 URL 缓存加载 Promise（不同城市/不同数据文件互不干扰） */
const cache = new Map();

/**
 * 配置默认路网数据地址。
 *
 * @param {{url: string}} options
 * @param {string} options.url 路网 JSON 的 URL
 */
export function configureRoadData({ url } = {}) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('configureRoadData 需要非空的 url');
  }
  defaultUrl = url.trim();
}

/**
 * 加载本地路网数据（`/data/...`）。
 *
 * @param {string} [url] 数据地址；缺省用 configureRoadData 设置的值
 * @returns {Promise<Array<{id:number, h:string, n:string, c:number[][], r:number[]}>>} 道路数组
 */
export function loadRoadData(url = defaultUrl) {
  if (!url) {
    return Promise.reject(new Error('路网数据地址未配置（请从地点配置 roads.dataUrl 传入）'));
  }
  if (!cache.has(url)) {
    const promise = fetch(url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`路网数据加载失败：HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((payload) => payload.roads || [])
      .catch((error) => {
        // 失败不缓存：下一轮可重试
        cache.delete(url);
        throw error;
      });
    cache.set(url, promise);
  }
  return cache.get(url);
}
