import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_CHARS = 500_000;

const writeTool = {
  name: 'write-file.write',
  description: '把文本内容写入指定文件（覆盖已有内容）。父目录不存在时会自动创建。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径' },
      content: { type: 'string', description: '要写入的完整文本内容' },
    },
    required: ['path', 'content'],
  },
  permissions: ['fs:write'],
  // 写盘属于危险操作：执行前必须经过用户批准（审批钩子）
  requiresApproval: true,

  async execute(args, ctx) {
    // 相对路径以底座注入的工作目录为基准，而不是进程 cwd（Electron 里 cwd 不可靠）
    const filePath = path.resolve(ctx?.workingDir ?? process.cwd(), String(args.path ?? ''));
    const content = String(args.content ?? '');
    if (content.length > MAX_CHARS) {
      return { ok: false, output: `内容过长（${content.length} 字符，上限 ${MAX_CHARS}）`, error: 'content-too-large' };
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    return { ok: true, output: `已写入 ${filePath}（${content.length} 字符）` };
  },
};

export const plugin = { tools: [writeTool] };
