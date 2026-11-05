/**
 * project-config.mjs —— 读取项目级配置 `.electron-release.json`
 *
 * 模板见 assets/project-config.template.json。配置文件是可选的：不存在时返回 present=false，
 * 调用方继续使用探测结果。**该文件不应提交到 git**（可能含内网地址/密钥路径）。
 *
 * 只读取，不写入；JSON 解析失败时保留错误信息，由调用方决定是告警还是放行。
 */

import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_CONFIG_NAME = '.electron-release.json';

/** 读取 `key1.key2` 形式的嵌套字段，缺失返回 undefined */
export function getPath(obj, dotted) {
  let cur = obj;
  for (const seg of String(dotted).split('.')) {
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * @param {string} root 项目根目录
 * @returns {{ path: string, present: boolean, config: object|null, error?: string }}
 */
export function loadProjectConfig(root) {
  const file = path.join(root, PROJECT_CONFIG_NAME);
  if (!fs.existsSync(file)) return { path: file, present: false, config: null };
  try {
    // Windows 记事本 / PowerShell 写出的 UTF-8 常带 BOM，JSON.parse 会直接抛错
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const config = JSON.parse(text);
    return { path: file, present: true, config: config && typeof config === 'object' ? config : {} };
  } catch (e) {
    return { path: file, present: true, config: null, error: e.message };
  }
}
