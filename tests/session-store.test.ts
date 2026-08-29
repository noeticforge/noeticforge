import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/core/session-store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ab-sessions-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('空目录 init → 无会话；create 落盘且重启可恢复', async () => {
    const s1 = new SessionStore(dir);
    await s1.init();
    expect(s1.list()).toHaveLength(0);

    const created = await s1.create('测试');
    expect(existsSync(path.join(dir, `${created.id}.json`))).toBe(true);

    const s2 = new SessionStore(dir);
    await s2.init();
    expect(s2.list()).toHaveLength(1);
    expect(s2.get(created.id)?.title).toBe('测试');
  });

  it('append / replace / setTitle 更新内存与磁盘', async () => {
    const s = new SessionStore(dir);
    await s.init();
    const { id } = await s.create();

    await s.appendMessages(id, [{ role: 'user', content: '你好' }]);
    await s.appendMessages(id, [{ role: 'assistant', content: '你好！' }]);
    expect(s.get(id)!.messages).toHaveLength(2);

    await s.replaceMessages(id, [{ role: 'user', content: '重置' }]);
    expect(s.get(id)!.messages).toHaveLength(1);

    await s.setTitle(id, '新标题');
    expect(s.get(id)!.title).toBe('新标题');

    const s2 = new SessionStore(dir);
    await s2.init();
    expect(s2.get(id)!.messages).toEqual([{ role: 'user', content: '重置' }]);
    expect(s2.get(id)!.title).toBe('新标题');
  });

  it('list 按 updatedAt 倒序', async () => {
    const s = new SessionStore(dir);
    await s.init();
    const a = await s.create('A');
    const b = await s.create('B');
    await s.setTitle(a.id, 'A2'); // a.updatedAt 后移
    const metas = s.list();
    expect(metas[0].id).toBe(a.id);
    expect(metas[1].id).toBe(b.id);
  });

  it('remove 删除内存与文件；未知 id 安全返回 false', async () => {
    const s = new SessionStore(dir);
    await s.init();
    const { id } = await s.create();
    expect(await s.remove(id)).toBe(true);
    expect(existsSync(path.join(dir, `${id}.json`))).toBe(false);
    expect(await s.remove(id)).toBe(false);
    expect(await s.remove('不存在的 id')).toBe(false);
  });

  it('损坏的会话文件被跳过，不拖垮启动，也不删除现场', async () => {
    const s = new SessionStore(dir);
    await s.init();
    await s.create('好的');
    await writeFile(path.join(dir, 's-broken.json'), '{ 这不是 JSON', 'utf-8');

    const s2 = new SessionStore(dir);
    await s2.init();
    expect(s2.list()).toHaveLength(1);
    expect(existsSync(path.join(dir, 's-broken.json'))).toBe(true); // 保留现场
  });

  it('结构不完整的会话文件（缺 messages）同样跳过', async () => {
    await writeFile(path.join(dir, 's-bad.json'), JSON.stringify({ id: 's-bad', title: 'x' }), 'utf-8');
    const s = new SessionStore(dir);
    await s.init();
    expect(s.get('s-bad')).toBeUndefined();
  });

  it('isUntitled 判定默认标题', async () => {
    const s = new SessionStore(dir);
    await s.init();
    const created = await s.create();
    expect(s.isUntitled(created)).toBe(true);
    await s.setTitle(created.id, '改过名');
    expect(s.isUntitled(s.get(created.id)!)).toBe(false);
  });

  it('persist 是原子写：目录里不残留 .tmp 中间文件', async () => {
    const s = new SessionStore(dir);
    await s.init();
    await s.create('原子');
    await s.appendMessages((await s.list())[0] ? (s.list()[0].id) : '', [{ role: 'user', content: 'x' }]);
    const files = await readdir(dir);
    expect(files.every((f) => !f.includes('.tmp-'))).toBe(true);
  });

  it('原子写产物是合法 JSON（version: 1 完整结构）', async () => {
    const s = new SessionStore(dir);
    await s.init();
    const { id } = await s.create('结构');
    const raw = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf-8'));
    expect(raw).toMatchObject({ version: 1, id, title: '结构' });
    expect(Array.isArray(raw.messages)).toBe(true);
  });
});
