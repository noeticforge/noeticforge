import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 内置终端（v0.4）：右侧面板「终端」标签页的后端。
 * 持久 shell 会话（Windows → cmd，POSIX → $SHELL/bash），stdin 写命令、stdout/stderr 推流。
 * 说明：非 PTY 实现——没有真正的交互式程序支持（vim/top 等），面向命令执行场景；
 * 用户手敲命令本身就是授权，不再叠加审批。
 */
export class TerminalManager {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private readonly maxBuffer = 200_000;

  constructor(
    private readonly onData: (text: string) => void,
    private readonly cwd: string,
  ) {}

  start(): void {
    if (this.proc) return;
    const command = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || 'bash');
    try {
      this.proc = spawn(command, {
        cwd: this.cwd,
        env: { ...process.env },
        windowsHide: true,
      });
    } catch (e) {
      this.onData(`(终端启动失败: ${e instanceof Error ? e.message : String(e)})\n`);
      return;
    }
    this.onData(`(终端已启动: ${command} · cwd=${this.cwd})\n`);
    this.proc.stdout?.on('data', (d) => this.emit(String(d)));
    this.proc.stderr?.on('data', (d) => this.emit(String(d)));
    this.proc.on('exit', (code) => {
      this.onData(`\n(终端已退出，退出码 ${code ?? '-'})\n`);
      this.proc = null;
    });
  }

  write(command: string): void {
    if (!this.proc) this.start();
    this.proc?.stdin?.write(command + '\n');
  }

  stop(): void {
    if (!this.proc) return;
    try { this.proc.kill(); } catch { /* 已退出 */ }
    this.proc = null;
    this.buffer = '';
  }

  private emit(text: string): void {
    this.buffer += text;
    if (this.buffer.length > this.maxBuffer) {
      this.buffer = this.buffer.slice(-this.maxBuffer / 2);
      this.onData('(输出过长，已截断历史)\n');
    }
    this.onData(text);
  }
}
