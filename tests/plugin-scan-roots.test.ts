import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolvePluginScanRoots } from '../src/electron/services/plugin-service.js';

/**
 * 扫描根解析自测(对应打包态内置插件丢失的修复,DEVELOPMENT_PLAN §3.6 崩溃审计 P1-5):
 * 断言 dev 态内置目录被数据目录根覆盖不重复扫、打包态 asar 内置目录必然入选、
 * 同级前缀目录(plugins-user)不误判为嵌套。路径全部经 path.resolve/join 构造,win/posix 语义一致。
 */

describe('resolvePluginScanRoots', () => {
  it('开发态:cwd=appDir=repo,builtin 被 repo/plugins 覆盖,只剩一个根(+不存在的 electron dist 分支)', () => {
    const repo = path.resolve('fixture-repo');
    const roots = resolvePluginScanRoots({
      appDir: repo,
      cwd: repo,
      execPath: path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe'),
      builtinDir: path.join(repo, 'plugins', 'builtin'),
    });
    expect(roots).toEqual([
      path.join(repo, 'plugins'),
      path.join(repo, 'node_modules', 'electron', 'dist', 'plugins'),
    ]);
  });

  it('打包态(win/posix 通用):Roaming 数据根、安装目录根(与 cwd 重复去重)、asar 内置根三存', () => {
    const roaming = path.resolve('fixture-roaming', 'agent-base');
    const install = path.resolve('fixture-prog', 'agent-base');
    const asarBuiltin = path.join(install, 'resources', 'app.asar', 'plugins', 'builtin');
    const roots = resolvePluginScanRoots({
      appDir: roaming,
      cwd: install,
      execPath: path.join(install, 'agent-base.exe'),
      builtinDir: asarBuiltin,
    });
    expect(roots).toEqual([
      path.join(roaming, 'plugins'),
      path.join(install, 'plugins'),
      asarBuiltin,
    ]);
  });

  it('同级前缀目录不算嵌套:plugins-user 不会被 repo/plugins 吞掉', () => {
    const repo = path.resolve('fixture-repo2');
    const sibling = path.resolve('fixture-repo2-plugins-user');
    const roots = resolvePluginScanRoots({
      appDir: repo,
      cwd: repo,
      execPath: path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe'),
      builtinDir: sibling,
    });
    expect(roots[roots.length - 1]).toBe(sibling);
    expect(roots.filter((r) => r === sibling)).toHaveLength(1);
    expect(roots.some((r) => r === path.join(repo, 'plugins'))).toBe(true);
  });

  it('空 execPath 不炸(portable 边界)', () => {
    const repo = path.resolve('fixture-repo3');
    expect(() =>
      resolvePluginScanRoots({ appDir: repo, cwd: repo, execPath: '', builtinDir: path.join(repo, 'plugins', 'builtin') }),
    ).not.toThrow();
  });
});
