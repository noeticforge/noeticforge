import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

mkdirSync('registry/packages', { recursive: true });

function packPlugin(name, version, displayName, description, author, permissions) {
  const dir = path.join('plugins/builtin', name);
  const zip = new AdmZip();
  zip.addLocalFile(path.join(dir, 'manifest.json'));
  zip.addLocalFile(path.join(dir, 'index.js'));
  const fileName = `${name}-${version}.zip`;
  const zipPath = path.join('registry/packages', fileName);
  zip.writeZip(zipPath);
  const buf = readFileSync(zipPath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  console.log(`打包 ${name}: ${zipPath}, sha256: ${sha256}, 大小: ${buf.length} bytes`);
  return {
    name,
    version,
    displayName,
    description,
    author,
    permissions,
    downloadUrl: `https://github.com/noeticforge/noeticforge/releases/download/v0.5.2/${fileName}`,
    localPackage: `registry/packages/${fileName}`,
    sha256,
    protocolVersion: 1,
    homepage: 'https://github.com/noeticforge/noeticforge',
  };
}

const p1 = packPlugin(
  'system-master',
  '1.0.0',
  '全能系统管家',
  '全盘文件读写、桌面一键投放、PowerShell/CMD终端调度与硬件性能全景扫描',
  '何惜',
  ['fs:read', 'fs:write', 'shell:exec'],
);

const p2 = packPlugin(
  'm3e-canvas',
  '1.0.0',
  'M3E Canvas 画布设计器',
  'Material 3 Expressive 可视化原型设计器，生成在线交互画板链接与 AI 提示词直接导出桌面',
  '何惜',
  ['fs:read', 'fs:write'],
);

const p3 = packPlugin(
  'ask-user',
  '1.0.0',
  'AI 决策交互选择',
  '面临多种技术路线、方案分歧或需求澄清时，弹出液态玻璃 ABCD 选项卡片供用户快捷决策并实时回填',
  '何惜',
  [],
);

const registry = {
  $schema: './registry.schema.md',
  name: 'agent-base-plugin-registry',
  version: 1,
  plugins: [p1, p2, p3],
};

writeFileSync('registry/registry.json', JSON.stringify(registry, null, 2), 'utf-8');
console.log('registry/registry.json 已成功登记两个官方精选扩展插件！');
