/**
 * powershell.mjs —— 在 Windows 上执行 PowerShell 并取回 JSON/文本结果
 *
 * 为什么不用 stdout 管道：
 *   agent 沙箱（DSH / AppContainer / 作业对象限制等）会禁止子进程打开命名管道，
 *   `child_process` 的管道捕获直接报 `spawnSync powershell.exe EPERM`。
 *   把结果写进临时文件再读回来，不创建管道，因此在受限环境里仍可用；
 *   同时显式以 UTF-8 落盘，避免中文 Subject 被按 ANSI 码页输出成乱码。
 *
 * 用法：body 会被放进 try 块，**必须把结果赋给 $result**（字符串）。
 * 抛出的异常会被自动转成 {"error":"..."}，调用方按 JSON 解析。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let counter = 0;

/**
 * @param {string} body PowerShell 语句（赋值给 $result）
 * @param {{ timeout?: number }} [opts]
 * @returns {{ ok: boolean, unsupported?: boolean, stdout: string, status: number|null, error: string|null }}
 */
export function runPowerShell(body, { timeout = 60000 } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, unsupported: true, stdout: '', status: null, error: '非 Windows 平台，无法执行 PowerShell' };
  }

  const tmp = path.join(os.tmpdir(), `electron-release-ps-${process.pid}-${Date.now()}-${counter++}.json`);
  const tmpLiteral = tmp.replace(/'/g, "''");
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `try {`,
    body,
    `} catch {`,
    `  $result = [ordered]@{ error = [string]$_.Exception.Message } | ConvertTo-Json -Compress`,
    `}`,
    `try { [IO.File]::WriteAllText('${tmpLiteral}', [string]$result) } catch { exit 9 }`,
  ].join('\n');

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { stdio: 'ignore', timeout, windowsHide: true }
  );

  const base = { stdout: '', status: r.status, error: null };
  if (r.error) {
    return { ...base, ok: false, error: `PowerShell 启动失败：${r.error.code || r.error.message}` };
  }
  if (!fs.existsSync(tmp)) {
    return { ...base, ok: false, error: `PowerShell 未产出结果（退出码 ${r.status}）` };
  }

  let text = '';
  try {
    text = fs.readFileSync(tmp, 'utf8').replace(/^\uFEFF/, '').trim();
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件清理失败不影响结果 */
    }
  }
  if (!text) return { ...base, ok: false, error: `PowerShell 输出为空（退出码 ${r.status}）` };
  return { ...base, ok: r.status === 0, stdout: text };
}
