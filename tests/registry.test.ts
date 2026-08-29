import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/core/registry.js';
import type { AgentTool, Plugin } from '../src/types.js';

function makePlugin(name: string, toolNames: string[]): Plugin {
  // toolNames 是工具的【全局完整名】（注册表按全名查冲突；命名前缀约束由加载器负责）
  const tools: AgentTool[] = toolNames.map((t) => ({
    name: t,
    description: `tool ${t}`,
    parameters: { type: 'object' },
    permissions: [],
    execute: async () => ({ ok: true, output: '' }),
  }));
  return {
    manifest: {
      name,
      version: '1.0.0',
      displayName: name,
      description: name,
      permissions: [],
      entry: 'index.js',
    },
    tools,
  };
}

describe('ToolRegistry', () => {
  it('注册 → definitions / getTool 全链路', () => {
    const r = new ToolRegistry();
    r.register(makePlugin('read-file', ['read-file.read']));
    expect(r.definitions()).toHaveLength(1);
    expect(r.definitions()[0].name).toBe('read-file.read');
    const hit = r.getTool('read-file.read');
    expect(hit?.pluginName).toBe('read-file');
    expect(r.getTool('nope.nope')).toBeUndefined();
  });

  it('同插件重复注册 → 抛错', () => {
    const r = new ToolRegistry();
    r.register(makePlugin('p1', ['p1.a']));
    expect(() => r.register(makePlugin('p1', ['p1.b']))).toThrow(/重复注册/);
  });

  it('跨插件工具名冲突 → 抛错，且注册失败不留下半注册状态', () => {
    const r = new ToolRegistry();
    r.register(makePlugin('p1', ['p1.a', 'p1.b']));
    expect(() => r.register(makePlugin('p2', ['p1.b']))).toThrow(/工具名冲突/);
    // p2 整体未进入注册表
    expect(r.listPlugins().map((p) => p.manifest.name)).toEqual(['p1']);
  });

  it('uninstall 注销插件与其全部工具', () => {
    const r = new ToolRegistry();
    r.register(makePlugin('p1', ['p1.a', 'p1.b']));
    expect(r.unregister('p1')).toBe(true);
    expect(r.getTool('p1.a')).toBeUndefined();
    expect(r.definitions()).toHaveLength(0);
    expect(r.unregister('p1')).toBe(false);
  });
});
