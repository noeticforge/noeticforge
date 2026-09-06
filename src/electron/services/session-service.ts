import path from 'node:path';
import { SessionStore, type Session } from '../../core/session-store.js';
import { contentToText, type LLMProvider } from '../../types.js';
import { err, toSessionDTO } from '../types.js';
import type { IpcResult, PushChannel, SessionDTO, SessionMetaDTO } from '../types.js';

/**
 * 会话管理（协议 §3.9-3.13）：封装 SessionStore 的增删改查与首轮自动命名。
 * running 锁 / 排队 / activeSessionId 属于门面调度器，不在这里。
 */
export class SessionService {
  private readonly store: SessionStore;
  private readonly getProvider: () => LLMProvider | null;
  private readonly pushEvent: (channel: PushChannel, payload: unknown) => void;
  private activeSessionId: string | null = null;

  constructor(
    appDir: string,
    getProvider: () => LLMProvider | null,
    pushEvent: (channel: PushChannel, payload: unknown) => void,
  ) {
    this.store = new SessionStore(path.join(appDir, 'sessions'));
    this.getProvider = getProvider;
    this.pushEvent = pushEvent;
  }

  async init(): Promise<void> {
    await this.store.init();
    if (this.store.list().length === 0) {
      await this.store.create('默认会话');
    }
    this.activeSessionId = this.store.list()[0]?.id ?? null;
  }

  getActiveId(): string | null {
    return this.activeSessionId;
  }

  list(): SessionMetaDTO[] {
    return this.store.list();
  }

  get(id: string): Session | undefined {
    return this.store.get(id);
  }

  async create(title?: string): Promise<Session> {
    return this.store.create(title);
  }

  async setTitle(id: string, title: string): Promise<void> {
    await this.store.setTitle(id, title);
  }

  listResult(): IpcResult<{ sessions: SessionMetaDTO[] }> {
    return { ok: true, data: { sessions: this.store.list() } };
  }

  async createSession(title?: string): Promise<IpcResult<{ session: SessionDTO }>> {
    const session = await this.store.create(title);
    this.activeSessionId = session.id;
    this.pushEvent('sessions-changed', { sessions: this.store.list() });
    return { ok: true, data: { session: toSessionDTO(session) } };
  }

  async switchSession(id: string): Promise<IpcResult<{ session: SessionDTO }>> {
    const session = this.store.get(id);
    if (!session) return err('E_SESSION_NOT_FOUND', `会话不存在: ${id}`, 'session');
    this.activeSessionId = session.id;
    return { ok: true, data: { session: toSessionDTO(session) } };
  }

  async renameSession(req: { id: string; title: string }): Promise<IpcResult<null>> {
    const session = this.store.get(req?.id);
    if (!session) return err('E_SESSION_NOT_FOUND', `会话不存在: ${req?.id}`, 'session');
    if (typeof req.title !== 'string' || !req.title.trim()) {
      return err('E_INVALID_CONFIG', 'title 不能为空', 'session');
    }
    await this.store.setTitle(req.id, req.title);
    this.pushEvent('sessions-changed', { sessions: this.store.list() });
    return { ok: true, data: null };
  }

  async removeAndRepairActive(id: string): Promise<void> {
    await this.store.remove(id);
    if (this.activeSessionId !== id) return;
    this.activeSessionId = this.store.list()[0]?.id ?? null;
    if (!this.activeSessionId) {
      const created = await this.store.create('默认会话');
      this.activeSessionId = created.id;
    }
  }

  async remove(id: string): Promise<boolean> {
    return this.store.remove(id);
  }

  isUntitled(session: Session): boolean {
    return this.store.isUntitled(session);
  }

  async replaceMessages(id: string, messages: Session['messages']): Promise<void> {
    await this.store.replaceMessages(id, messages);
  }

  async appendMessages(id: string, messages: Session['messages']): Promise<void> {
    await this.store.appendMessages(id, messages);
  }

  async updateMeta(id: string, patch: Partial<NonNullable<Session['meta']>>): Promise<void> {
    await this.store.updateMeta(id, patch);
  }

  /** 首轮对话后自动起标题（假模型除外——不消费测试队列） */
  maybeAutoTitle(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (!session || !this.store.isUntitled(session) || !this.getProvider() || this.getProvider()!.id === 'mock') return;
    const firstUser = contentToText(session.messages.find((m) => m.role === 'user')?.content ?? '');
    if (!firstUser.trim()) return;
    const firstAnswer = contentToText(session.messages.find((m) => m.role === 'assistant' && contentToText(m.content).trim())?.content ?? '');
    const prompt = `请用简练的中文概括下面用户问题的核心主题作为会话标题（不超过12个字，直接输出标题本身，不要引号、句号、书名号或任何多余文字）：\n用户：${firstUser.slice(0, 500)}${firstAnswer ? `\n助手：${firstAnswer.slice(0, 300)}` : ''}`;
    void this.getProvider()!
      .chat([{ role: 'user', content: prompt }], [])
      .then(async (res) => {
        const title = res.content.trim().replace(/^["'「『《“#\s]+|["'」』》”\s]+$/g, '').slice(0, 20);
        const cur = this.store.get(sessionId);
        // 用户在生成期间手动改过名 → 不覆盖（CODE_REVIEW.md F7）
        if (!cur || !this.store.isUntitled(cur)) return;
        await this.store.setTitle(sessionId, title || firstUser.slice(0, 16));
      })
      .catch(async () => {
        const cur = this.store.get(sessionId);
        if (!cur || !this.store.isUntitled(cur)) return;
        await this.store.setTitle(sessionId, firstUser.slice(0, 16));
      })
      .then(() => {
        this.pushEvent('sessions-changed', { sessions: this.store.list() });
      });
  }
}
