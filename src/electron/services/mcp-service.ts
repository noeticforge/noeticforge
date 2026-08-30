import { McpManager, type McpServerConfig, type McpServerStatus } from '../../mcp/manager.js';
import type { ToolRegistry } from '../../core/registry.js';
import { err } from '../types.js';
import type { IpcResult, PushChannel } from '../types.js';

/**
 * MCP 服务管理（协议 §3.16-3.18）：封装 McpManager 的配置持久化、
 * 服务器启停与状态查询，把「mcp-status-changed」推送回调收敛到门面。
 */
export class McpService {
  private readonly manager: McpManager;

  constructor(
    registry: ToolRegistry,
    pushEvent: (channel: PushChannel, payload: unknown) => void,
    appDir: string,
  ) {
    this.manager = new McpManager(registry, (channel, payload) => {
      pushEvent(channel as PushChannel, payload);
    }, appDir);
  }

  /** 启动加载：读 mcp.json → 逐个后台连接（不阻塞门面 init） */
  async init(): Promise<void> {
    await this.manager.init();
  }

  /** 进程退出前调用：断开全部 MCP server */
  async shutdown(): Promise<void> {
    await this.manager.shutdown();
  }

  status(): McpServerStatus[] {
    return this.manager.status();
  }

  /** §3.16 list-mcp-servers */
  async listMcpServers(): Promise<IpcResult<{ servers: McpServerStatus[]; config: Record<string, McpServerConfig> }>> {
    let config: Record<string, McpServerConfig> = {};
    try {
      config = await this.manager.readConfig();
    } catch {
      config = {};
    }
    return { ok: true, data: { servers: this.manager.status(), config } };
  }

  /** §3.17 set-mcp-config：全量替换 mcp.json 并重连 */
  async setMcpConfig(req: { config: Record<string, McpServerConfig> }): Promise<IpcResult<null>> {
    try {
      await this.manager.setConfig(req?.config ?? {});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = (e as Error & { code?: string }).code === 'E_MCP_NOT_FOUND' ? 'E_MCP_NOT_FOUND' : 'E_INVALID_CONFIG';
      return err(code, message, 'unknown');
    }
    return { ok: true, data: null };
  }

  /** §3.18 toggle-mcp-server */
  async toggleMcpServer(req: { name: string; enabled: boolean }): Promise<IpcResult<null>> {
    try {
      await this.manager.toggleServer(req?.name, !!req?.enabled);
    } catch (e) {
      const code = (e as Error & { code?: string }).code === 'E_MCP_NOT_FOUND' ? 'E_MCP_NOT_FOUND' : 'E_INVALID_CONFIG';
      return err(code, e instanceof Error ? e.message : String(e), 'unknown');
    }
    return { ok: true, data: null };
  }
}
