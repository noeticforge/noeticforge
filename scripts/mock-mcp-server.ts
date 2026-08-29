import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * mock MCP server（IPC 自测用，stdio 传输，不依赖网络）：
 *   echo      —— 原样返回文本（无注解 → auto 策略下默认需审批）
 *   touch-ok  —— 无参数，annotations.readOnlyHint = true（验证免审批映射）
 *   boom      —— 执行必抛异常（验证 tool-crashed 自愈路径）
 */
const server = new McpServer({ name: 'mock-echo', version: '1.0.0' });

server.registerTool('echo', {
  description: '原样返回输入文本',
  inputSchema: { text: z.string().describe('要回显的文本') },
}, async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }));

server.registerTool('touch-ok', {
  description: '无参数的只读检查工具',
  annotations: { readOnlyHint: true },
}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));

server.registerTool('boom', {
  description: '总是失败的工具（测试错误回喂）',
}, async () => {
  throw new Error('mock 故意失败');
});

await server.connect(new StdioServerTransport());
