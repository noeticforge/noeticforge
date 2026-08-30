import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ApprovalResolution, ToolCall, ToolResult } from '../../types.js';
import { err, truncate } from '../types.js';
import type { IpcResult } from '../types.js';

/**
 * Pending approval promises and JSONL audit persistence.
 * Running-loop cancellation stays in the facade; this service only owns the
 * shared approval pipeline and audit side effects.
 */
export class ApprovalAuditService {
  private readonly appDir: string;
  private readonly pending = new Map<string, (r: ApprovalResolution) => void>();

  constructor(appDir: string) {
    this.appDir = appDir;
  }

  requestApproval(messageId: string, call: ToolCall): Promise<ApprovalResolution> {
    return new Promise<ApprovalResolution>((resolve) => {
      this.pending.set(`${messageId}:${call.id}`, resolve);
    });
  }

  resolveApproval(messageId: string, toolCallId: string, resolution: ApprovalResolution): boolean {
    const key = `${messageId}:${toolCallId}`;
    const resolve = this.pending.get(key);
    if (!resolve) return false;
    this.pending.delete(key);
    resolve(resolution);
    return true;
  }

  rejectAll(messageId: string): void {
    for (const [key, resolve] of this.pending) {
      if (key.startsWith(`${messageId}:`)) {
        resolve('rejected');
        this.pending.delete(key);
      }
    }
  }

  clearAll(messageId: string): void {
    for (const key of this.pending.keys()) {
      if (key.startsWith(`${messageId}:`)) this.pending.delete(key);
    }
  }

  async appendAudit(entry: Record<string, unknown>): Promise<void> {
    try {
      await appendFile(
        path.join(this.appDir, 'audit.log'),
        JSON.stringify({ ts: Date.now(), ...entry }) + '\n',
        'utf-8',
      );
    } catch {
      // Audit persistence must not block the business flow.
    }
  }

  appendToolAudit(call: ToolCall, result: ToolResult, sessionId: string, messageId: string): Promise<void> {
    return this.appendAudit({
      type: 'tool',
      sessionId,
      messageId,
      toolCallId: call.id,
      name: call.name,
      ok: result.ok,
      error: result.error,
      args: truncate(call.arguments, 300),
      outputChars: result.output.length,
    });
  }

  async readAudit(req: { lines?: number }): Promise<IpcResult<{ lines: string[]; total: number }>> {
    const max = Math.min(Math.max(req?.lines ?? 200, 1), 1000);
    const file = path.join(this.appDir, 'audit.log');
    if (!existsSync(file)) return { ok: true, data: { lines: [], total: 0 } };
    try {
      const raw = await readFile(file, 'utf-8');
      const all = raw.split('\n').filter((l) => l.trim());
      return { ok: true, data: { lines: all.slice(-max), total: all.length } };
    } catch (e) {
      return err('E_INTERNAL', `读取审计日志失败: ${e instanceof Error ? e.message : String(e)}`, 'unknown');
    }
  }
}
