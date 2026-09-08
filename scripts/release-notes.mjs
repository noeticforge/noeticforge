import { readFileSync, writeFileSync } from 'node:fs';

/**
 * 从 CHANGELOG.md 抽出当前版本的小节，生成 GitHub Release 正文 RELEASE_NOTES.md。
 *
 * 为什么要脚本：electron-builder 的 GitHub 发布器不读 CHANGELOG，此前每条 Release 的
 * 说明都是空的（12 条里只有 2 条是手工补的）。让发布流水线自动生成，说明才不会漏。
 *
 * 用法：node scripts/release-notes.mjs [输出路径]
 */

const out = process.argv[2] ?? 'RELEASE_NOTES.md';
const version = JSON.parse(readFileSync('package.json', 'utf-8')).version;
const changelog = readFileSync('CHANGELOG.md', 'utf-8');

// 取 `## [x.y.z]` 到下一个 `## [` 之间的内容
const lines = changelog.split('\n');
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md 里找不到 ## [${version}] 小节，无法生成发布说明`);
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith('## [')) {
    end = i;
    break;
  }
}
const section = lines.slice(start, end).join('\n');
// 标题行 `## [x.y.z] - 日期（说明，作者）` 整行换成干净的小标题：
// 版本号已在最上方的 H1 里，这里只保留日期，避免剥出「##  - 2026-09-08（…」这种残缺行
const date = /^## \[[^\]]+\]\s*-\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(section)?.[1] ?? '';
const sectionBody = section
  .replace(/^## \[[^\]]+\].*$/m, `## 变更明细${date ? `（${date}）` : ''}`)
  .trimEnd();

const files = [
  ['Windows 安装版', `agent-base-${version}-setup.exe`],
  ['Windows 免安装', `agent-base-${version}-portable.exe`],
  ['macOS (Apple Silicon)', `agent-base-${version}-arm64.dmg`],
  ['Linux', `agent-base-${version}.AppImage`],
];

const body = [
  `# v${version}`,
  '',
  '## 下载',
  '',
  '| 平台 | 文件 |',
  '| --- | --- |',
  ...files.map(([label, name]) => `| ${label} | \`${name}\` |`),
  '',
  '---',
  '',
  sectionBody,
  '',
].join('\n');

writeFileSync(out, body, 'utf-8');
console.log(`已生成 ${out}（v${version}，${body.length} 字符）`);
