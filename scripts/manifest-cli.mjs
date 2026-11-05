#!/usr/bin/env node
/**
 * manifest-cli.mjs —— 用统一解析器做「清单 ↔ 产物」配对校验（给 shell 层调用）
 *
 * 存在的理由：verify-artifact.sh 原先内嵌一段 node（要求项目装了 js-yaml）+ 一段 python
 * （要求 pyyaml），两者都没有时直接判定「无 YAML 解析能力」并失败。现在统一交给本脚本，
 * 它用 lib/manifest.mjs 的内置解析器，**零第三方依赖**，只要有 node 就能跑。
 *
 * 用法：
 *   node manifest-cli.mjs verify --manifest latest.yml --dir dist/package
 *   node manifest-cli.mjs verify --manifest latest.yml --dir dist/package --json
 *
 * 输出：逐条 ✓ / ✗ / ! 行（与旧内嵌实现同格式，shell 侧可直接透传）
 *
 * 退出码：0 全部通过；1 存在失败项；2 参数或环境错误。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { parseManifest, sha512Buffer } from './lib/manifest.mjs';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const has = (name) => argv.includes(name);

function usage() {
  console.log(`manifest-cli.mjs —— 清单与产物配对校验

用法：
  node manifest-cli.mjs verify --manifest <latest*.yml> --dir <产物目录> [--json]

退出码：0 通过；1 校验失败；2 参数或环境错误`);
}

// 子命令只能出现在首位：否则 `--manifest <值>` 的取值会被误当成子命令
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
if (!cmd || has('--help') || has('-h')) {
  usage();
  process.exit(cmd ? 0 : 2);
}
if (cmd !== 'verify') {
  console.error(`✗ 未知子命令：${cmd}（只支持 verify）`);
  usage();
  process.exit(2);
}

const manifestPath = opt('--manifest');
const dir = opt('--dir');
if (!manifestPath) {
  console.error('✗ 缺少 --manifest <latest*.yml>');
  process.exit(2);
}
if (!dir) {
  console.error('✗ 缺少 --dir <产物目录>');
  process.exit(2);
}
if (!existsSync(manifestPath)) {
  console.error(`✗ 清单不存在：${manifestPath}`);
  process.exit(2);
}
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`✗ 产物目录不存在：${dir}`);
  process.exit(2);
}

let manifest;
try {
  manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
} catch (e) {
  console.error(`✗ 清单读取失败：${e.message}`);
  process.exit(2);
}

const lines = [];
const emit = (s) => lines.push(s);

if (!manifest.files || !manifest.files.length) {
  emit('✗ 清单缺少 files 数组');
  finish(1);
}

let failed = 0;
for (const [i, f] of manifest.files.entries()) {
  let missingKey = false;
  for (const k of ['url', 'sha512', 'size']) {
    if (!f[k]) {
      emit(`✗ files[${i}] 缺少 ${k}`);
      missingKey = true;
    }
  }
  if (missingKey || !f.url) {
    failed = 1;
    continue;
  }

  const name = path.basename(f.url);
  const p = path.join(dir, name);
  if (!existsSync(p)) {
    emit(`✗ ${name} 产物缺失`);
    failed = 1;
    continue;
  }

  const buf = readFileSync(p);
  if (Number(f.size) !== buf.length) {
    emit(`✗ ${name} 实际 ${buf.length} 字节 ≠ 清单 ${f.size}`);
    failed = 1;
    continue;
  }

  const actual = sha512Buffer(buf);
  if (actual !== f.sha512) {
    emit(`✗ ${name} sha512 与清单不一致`);
    failed = 1;
    continue;
  }

  emit(`✓ ${name}  ${Math.round(buf.length / 1048576)}MB  sha512 匹配`);
}

if (manifest.path) {
  const pn = path.basename(manifest.path);
  if (!existsSync(path.join(dir, pn))) {
    emit(`! path 字段指向的主产物不在目录: ${pn}`);
  }
}

finish(failed);

function finish(code) {
  if (has('--json')) {
    console.log(
      JSON.stringify(
        {
          ok: code === 0,
          manifest: manifestPath,
          dir,
          version: manifest ? manifest.version : null,
          fileCount: manifest && manifest.files ? manifest.files.length : 0,
          lines,
        },
        null,
        2,
      ),
    );
  } else {
    for (const l of lines) console.log(l);
  }
  process.exit(code);
}
