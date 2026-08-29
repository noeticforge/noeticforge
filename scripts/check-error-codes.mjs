/**
 * 错误码三方一致性校验（CI 防线，CONTRIBUTING.md 铁律 4）。
 *
 * 校验三组关系：
 *   1. 后端实际使用的错误码（src/electron/agent-service.ts 中的 'E_*' 字面量）
 *      ⊆ 单一事实源（src/shared/error-codes.ts）
 *   2. 单一事实源 ⊆ 协议文档（docs/IPC_EVENT_PROTOCOL.md）
 *   3. UI 文案表（renderer/app.js 的 ERR_TEXT）的 key ⊆ 单一事实源
 * 从 repo 根目录运行：npm run check:codes
 */
import { readFileSync } from 'node:fs';

const fail = (msg) => {
  console.error(`❌ ${msg}`);
  process.exit(1);
};

const codesIn = (source, regex) => {
  const set = new Set();
  for (const m of source.matchAll(regex)) set.add(m[1]);
  return set;
};

const sharedSrc = readFileSync('src/shared/error-codes.ts', 'utf-8');
const shared = codesIn(sharedSrc, /^\s{2}(E_[A-Z_0-9]+):/gm);
if (shared.size === 0) fail('无法从 src/shared/error-codes.ts 解析出错误码');

const serviceSrc = readFileSync('src/electron/agent-service.ts', 'utf-8');
const used = codesIn(serviceSrc, /'(E_[A-Z_0-9]+)'/g);

const docSrc = readFileSync('docs/IPC_EVENT_PROTOCOL.md', 'utf-8');
const doc = codesIn(docSrc, /`(E_[A-Z_0-9]+)`/g);

const rendererSrc = readFileSync('renderer/app.js', 'utf-8');
const ui = codesIn(rendererSrc, /^\s{2}(E_[A-Z_0-9]+):/gm);

const missingInShared = [...used].filter((c) => !shared.has(c));
if (missingInShared.length) fail(`后端使用了事实源中不存在的错误码: ${missingInShared.join(', ')}`);

const missingInDoc = [...shared].filter((c) => !doc.has(c));
if (missingInDoc.length) fail(`事实源中的错误码未写入协议文档 §6.2: ${missingInDoc.join(', ')}`);

const unknownInUi = [...ui].filter((c) => !shared.has(c));
if (unknownInUi.length) fail(`renderer/app.js 的 ERR_TEXT 含未知错误码: ${unknownInUi.join(', ')}`);

console.log(`✅ 错误码三方一致（事实源 ${shared.size} 个，后端使用 ${used.size} 个，UI 覆盖 ${ui.size} 个）`);
