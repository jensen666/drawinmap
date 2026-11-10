/**
 * 多比例尺卡片点选轻提示文案测试（Node 直接运行，无 DOM、无网络）。
 *
 * 背景（交互修正 2026-11-09）：点选卡片不再往对话流追加"点选 X km 卡片"用户消息
 * 与切换回复，改为就地切换 + 面板轻提示。提示文案由纯函数拼装，本文件验证：
 * - 数字与卡片同源（尺寸一位小数 km、里程两位小数 km、用时走引擎格式化、贴合分原样）；
 * - 缺失项不编造（缺里程/用时/贴合时对应片段直接省略，不留空占位）；
 * - 非法尺寸不硬凑数字（"已切换到该版"）；
 * - 点当前版/失效/复核拒绝的固定提示文案明确、非空。
 *
 * 运行：node test/scale-notice.mjs
 */

import {
  formatScaleSwitchNotice,
  formatScaleCurrentNotice,
  SCALE_POOL_STALE_NOTICE,
  SCALE_SWITCH_REFUSED_NOTICE,
} from '../web/src/agent/scale-notice.js';

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/** 与形状引擎同口径的时长格式化（生产实现见 shape-engine.js formatMinutes） */
function formatMinutes(minutes) {
  const total = Math.round(minutes);
  if (total < 60) {
    return `${total} 分钟`;
  }
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

// ---------- 场景 1：字段齐全 ----------
{
  const card = { sizeMeters: 1500, routeMeters: 6450, walkMinutes: 86, score: 65 };
  const text = formatScaleSwitchNotice(card, formatMinutes);
  check(
    '齐全：提示含"已切换到 1.5 km 版"',
    text.includes('已切换到 1.5 km 版'),
    text,
  );
  check('齐全：里程两位小数 km', text.includes('里程 6.45 km'), text);
  check('齐全：用时走引擎格式化', text.includes('约 1 小时 26 分'), text);
  check('齐全：贴合分原样', text.includes('路线贴合 65'), text);
  check(
    '齐全：字段顺序固定（尺寸 → 里程 → 用时 → 贴合）',
    text === '已切换到 1.5 km 版 · 里程 6.45 km · 约 1 小时 26 分 · 路线贴合 65',
    text,
  );
}

// ---------- 场景 2：缺项不编造 ----------
{
  const onlySize = formatScaleSwitchNotice({ sizeMeters: 2400 }, formatMinutes);
  check('缺项：只有尺寸时不留空片段', onlySize === '已切换到 2.4 km 版', onlySize);
  check('缺项：不出现"里程"', !onlySize.includes('里程'), onlySize);
  check('缺项：不出现"约"', !onlySize.includes('约'), onlySize);
  check('缺项：不出现"路线贴合"', !onlySize.includes('路线贴合'), onlySize);

  const noDuration = formatScaleSwitchNotice({ sizeMeters: 900, routeMeters: 3120, score: 71 }, formatMinutes);
  check('缺项：没有用时也完整', noDuration === '已切换到 0.9 km 版 · 里程 3.12 km · 路线贴合 71', noDuration);

  const noScore = formatScaleSwitchNotice({ sizeMeters: 600, walkMinutes: 12 }, formatMinutes);
  check('缺项：没有贴合分也完整', noScore === '已切换到 0.6 km 版 · 约 12 分钟', noScore);
}

// ---------- 场景 3：非法输入不硬凑数字 ----------
{
  check(
    '非法尺寸：退化为"已切换到该版"',
    formatScaleSwitchNotice({}, formatMinutes) === '已切换到该版',
    formatScaleSwitchNotice({}, formatMinutes),
  );
  check(
    '非法尺寸 NaN：同样退化',
    formatScaleSwitchNotice({ sizeMeters: Number.NaN }, formatMinutes) === '已切换到该版',
    formatScaleSwitchNotice({ sizeMeters: Number.NaN }, formatMinutes),
  );
  check(
    '非法卡片 null：不抛错',
    formatScaleSwitchNotice(null, formatMinutes) === '已切换到该版',
    formatScaleSwitchNotice(null, formatMinutes),
  );
  const noFormatter = formatScaleSwitchNotice({ sizeMeters: 1000, walkMinutes: 25 });
  check('未传格式化函数：缺省按分钟', noFormatter.includes('约 25 分钟'), noFormatter);
  const zero = formatScaleSwitchNotice({ sizeMeters: 0, routeMeters: 0, walkMinutes: 0, score: 60 }, formatMinutes);
  check('零值：不当作缺失（0.0 km / 0.00 km / 0 分钟）', zero === '已切换到 0.0 km 版 · 里程 0.00 km · 约 0 分钟 · 路线贴合 60', zero);
}

// ---------- 场景 4：点当前版提示 ----------
{
  const current = formatScaleCurrentNotice({ sizeMeters: 1500, score: 65 });
  check(
    '点当前版：含尺寸与贴合',
    current === '当前就是这一版（1.5 km · 路线贴合 65），地图没有重画',
    current,
  );
  const noScore = formatScaleCurrentNotice({ sizeMeters: 1800 });
  check('点当前版：缺贴合分时仍明确', noScore === '当前就是这一版（1.8 km），地图没有重画', noScore);
  const bare = formatScaleCurrentNotice(null);
  check('点当前版：无卡片信息时仍明确', bare === '当前就是这一版，地图没有重画', bare);
}

// ---------- 场景 5：失效/复核拒绝提示 ----------
{
  check('失效提示非空且说明不可恢复', SCALE_POOL_STALE_NOTICE.includes('已失效') && SCALE_POOL_STALE_NOTICE.length > 10, SCALE_POOL_STALE_NOTICE);
  check('失效提示：重新发一次规划请求即可', SCALE_POOL_STALE_NOTICE.includes('重新发一次规划请求即可'), SCALE_POOL_STALE_NOTICE);
  check('拒绝提示：说明保持当前版不变', SCALE_SWITCH_REFUSED_NOTICE.includes('保持当前版不变'), SCALE_SWITCH_REFUSED_NOTICE);
}

// ---------- 场景 6：纯函数（重复调用结果一致、不改入参） ----------
{
  const card = { sizeMeters: 1500, routeMeters: 6450, walkMinutes: 86, score: 65 };
  const snapshot = JSON.stringify(card);
  const first = formatScaleSwitchNotice(card, formatMinutes);
  const second = formatScaleSwitchNotice(card, formatMinutes);
  check('纯函数：重复调用结果一致', first === second, `${first} / ${second}`);
  check('纯函数：不修改入参', JSON.stringify(card) === snapshot, JSON.stringify(card));
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
