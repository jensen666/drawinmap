/**
 * 前置数据缺失时必须打印生成说明并走退出码 2，不能抛 ENOENT。
 *
 * 运行：node test/require-data.mjs
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GUANGZHOU_ROADS_HINT,
  GUANGZHOU_ROADS_WEB_HINT,
  formatMissingData,
  readRequiredText,
} from './lib/require-data.mjs';

let failures = 0;

/**
 * 打印一条断言。
 *
 * @param {string} label 描述
 * @param {boolean} condition 是否通过
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`[check] ${label} -> ${condition ? 'PASS' : `FAIL ${detail}`}`);
}

const message = formatMissingData('D:/missing/guangzhou-roads.json', GUANGZHOU_ROADS_HINT);
check('说明包含文件路径', message.includes('D:/missing/guangzhou-roads.json'));
check('说明包含生成命令', message.includes('parse_pbf.py') && message.includes('mapdata/README.md'));
check('说明包含 ODbL', message.includes('ODbL'));
check('页面副本说明要求复制', GUANGZHOU_ROADS_WEB_HINT.includes('web/data/guangzhou-roads.json'));

let exitCode = null;
let threw = false;
let missingResult = 'unset';
try {
  missingResult = readRequiredText(new URL('./fixtures/missing-roads-for-require-data.json', import.meta.url), GUANGZHOU_ROADS_HINT, (code) => {
    exitCode = code;
  });
} catch (error) {
  threw = true;
  console.log(`[check] 缺失时异常 -> FAIL ${error.message}`);
}
check('缺失时不抛异常', !threw);
check('缺失时退出码 2', exitCode === 2, `实际 ${exitCode}`);
check('注入的 exit 未终止进程时返回空串', missingResult === '');

const packageJsonUrl = new URL('../package.json', import.meta.url);
const packageText = readRequiredText(packageJsonUrl, '不应触发');
check('已存在文件返回原文', packageText.includes('"drawinmap"') && !packageText.startsWith('[require-data]'));

const roadsUrl = new URL('../mapdata/guangzhou-roads.json', import.meta.url);
if (existsSync(fileURLToPath(roadsUrl))) {
  const roadsText = readRequiredText(roadsUrl, GUANGZHOU_ROADS_HINT);
  check('本机路网文件可解析出 roads', roadsText.includes('"roads"'));
} else {
  console.log('[check] 本机没有路网文件，跳过读取成功断言');
}

if (failures > 0) {
  console.log(`[require-data] FAIL ${failures}`);
  process.exit(1);
}
console.log('[require-data] PASS');
