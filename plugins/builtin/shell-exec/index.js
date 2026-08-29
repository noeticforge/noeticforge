import { spawn } from 'node:child_process';
import path from 'node:path';

const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

const runTool = {
  name: 'shell-exec.run',
  description:
    '在用户电脑上执行一条 shell 命令并返回 stdout/stderr。适合运行构建、测试、git、目录查看等任务。' +
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
        // shell:true 交给系统 shell 解析（Windows → cmd / POSIX → sh），与用户在终端里执行语义一致
        child = spawn(command, {
          shell: true,
          cwd,
          env: { ...process.env },
          windowsHide: true,
        });
      } catch (err) {
        resolve({ ok: false, output: '', error: `启动失败: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }

      let out = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
        finish({ ok: false, output: out.slice(0, MAX_OUTPUT), error: `命令超时（${timeoutMs}ms），进程已终止` });
      }, timeoutMs);

      child.stdout?.on('data', (d) => { if (out.length < MAX_OUTPUT * 2) out += String(d); });
      child.stderr?.on('data', (d) => { if (out.length < MAX_OUTPUT * 2) out += String(d); });
      child.on('error', (err) => finish({ ok: false, output: out.slice(0, MAX_OUTPUT), error: `执行失败: ${err.message}` }));
      child.on('close', (code) => {
        const text = out.trim();
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
