import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const IS_WIN = process.platform === 'win32';

/**
 * Windows 上优先找 POSIX shell（Git Bash / MSYS2）。
 * 用 cmd.exe 解析会让模型写的 grep / find -type / 2>/dev/null 全部失败，
 * 而模型恰恰是按「用户在终端里怎么敲」来生成命令的——它的终端往往就是 Git Bash。
 */
function findPosixShell() {
  if (!IS_WIN) return null;
  const fromPath = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, 'bash.exe'));
  const fallbacks = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Windows\\System32\\bash.exe',
  ];
  for (const candidate of [...fromPath, ...fallbacks]) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 路径不可探测就跳过 */
    }
  }
  return null;
}

const POSIX_SHELL = findPosixShell();
/** 实际解析命令的 shell，决定语法；也写进 description 让模型自己适配 */
const SHELL_LABEL = !IS_WIN ? '/bin/sh' : POSIX_SHELL ? 'bash（Git Bash/MSYS 语法）' : 'cmd.exe';
/** cmd.exe 在中文 Windows 上输出 GBK；按 utf8 解会得到乱码，模型读不懂错误就会反复重试同一条命令 */
const OUTPUT_ENCODING = IS_WIN && !POSIX_SHELL ? 'gbk' : 'utf8';

function decode(chunks) {
  const buf = Buffer.concat(chunks);
  try {
    return new TextDecoder(OUTPUT_ENCODING).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** 显式指定 shell 与参数，不依赖 spawn 的 shell:true（Windows 下它固定走 cmd.exe） */
function buildSpawn(command, cwd) {
  const opts = { cwd, env: { ...process.env }, windowsHide: true };
  if (!IS_WIN) return spawn('/bin/sh', ['-c', command], opts);
  if (POSIX_SHELL) return spawn(POSIX_SHELL, ['-c', command], opts);
  const comspec = process.env.ComSpec || 'cmd.exe';
  return spawn(comspec, ['/d', '/s', '/c', command], opts);
}

const runTool = {
  name: 'shell-exec.run',
  description:
    '在用户电脑上执行一条 shell 命令并返回 stdout/stderr。适合运行构建、测试、git、目录查看等任务。' +
    `命令由 ${SHELL_LABEL} 解析，请按该 shell 的语法书写。` +
    '命令在前台执行，超时后进程会被终止。相对路径基于当前工作目录。危险命令会先请求用户批准。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令，如 "npm test" 或 "git status"' },
      cwd: { type: 'string', description: '工作目录（可选，默认为应用工作目录）' },
      timeout_ms: { type: 'number', description: '超时毫秒数（默认 30000，上限 120000）' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  permissions: ['shell:exec'],
  // 执行任意命令属于最高危操作：无论权限模式如何都先经过用户批准
  requiresApproval: true,

  execute(args, ctx) {
    const command = String(args.command ?? '').trim();
    if (!command) {
      return Promise.resolve({ ok: false, output: '', error: 'command 不能为空' });
    }
    const cwd = args.cwd ? path.resolve(ctx?.workingDir ?? process.cwd(), String(args.cwd)) : (ctx?.workingDir ?? process.cwd());
    let timeoutMs = Number(args.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
    timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);

    return new Promise((resolve) => {
      let child;
      try {
        child = buildSpawn(command, cwd);
      } catch (err) {
        resolve({ ok: false, output: '', error: `启动失败: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }

      // 攒 Buffer 再统一解码：逐块 String(d) 会把多字节字符从中间切断
      const outChunks = [];
      let outLen = 0;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
        finish({ ok: false, output: decode(outChunks).slice(0, MAX_OUTPUT), error: `命令超时（${timeoutMs}ms），进程已终止` });
      }, timeoutMs);

      const collect = (chunks) => (d) => {
        if (outLen < MAX_OUTPUT * 2) {
          chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d)));
          outLen += d.length;
        }
      };
      child.stdout?.on('data', collect(outChunks));
      child.stderr?.on('data', collect(outChunks));
      child.on('error', (err) => finish({ ok: false, output: decode(outChunks).slice(0, MAX_OUTPUT), error: `执行失败: ${err.message}` }));
      child.on('close', (code) => {
        const text = decode(outChunks).trim();
        if (code === 0) {
          finish({ ok: true, output: text.slice(0, MAX_OUTPUT) || '（命令执行成功，无输出）' });
        } else {
          finish({
            ok: false,
            output: text.slice(0, MAX_OUTPUT),
            error: `命令退出码 ${code}`,
          });
        }
      });
    });
  },
};

export const plugin = { tools: [runTool] };
export default plugin;
