import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../types.js';

/**
 * 会话持久化（v0.2）：每个会话一个 JSON 文件，落盘 <dir>/<id>.json。
 * 选 JSON 文件而非 SQLite：零原生依赖，避免 node-gyp 编译地狱（见 DEVELOPMENT_PLAN.md §8.1）。
 *
 * 写入策略：每轮 loop 结束后原子写（临时文件 + rename），崩溃最多丢当前轮。
 * 内存中持有全部会话的轻量索引 + 惰性加载消息体。
 */

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  meta?: { provider?: string; model?: string };
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

interface SessionFile {
  version: 1;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  meta?: Session['meta'];
}

function randomId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `s-${t}${r}`;
}

export class SessionStore {
  private readonly dir: string;
  /** 全量内存索引：会话多时改为 LRU + 惰性加载，v0.2 直接全量持有 */
  private readonly sessions = new Map<string, Session>();

  constructor(dir: string) {
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entries = await readdir(this.dir);
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      try {
        const raw = JSON.parse(await readFile(file, 'utf-8')) as SessionFile;
        if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.messages)) continue;
        this.sessions.set(raw.id, {
          id: raw.id,
          title: raw.title ?? '未命名会话',
          createdAt: raw.createdAt ?? Date.now(),
          updatedAt: raw.updatedAt ?? raw.createdAt ?? Date.now(),
          messages: raw.messages,
          meta: raw.meta,
        });
      } catch {
        // 单个会话文件损坏不拖垮启动，跳过并保留现场（不删除，便于人工恢复）
        continue;
      }
    }
  }

  /** 列出全部会话（按 updatedAt 倒序） */
  list(): SessionMeta[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      }));
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  async create(title?: string): Promise<Session> {
    const now = Date.now();
    const session: Session = {
      id: randomId(),
      title: title?.trim() || '新的会话',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.sessions.set(session.id, session);
    await this.persist(session);
    return session;
  }

  /** 追加消息并落盘（loop 每轮结束后由 AgentService 调用） */
  async appendMessages(id: string, messages: ChatMessage[]): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.messages.push(...messages);
    session.updatedAt = Date.now();
    await this.persist(session);
  }

  /** 用完整历史替换并落盘（loop 返回 result.history 后调用） */
  async replaceMessages(id: string, messages: ChatMessage[]): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.messages = messages;
    session.updatedAt = Date.now();
    await this.persist(session);
  }

  async setTitle(id: string, title: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.title = title.trim() || session.title;
    session.updatedAt = Date.now();
    await this.persist(session);
  }

  async remove(id: string): Promise<boolean> {
    if (!this.sessions.delete(id)) return false;
    const file = this.fileOf(id);
    if (existsSync(file)) await rm(file, { force: true });
    return true;
  }

  /** 默认会话标题（尚未自动命名）判定用 */
  isUntitled(session: Session): boolean {
    return session.title === '新的会话' || session.title === '';
  }

  private fileOf(id: string): string {
    // id 只由本类生成（字母数字与 -），仍做一次净化防止路径逃逸
    const safe = id.replace(/[^a-zA-Z0-9-]/g, '');
    return path.join(this.dir, `${safe}.json`);
  }

  private async persist(session: Session): Promise<void> {
    const file = this.fileOf(session.id);
    const body: SessionFile = {
      version: 1,
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages,
      meta: session.meta,
    };
    // 原子写：临时文件 + rename，避免写一半崩溃留下半个 JSON
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(body, null, 2), 'utf-8');
    await rename(tmp, file);
  }
}
