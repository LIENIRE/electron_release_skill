/**
 * lib/manifest.mjs —— electron-updater 清单（latest*.yml）的唯一解析 / 序列化出口
 *
 * 为什么集中到一处：同一份 schema 原先散落在三个地方，且已经漂移：
 *   1. build.mjs 的 miniYaml / parseYaml / dumpYaml —— 不读 releaseDate，size 保持字符串
 *   2. verify-win-artifact.mjs 的 parseManifest —— 读 releaseDate，size 转数字
 *   3. verify-artifact.sh 内嵌的两段（node 依赖 js-yaml / python 依赖 pyyaml）
 * 结果是「改一个字段要改三处」，且同一份清单在不同入口下解析出的形状不同。
 *
 * 依赖策略：零强制依赖。
 *   装了 js-yaml 就优先用（保真、能保留未知字段），没装则退化到下面的最小解析器
 *   —— 它只认 electron-updater 产出的固定形态，不追求通用 YAML。
 *
 * 用法：
 *   import { createCodec, parseManifest, sha512File } from './lib/manifest.mjs';
 *   const { parse, dump } = createCodec([项目根, process.cwd()]);
 */

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** 去掉值两侧的单/双引号（YAML 里 url 常被引号包裹） */
function unquote(v) {
  const t = String(v).trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * 只解析 electron-updater 清单的固定形态，不引入 YAML 依赖。
 * 支持：
 *   version: 1.2.3
 *   files:
 *     - url: a.exe
 *       sha512: xxx
 *       size: 123
 *   path: a.exe
 *   sha512: xxx
 *   releaseDate: '...'
 *
 * 返回固定形状 { version, path, sha512, files[], releaseDate }；
 * 未知字段会被丢弃 —— 需要保真时走 createCodec().parse（装了 js-yaml 就用它）。
 */
export function parseManifest(text) {
  const out = { version: null, path: null, sha512: null, files: [], releaseDate: null };
  const lines = String(text).split(/\r?\n/);
  let inFiles = false;
  let current = null;

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }

    if (inFiles && /^-\s+/.test(line)) {
      current = {};
      out.files.push(current);
      const rest = line.replace(/^-\s+/, '');
      const m = /^(\w+):\s*(.+)$/.exec(rest);
      if (m) current[m[1]] = unquote(m[2]);
      if (m && m[1] === 'size') current.size = Number(current.size);
      continue;
    }

    if (inFiles && indent >= 2 && current) {
      const m = /^(\w+):\s*(.+)$/.exec(line);
      if (m) {
        current[m[1]] = unquote(m[2]);
        if (m[1] === 'size') current.size = Number(current.size);
      }
      continue;
    }

    if (indent === 0) {
      inFiles = false;
      const m = /^(\w+):\s*(.+)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      const value = unquote(m[2]);
      if (key === 'version') out.version = value;
      if (key === 'path') out.path = value;
      if (key === 'sha512') out.sha512 = value;
      if (key === 'releaseDate') out.releaseDate = value;
    }
  }

  return out;
}

/**
 * 在给定目录范围内尝试加载项目的 js-yaml（electron-builder 的传递依赖，通常存在）。
 * 加载不到返回 null，绝不抛错 —— 调用方一律走内置解析器兜底。
 */
export function loadYamlLib(baseDirs = []) {
  for (const base of baseDirs) {
    if (!base) continue;
    try {
      return createRequire(path.join(path.resolve(base), 'noop.js'))('js-yaml');
    } catch {
      /* 换下一个 base 继续找 */
    }
  }
  return null;
}

/**
 * 内置序列化：files 展开为多行，保证 url / sha512 / size 各自独立成行。
 * 这不是「优雅」的 YAML，但是 electron-updater 与 signtool 侧都能稳定读取的形态；
 * 三者被并成一行会导致客户端解析失败，属于硬要求。
 */
export function dumpManifest(obj) {
  const L = [`version: ${obj.version}`];
  L.push('files:');
  for (const f of obj.files || []) {
    L.push(`  - url: ${f.url}`);
    L.push(`    sha512: ${f.sha512}`);
    L.push(`    size: ${f.size}`);
  }
  if (obj.path) L.push(`path: ${obj.path}`);
  if (obj.sha512) L.push(`sha512: ${obj.sha512}`);
  if (obj.releaseDate) L.push(`releaseDate: '${obj.releaseDate}'`);
  return L.join('\n') + '\n';
}

/**
 * 生成一对 parse / dump。
 * parse 优先用 js-yaml（保留未知字段），失败或未安装时退到 parseManifest；
 * dump 同理优先 js-yaml，失败退到 dumpManifest。
 *
 * @param {string[]} baseDirs 在这些目录里找 js-yaml，通常是 [项目根, process.cwd()]
 */
export function createCodec(baseDirs = []) {
  const yaml = loadYamlLib(baseDirs);
  return {
    /** 命中的 js-yaml 实例；null 表示走内置解析器 */
    lib: yaml,
    usingLibrary: Boolean(yaml),
    parse(text) {
      if (yaml) {
        try {
          return yaml.load(text);
        } catch {
          /* 落到内置解析器 */
        }
      }
      return parseManifest(text);
    },
    dump(obj) {
      if (yaml) {
        try {
          return yaml.dump(obj, { lineWidth: -1, noRefs: true });
        } catch {
          /* 落到内置序列化 */
        }
      }
      return dumpManifest(obj);
    },
  };
}

/** buffer → base64 摘要（electron-updater 清单里 sha512 为 base64，不是 hex） */
export function sha512Buffer(buf) {
  return createHash('sha512').update(buf).digest('base64');
}

/** 文件路径 → base64 摘要 */
export function sha512File(filePath) {
  return readFile(filePath).then(sha512Buffer);
}
