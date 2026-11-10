/**
 * 测试前置数据：文件缺失时说明怎么生成，并以退出码 2 结束。
 *
 * 广州路网 JSON 被 .gitignore 排除，干净克隆里没有这份文件。
 * 测试运行器（tools/run-tests.mjs）会跳过依赖它的用例；
 * 直接 `node test/xxx.mjs` 时如果仍用 readFileSync，只会抛 ENOENT 堆栈。
 * 这里把缺文件变成一条可执行的生成说明。
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** mapdata/guangzhou-roads.json 缺失时的修复说明 */
export const GUANGZHOU_ROADS_HINT = [
  '该文件被 .gitignore 忽略（约 6.7MB，OpenStreetMap 派生数据，ODbL 1.0）。',
  '生成：python mapdata/tools/download_pbf.py',
  '然后：python mapdata/tools/parse_pbf.py mapdata/guangdong-latest.osm.pbf mapdata/guangzhou-roads.json',
  '步骤说明见 mapdata/README.md。',
].join(' ');

/** web/data/guangzhou-roads.json 缺失时的修复说明 */
export const GUANGZHOU_ROADS_WEB_HINT = [
  '页面路网副本被 .gitignore 忽略。',
  '先按 mapdata/README.md 生成 mapdata/guangzhou-roads.json，',
  '再复制为 web/data/guangzhou-roads.json。',
].join('');

/**
 * 拼出缺文件时打印的整段说明。
 *
 * @param {string} filePath 本机路径
 * @param {string} hint 修复说明
 * @returns {string} 多行文本
 */
export function formatMissingData(filePath, hint) {
  return [
    `[require-data] 缺少数据文件：${filePath}`,
    `[require-data] ${hint}`,
    '[require-data] 退出码 2。npm test 会跳过依赖该文件的用例；单独运行此测试需要先准备数据。',
  ].join('\n');
}

/**
 * 读取必须存在的文本文件。
 *
 * @param {URL|string} file 文件 URL 或路径（相对路径按当前工作目录解析，与 readFileSync 相同）
 * @param {string} hint 缺失时的修复说明
 * @param {(code: number) => void} [exit] 退出函数，默认 process.exit；测试可注入，注入后函数返回空串
 * @returns {string} 文件文本；缺失且 exit 未真正退出时返回空串
 */
export function readRequiredText(file, hint, exit = process.exit) {
  const filePath = file instanceof URL ? fileURLToPath(file) : String(file);
  if (!existsSync(filePath)) {
    console.error(formatMissingData(filePath, hint));
    exit(2);
    return '';
  }
  return readFileSync(filePath, 'utf8');
}
