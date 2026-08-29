import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentTool, Plugin, ToolResult } from '../types.js';
import type { ToolRegistry } from '../core/registry.js';

/**
 * MCP 管理器（v0.3）：把 MCP server 的工具桥接进底座工具注册表。
 *
 * 定位（DEVELOPMENT_PLAN.md §4.1）：MCP 是「借来的生态」——接入即获得数千个现成工具；
 * 同时 stdio 子进程天然进程隔离，是当前插件沙箱故事的主力形态。
 *
 * 配置文件 mcp.json（与 Claude Desktop / Cherry Studio 格式兼容，降低用户迁移成本）：
 *   { "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/docs"],
 *                             "approval": "auto", "enabled": true,
 *                             "tools": { "read_file": { "requiresApproval": false } } } } }
 *   或 HTTP: { "url": "http://127.0.0.1:3000/mcp" }
 *
 * 审批映射默认策略（可按 server 的 approval 字段、按 tools 覆盖）：
 *   annotations.readOnlyHint === true → 免审批
 *   其余（含 destructiveHint / 无注解）→ 默认 requiresApproval: true（宁严勿松）
 */

export type McpApprovalMode = 'auto' | 'always' | 'never';

export interface McpServerConfig {
  /** stdio 传输：启动命令 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Streamable HTTP 传输：端点 URL（command 与 url 二选一） */
  url?: string;
  /** 审批策略：auto=按注解（默认）/ always=全部审批 / never=全部免审批 */
  approval?: McpApprovalMode;
  /** 是否启用（默认 true） */
  enabled?: boolean;
  /** 按工具覆盖审批/权限 */
  tools?: Record<string, { requiresApproval?: boolean; permissions?: string[] }>;
}

export interface McpServerStatus {
  name: string;
  state: 'connected' | 'connecting' | 'disconnected' | 'error' | 'disabled';
  transport: 'stdio' | 'http';
  toolCount: number;
  error?: string;
}

export type McpPushEvent = (channel: string, payload: unknown) => void;

interface Connection {
  name: string;
  client: Client;
  config: McpServerConfig;
  status: McpServerStatus;
  reconnectAttempt: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

const SUPPORTED_PROTOCOL_VERSION = 1;
const MAX_RECONNECT_ATTEMPTS = 5;

export class McpManager {
  private readonly configPath: string;
  private readonly connections = new Map<string, Connection>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly pushEvent: McpPushEvent,
    appDir: string,
  ) {
    this.configPath = path.join(appDir, 'mcp.json');
  }

  /** 启动加载：读 mcp.json → 逐个后台连接（不阻塞 init） */
  async init(): Promise<void> {
    let config: Record<string, McpServerConfig>;
    try {
      config = await this.readConfig();
    } catch {
      return; // 配置损坏不拖垮启动，等 UI 重新 set-mcp-config
    }
    for (const [name, cfg] of Object.entries(config)) {
      if (cfg.enabled === false) {
        this.connections.set(name, {
          name,
          client: null as unknown as Client,
          config: cfg,
          status: { name, state: 'disabled', transport: cfg.url ? 'http' : 'stdio', toolCount: 0 },
          reconnectAttempt: 0,
          closed: true,
        });
        continue;
      }
      // 后台连接：失败只推状态，不阻塞底座初始化
      void this.connectServer(name, cfg).catch(() => {});
    }
  }

  status(): McpServerStatus[] {
    return [...this.connections.values()].map((c) => ({ ...c.status }));
  }

  async readConfig(): Promise<Record<string, McpServerConfig>> {
    if (!existsSync(this.configPath)) return {};
    const raw = JSON.parse(await readFile(this.configPath, 'utf-8')) as any;
    const servers = raw?.mcpServers;
    if (servers && typeof servers === 'object') return servers as Record<string, McpServerConfig>;
    // 兼容直接写成 { "fs": {...} } 的扁平格式
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, McpServerConfig>;
    return {};
  }

  /** 全量替换配置并落盘，随后同步连接状态（新增/启用连接，移除/禁用断开） */
  async setConfig(config: Record<string, McpServerConfig>): Promise<void> {
    for (const [name, cfg] of Object.entries(config)) {
      validateServerConfig(name, cfg);
    }
    await writeFile(this.configPath, JSON.stringify({ mcpServers: config }, null, 2), 'utf-8');

    const desired = new Set(Object.keys(config));
    // 断开：被移除或禁用的
    for (const [name, conn] of this.connections) {
      const cfg = config[name];
      if (!cfg || cfg.enabled === false) {
        await this.disconnectServer(name, cfg ? 'disabled' : 'disconnected');
      }
    }
    // 连接：新增或刚启用的（enabled=false 的绝不连）
    for (const [name, cfg] of Object.entries(config)) {
      if (cfg.enabled === false) continue;
      const existing = this.connections.get(name);
      if (!existing) {
        await this.connectServer(name, cfg);
      }
    }
    this.pushStatus();
  }

  async toggleServer(name: string, enabled: boolean): Promise<void> {
    const config = await this.readConfig();
    const cfg = config[name];
    if (!cfg) {
      const e = new Error(`MCP 服务器不存在: ${name}`) as Error & { code?: string };
      e.code = 'E_MCP_NOT_FOUND';
      throw e;
    }
    cfg.enabled = enabled;
    await this.setConfig(config);
  }

  async shutdown(): Promise<void> {
    for (const name of [...this.connections.keys()]) {
      await this.disconnectServer(name, 'disconnected');
    }
  }

  // ---------- 内部：连接与桥接 ----------

  private async connectServer(name: string, cfg: McpServerConfig): Promise<void> {
    await this.disconnectIfPresent(name);
    this.pushState(name, 'connecting', cfg, 0);

    const client = new Client({ name: 'agent-base', version: '0.3.0' });
    const transport = cfg.url
      ? new StreamableHTTPClientTransport(new URL(cfg.url))
      : new StdioClientTransport({
          command: cfg.command!,
          args: cfg.args ?? [],
          env: { ...processEnv(), ...(cfg.env ?? {}) },
        });

    const conn: Connection = {
      name,
      client,
      config: cfg,
      status: { name, state: 'connecting', transport: cfg.url ? 'http' : 'stdio', toolCount: 0 },
      reconnectAttempt: 0,
      closed: false,
    };
    this.connections.set(name, conn);

    client.onerror = (err) => this.onConnectionError(conn, err);
    try {
      await client.connect(transport);
    } catch (err) {
      this.onConnectionError(conn, err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // 枚举工具并桥接进注册表
    const { tools } = await client.listTools();
    const plugin = this.buildPlugin(name, cfg, client, tools as McpToolDef[]);
    if (this.registry.listPlugins().some((p) => p.manifest.name === plugin.manifest.name)) {
      this.registry.unregister(plugin.manifest.name);
    }
    this.registry.register(plugin);

    conn.status = {
      name,
      state: 'connected',
      transport: conn.status.transport,
      toolCount: plugin.tools.length,
    };
    this.pushStatus();
  }

  /** MCP 工具 → AgentTool：命名 mcp.<server>.<tool>，注解映射审批策略 */
  private buildPlugin(
    serverName: string,
    cfg: McpServerConfig,
    client: Client,
    toolDefs: McpToolDef[],
  ): Plugin {
    const approvalMode = cfg.approval ?? 'auto';
    const manifestName = `mcp-${toKebab(serverName)}`;

    const tools: AgentTool[] = toolDefs.map((def) => {
      const override = cfg.tools?.[def.name];
      const readOnly = def.annotations?.readOnlyHint === true;
      const requiresApproval =
        override?.requiresApproval ??
        (approvalMode === 'always' ? true : approvalMode === 'never' ? false : !readOnly);

      return {
        name: `mcp.${serverName}.${def.name}`,
        description: def.description ?? '',
        parameters: (def.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        permissions: (override?.permissions as never) ?? [],
        requiresApproval,
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          try {
            const result = (await client.callTool({ name: def.name, arguments: args })) as McpCallResult;
            const text = (result.content ?? [])
              .map((part) => (part.type === 'text' ? part.text : JSON.stringify(part)))
              .join('\n');
            if (result.isError) {
              return { ok: false, output: text || 'MCP 工具返回错误', error: 'mcp-tool-error' };
            }
            return { ok: true, output: text };
          } catch (err) {
            // server 崩溃不许拖垮循环：转成错误结果喂回模型（复用自愈语义）
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, output: `MCP 工具执行异常: ${message}`, error: 'tool-crashed' };
          }
        },
      };
    });

    return {
      manifest: {
        name: manifestName,
        version: '1.0.0',
        displayName: `MCP: ${serverName}`,
        description: `MCP 服务器 ${serverName} 桥接的工具集`,
        permissions: [],
        entry: 'mcp://dynamic',
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      },
      tools,
    };
  }

  private async disconnectServer(name: string, state: 'disconnected' | 'disabled'): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    conn.closed = true;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    this.connections.delete(name);
    this.registry.unregister(`mcp-${toKebab(name)}`);
    try {
      await conn.client?.close();
    } catch {
      // 关闭失败无需处理，进程退出时由传输层自行清理
    }
    this.pushState(name, state, conn.config, 0);
  }

  private async disconnectIfPresent(name: string): Promise<void> {
    if (this.connections.has(name)) {
      await this.disconnectServer(name, 'disconnected');
    }
  }

  private onConnectionError(conn: Connection, err: Error): void {
    if (conn.closed) return;
    this.registry.unregister(`mcp-${toKebab(conn.name)}`);
    conn.status = { ...conn.status, state: 'error', toolCount: 0, error: err.message };
    this.pushStatus();
    this.scheduleReconnect(conn);
  }

  /** 指数退避重连：1s → 2s → 4s … 上限 30s，超过次数放弃（等 UI 显式重试） */
  private scheduleReconnect(conn: Connection): void {
    if (conn.closed || conn.reconnectTimer) return;
    conn.reconnectAttempt += 1;
    if (conn.reconnectAttempt > MAX_RECONNECT_ATTEMPTS) return;
    const delay = Math.min(30_000, 1000 * 2 ** conn.reconnectAttempt);
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = undefined;
      if (conn.closed) return;
      void this.connectServer(conn.name, conn.config).catch(() => {});
    }, delay);
  }

  private pushState(name: string, state: McpServerStatus['state'], cfg: McpServerConfig, toolCount: number): void {
    this.pushEvent('mcp-status-changed', {
      servers: [
        {
          name,
          state,
          transport: cfg.url ? 'http' : 'stdio',
          toolCount,
        },
      ],
    });
  }

  private pushStatus(): void {
    this.pushEvent('mcp-status-changed', { servers: this.status() });
  }
}

// ---------- 校验与工具函数 ----------

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [k: string]: unknown };
}

interface McpCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
}

function validateServerConfig(name: string, cfg: McpServerConfig): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`MCP 服务器名只能包含字母、数字、- 和 _: ${name}`);
  }
  if (!cfg.command && !cfg.url) {
    throw new Error(`MCP 服务器 "${name}" 缺少 command（stdio）或 url（HTTP）`);
  }
  if (cfg.approval && !['auto', 'always', 'never'].includes(cfg.approval)) {
    throw new Error(`MCP 服务器 "${name}" 的 approval 只能是 auto / always / never`);
  }
}

function toKebab(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

/** stdio 子进程继承最小环境变量集，避免把父进程全部环境泄给 MCP server */
function processEnv(): Record<string, string> {
  const keep = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'PROGRAMFILES', 'NUMBER_OF_PROCESSORS'];
  const out: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
