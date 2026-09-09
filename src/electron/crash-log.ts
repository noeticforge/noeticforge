import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 主进程崩溃兜底：uncaughtException / unhandledRejection 落盘 crash.log。
 * MVP 验收项（DEVELOPMENT_PLAN §3.6-3）：崩溃必须留证据，现场可回溯。
 *
 * 语义约束：
 * - 不 import electron——保持可脱离 GUI 单测（同 agent-service 的解耦铁律）；
 * - uncaughtException 记日志后按原语义退出（默认无 handler 时 Node 本来就会崩退，
 *   行为不变，只是多了落盘证据）；unhandledRejection 记日志后存活
 *   （handler 永不 throw 契约下它不该出现，出现即 bug，但单条 Promise 失败不值得整机陪葬）；
 * - 日志写入本身再失败则静默放弃：兜底路径里没有任何人接得住新异常。
 */

const MAX_LOG_BYTES = 512 * 1024;

export interface CrashGuardOptions {
  /** crash.log 所在目录（应用数据目录，与 config.json/audit.log 同级） */
  dir: string;
  /** 应用版本（main.ts 传 app.getVersion()） */
  appVersion: string;
  /** uncaughtException 记录后的退出动作（注入以便单测；main.ts 传 app.exit） */
  exit: (code: number) => void;
}

export function crashLogPath(dir: string): string {
  return path.join(dir, 'crash.log');
}

/** 把任意 throw 值格式化为人可读的堆栈文本（非 Error 也能记） */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  try {
    return String(err);
  } catch {
    return '<unprintable rejection value>';
  }
}

/** 生成一条崩溃报告（不含换行外修饰，供 append 直接落盘） */
export function formatCrashReport(source: string, err: unknown, appVersion: string): string {
  const when = new Date().toISOString();
  const env = `app=${appVersion} node=${process.version} ${process.platform}/${process.arch}`;
  return [`[${when}] ${source} (${env})`, formatError(err), ''].join('\n') + '\n';
}

/** 追加写入 crash.log；超过上限先截断（崩溃风暴不致撑爆磁盘） */
export function appendCrashReport(dir: string, report: string): void {
  try {
    const file = crashLogPath(dir);
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
      writeFileSync(file, '[crash.log exceeded 512KB — truncated]\n');
    }
    appendFileSync(file, report);
  } catch {
    // 兜底路径：无处可报，只能静默
  }
}

/** 安装双兜底 handler。proc 参数仅为单测注入，运行期不传。 */
export function installCrashGuards(opts: CrashGuardOptions, proc: NodeJS.Process = process): void {
  proc.on('uncaughtException', (err) => {
    appendCrashReport(opts.dir, formatCrashReport('uncaughtException', err, opts.appVersion));
    opts.exit(1);
  });
  proc.on('unhandledRejection', (reason) => {
    appendCrashReport(opts.dir, formatCrashReport('unhandledRejection', reason, opts.appVersion));
  });
}
