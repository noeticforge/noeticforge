import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ChatMessage, LLMProvider, MessageContent } from '../../types.js';
import { contentToText } from '../../types.js';
import { trimHistory } from '../../core/context.js';
import { SYSTEM_PROMPT, err, truncateText } from '../types.js';
import type { IpcResult } from '../types.js';

/**
 * Workspace file access, attachment parsing, context compression and
 * layered system prompt assembly.
 */
export class WorkspaceService {
  private readonly appDir: string;
  private readonly getContextBudget: () => number;

  constructor(appDir: string, getContextBudget: () => number) {
    this.appDir = appDir;
    this.getContextBudget = getContextBudget;
  }

  /** Inject @-referenced file contents at the tail of a message. */
  injectContextFiles(content: MessageContent, files: string[]): MessageContent {
    const blocks: string[] = [];
    for (const rel of files) {
      const abs = path.isAbsolute(rel) ? rel : path.resolve(this.appDir, rel);
      try {
        if (!existsSync(abs)) continue;
        const st = statSync(abs);
        if (!st.isFile() || st.size > 500_000) continue;
        const text = readFileSync(abs, 'utf-8').slice(0, 20_000);
        blocks.push(`--- ${rel} ---\n${text}`);
      } catch {
        // Binary or unreadable files are skipped silently.
      }
    }
    if (!blocks.length) return content;
    const ctxText = `\n\n【引用上下文（用户通过 @ 引用的文件）】\n${blocks.join('\n\n')}`;
    return typeof content === 'string' ? content + ctxText : [...content, { type: 'text' as const, text: ctxText }];
  }

  /** §3.25 preview-file */
  async previewFile(req: { path: string }): Promise<IpcResult<{ exists: boolean; content: string }>> {
    const raw = req?.path;
    if (typeof raw !== 'string' || !raw.trim()) {
      return err('E_INVALID_CONFIG', 'path 不能为空', 'unknown');
    }
    const file = path.isAbsolute(raw) ? raw : path.resolve(this.appDir, raw);
    if (!existsSync(file)) return { ok: true, data: { exists: false, content: '' } };
    try {
      const st = await stat(file);
      if (!st.isFile()) return { ok: true, data: { exists: false, content: '' } };
      const content = await readFile(file, 'utf-8');
      return { ok: true, data: { exists: true, content: content.length > 200_000 ? content.slice(0, 200_000) : content } };
    } catch {
      return { ok: true, data: { exists: false, content: '' } };
    }
  }

  /** §3.26 list-workspace-files */
  async listWorkspaceFiles(req: { query?: string }): Promise<IpcResult<{ files: Array<{ name: string; rel: string; isDir: boolean }> }>> {
    const SKIP = new Set(['node_modules', 'dist', 'release', '.git', 'sessions', 'out', 'build', '.vs', 'coverage']);
    const query = (req?.query ?? '').trim().toLowerCase();
    const out: Array<{ name: string; rel: string; isDir: boolean }> = [];
    const walk = async (dir: string, relBase: string, depth: number): Promise<void> => {
      if (depth > 3 || out.length >= 200) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= 200) return;
        if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
        if (SKIP.has(entry.name)) continue;
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          out.push({ name: entry.name, rel: rel + '/', isDir: true });
          await walk(path.join(dir, entry.name), rel, depth + 1);
        } else if (entry.isFile()) {
          out.push({ name: entry.name, rel, isDir: false });
        }
      }
    };
    await walk(this.appDir, '', 0);
    const files = query ? out.filter((f) => f.rel.toLowerCase().includes(query)) : out;
    return { ok: true, data: { files: files.slice(0, 50) } };
  }

  /** §3.27 read-attachment */
  async readAttachment(req: { path: string }): Promise<IpcResult<{ name: string; kind: 'image' | 'text'; mediaType: string; data?: string; text?: string }>> {
    const raw = req?.path;
    if (typeof raw !== 'string' || !raw.trim()) {
      return err('E_INVALID_CONFIG', 'path 不能为空', 'unknown');
    }
    const file = path.isAbsolute(raw) ? raw : path.resolve(this.appDir, raw);
    if (!existsSync(file)) return err('E_PATH_NOT_FOUND', `文件不存在: ${raw}`, 'unknown');
    const name = path.basename(file);
    const ext = path.extname(file).toLowerCase();
    const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    try {
      const st = statSync(file);
      if (imageTypes[ext]) {
        if (st.size > 5 * 1024 * 1024) return err('E_INVALID_CONFIG', '图片超过 5MB 上限', 'unknown');
        const data = readFileSync(file).toString('base64');
        return { ok: true, data: { name, kind: 'image', mediaType: imageTypes[ext], data } };
      }
      if (st.size > 400_000) return err('E_INVALID_CONFIG', '文本附件超过 400KB 上限', 'unknown');
      const text = readFileSync(file, 'utf-8');
      return { ok: true, data: { name, kind: 'text', mediaType: 'text/plain', text } };
    } catch (e) {
      return err('E_INTERNAL', `读取附件失败: ${e instanceof Error ? e.message : String(e)}`, 'unknown');
    }
  }

  /** Context compression: summarize older turns while preserving recent turns. */
  async compressHistory(history: ChatMessage[], provider: LLMProvider): Promise<ChatMessage[]> {
    const budget = this.getContextBudget();
    const keep = trimHistory(history, Math.max(budget / 2, 2000)).messages;
    const keptSet = new Set(keep);
    const older = history.filter((m) => !keptSet.has(m));
    if (older.length === 0) return history;
    const transcript = older
      .map((m) => {
        const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '工具';
        const tools = m.toolCalls?.length ? `（调用 ${m.toolCalls.map((c) => c.name).join(', ')}）` : '';
        return `${who}${tools}: ${truncateText(contentToText(m.content) || (m.toolCalls ? '工具调用' : ''), 400)}`;
      })
      .join('\n');
    const res = await provider.chat(
      [{
        role: 'user',
        content: `把下面这段人与助手的历史对话压缩成一份要点摘要（保留：任务目标、已做决定的操作、涉及的关键文件路径、未完成事项）。直接输出摘要本身，不超过 300 字：\n\n${transcript.slice(0, 12_000)}`,
      }],
      [],
    );
    const summary = res.content.trim();
    if (!summary) throw new Error('摘要为空');
    return [
      { role: 'user', content: `【历史摘要】以下是本次会话较早内容的要点：\n${summary}` },
      { role: 'assistant', content: '已了解以上背景，请继续。' },
      ...keep,
    ];
  }

  /** Layered system prompt: base prompt + global and project AGENTS.md. */
  buildSystemPrompt(): string {
    const parts = [SYSTEM_PROMPT];
    const globalPath = path.join(homedir(), '.agent-base', 'AGENTS.md');
    const projectPath = path.join(this.appDir, 'AGENTS.md');
    for (const [label, file] of [['全局说明', globalPath], ['项目说明', projectPath]] as const) {
      try {
        if (existsSync(file)) {
          const content = readFileSync(file, 'utf-8').trim();
          if (content) parts.push(`# ${label}（AGENTS.md，请严格遵守）\n${content.slice(0, 20_000)}`);
        }
      } catch {
        // Unreadable AGENTS.md must not block a conversation.
      }
    }
    return parts.join('\n\n');
  }
}
