/**
 * 地理描述小工具：两点间偏移的方向与距离的中文表述。
 */

/** 每纬度约对应的米数 */
import { METERS_PER_DEG_LAT } from './engine/geo.js';

/** 八方位中文名称（按方位角，0°=北，顺时针） */
const DIRECTIONS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

/**
 * 描述两点间的偏移（方向 + 距离）。
 *
 * @param {{lat: number, lng: number}} from 起点（如用户指定地点）
 * @param {{lat: number, lng: number}} to 终点（如实际选中的图形中心）
 * @returns {{meters: number, direction: string, text: string}} 偏移描述（text 如"北偏东约 1.2 km"）
 */
export function offsetDescription(from, to) {
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((from.lat * Math.PI) / 180);
  const dEast = (to.lng - from.lng) * metersPerDegLng;
  const dNorth = (to.lat - from.lat) * METERS_PER_DEG_LAT;
  const meters = Math.hypot(dEast, dNorth);
  // 方位角：0°=北，顺时针
  const bearing = ((Math.atan2(dEast, dNorth) * 180) / Math.PI + 360) % 360;
  const direction = DIRECTIONS[Math.round(bearing / 45) % 8];
  const distanceText = meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
  return { meters, direction, text: `${direction}约 ${distanceText}` };
}
