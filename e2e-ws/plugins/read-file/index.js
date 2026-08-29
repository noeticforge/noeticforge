import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_CHARS = 100_000;

const readTool = {
  name: 'read-file.read',
  description: '读取指定路径的文本文件内容。path 支持绝对路径或相对当前工作目录的路径。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要读取的文件路径' },
    },
    required: ['path'],
  },
  permissions: ['fs:read'],
  requiresApproval: false,

  async execute(args, ctx) {
    // 相对路径以底座注入的工作目录为基准，而不是进程 cwd（Electron 里 cwd 不可靠）
    const filePath = path.resolve(ctx?.workingDir ?? process.cwd(), String(args.path ?? ''));
    const content = await readFile(filePath, 'utf-8');
    if (content.length > MAX_CHARS) {
      return {
        ok: true,
        output: content.slice(0, MAX_CHARS) + `\n…（已截断，原文 ${content.length} 字符）`,
      };
    }
    return { ok: true, output: content };
  },
};

export const plugin = { tools: [readTool] };
