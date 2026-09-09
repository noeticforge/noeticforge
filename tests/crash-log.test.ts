import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendCrashReport,
  crashLogPath,
  formatCrashReport,
  formatError,
  installCrashGuards,
} from '../src/electron/crash-log.js';

/**
 * 崩溃兜底自测（不启动 electron、不向真实 process 挂 handler）：
 * 验证「异常 → 落盘 → 按原语义退出」的报告内容与双 handler 行为，
 * 以及日志封顶与写盘失败静默两条边界。
 */

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'crash-log-test-'));
}

/** 制造必然写盘失败的目录：crash.log 的路径被同名「目录」占据 → append 必抛 */
function unwritableDir(base: string): string {
  mkdirSync(path.join(base, 'crash.log'));
  return base;
}

describe('formatError', () => {
  it('Error 优先取堆栈', () => {
    const err = new Error('boom');
    expect(formatError(err)).toContain('Error: boom');
  });

  it('非 Error 值也能记录', () => {
    expect(formatError('字符串异常')).toBe('字符串异常');
    expect(formatError({ code: 42 })).toBe('[object Object]');
  });

  it('toString 抛错的值不击穿兜底', () => {
    const evil = { toString() { throw new Error('no print'); } };
    expect(formatError(evil)).toBe('<unprintable rejection value>');
  });
});

describe('formatCrashReport', () => {
  it('含时间戳、来源、版本与环境行、堆栈正文', () => {
    const report = formatCrashReport('uncaughtException', new Error('kaboom'), '9.9.9');
    const lines = report.split('\n');
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] uncaughtException \(app=9\.9\.9 node=v\d+\./);
    expect(lines[0]).toContain(`${process.platform}/${process.arch}`);
    expect(lines[1]).toContain('Error: kaboom');
  });
});

describe('appendCrashReport', () => {
  it('首条创建文件，后续追加', async () => {
    const dir = await tempDir();
    appendCrashReport(dir, 'R1\n');
    appendCrashReport(dir, 'R2\n');
    expect(await readFile(crashLogPath(dir), 'utf8')).toBe('R1\nR2\n');
    await rm(dir, { recursive: true, force: true });
  });

  it('超过 512KB 上限时先截断再写', async () => {
    const dir = await tempDir();
    appendCrashReport(dir, 'x'.repeat(600 * 1024));
    appendCrashReport(dir, 'FRESH\n');
    const content = await readFile(crashLogPath(dir), 'utf8');
    expect(content.startsWith('[crash.log exceeded 512KB — truncated]')).toBe(true);
    expect(content).toBe('[crash.log exceeded 512KB — truncated]\nFRESH\n');
    await rm(dir, { recursive: true, force: true });
  });

  it('写盘失败静默放弃，绝不抛出', async () => {
    const dir = unwritableDir(await tempDir());
    expect(() => appendCrashReport(dir, 'boom\n')).not.toThrow();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('installCrashGuards', () => {
  /** 假 process：捕获两个 handler，供测试手动 emit */
  function fakeProc() {
    const handlers = new Map<string, (arg: unknown) => void>();
    const proc = {
      on(event: string, fn: (arg: unknown) => void) { handlers.set(event, fn); },
    } as unknown as NodeJS.Process;
    return { proc, emit: (event: string, arg: unknown) => handlers.get(event)!(arg) };
  }

  it('uncaughtException：落盘报告并以退出码 1 终止', async () => {
    const dir = await tempDir();
    let exitCode: number | null = null;
    const { proc, emit } = fakeProc();
    installCrashGuards({ dir, appVersion: '0.7.3', exit: (c) => { exitCode = c; } }, proc);

    emit('uncaughtException', new Error('sync crash'));
    expect(exitCode).toBe(1);
    const log = await readFile(crashLogPath(dir), 'utf8');
    expect(log).toContain('uncaughtException');
    expect(log).toContain('Error: sync crash');
    await rm(dir, { recursive: true, force: true });
  });

  it('unhandledRejection：落盘但不退出（应用存活）', async () => {
    const dir = await tempDir();
    let exited = false;
    const { proc, emit } = fakeProc();
    installCrashGuards({ dir, appVersion: '0.7.3', exit: () => { exited = true; } }, proc);

    emit('unhandledRejection', 'promise 炸了');
    expect(exited).toBe(false);
    expect(existsSync(crashLogPath(dir))).toBe(true);
    const log = await readFile(crashLogPath(dir), 'utf8');
    expect(log).toContain('unhandledRejection');
    expect(log).toContain('promise 炸了');
    await rm(dir, { recursive: true, force: true });
  });

  it('崩溃风暴场景：落盘失败也不引发 handler 二次异常', async () => {
    const dir = unwritableDir(await tempDir());
    const { proc, emit } = fakeProc();
    let exitCode: number | null = null;
    installCrashGuards({ dir, appVersion: '0.7.3', exit: (c) => { exitCode = c; } }, proc);
    expect(() => emit('uncaughtException', new Error('quiet'))).not.toThrow();
    expect(exitCode).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });
});
