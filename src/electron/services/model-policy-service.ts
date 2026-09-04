import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { LLMProvider, Permission } from '../../types.js';
import { createProvider, type ProviderConfig } from '../../providers/provider.js';
import { listProviderMetas } from '../../providers/registry.js';
import { APP_VERSION, PERMISSION_MODES, POLICY_PRESETS, err } from '../types.js';
import type { AppInfo, IpcResult, PermissionMode } from '../types.js';

export interface RuntimePolicy {
  provider: LLMProvider | null; maxIterations: number; contextTokenBudget: number;
  permissionMode: PermissionMode; allowedPermissions?: Permission[]; forceApprovalPermissions?: Permission[];
  reasoningEffort?: 'low' | 'medium' | 'high'; models: string[]; currentModel: string | null; savedBaseUrl: string | null;
}

interface ModelPolicyOptions {
  appDir: string; initialProvider?: LLMProvider; maxIterations?: number;
  contextTokenBudget?: number; allowedPermissions?: Permission[]; forceApprovalPermissions?: Permission[];
}

/**
 * Model + policy state: provider lifecycle, config.json persistence and
 * permission preset dispatch.
 */
export class ModelPolicyService {
  private readonly appDir: string;
  private provider: LLMProvider | null;
  private maxIterations: number;
  private contextTokenBudget: number;
  private readonly explicitBudget: boolean;
  private permissionMode: PermissionMode = 'full';
  private readonly manualPolicy: boolean;
  private allowedPermissions: Permission[] | undefined;
  private forceApprovalPermissions: Permission[] | undefined;
  private models: string[] = [];
  private currentModel: string | null = null;
  private savedBaseUrl: string | null = null;
  private reasoningEffort: 'low' | 'medium' | 'high' | undefined;

  constructor(opts: ModelPolicyOptions) {
    this.appDir = opts.appDir;
    this.provider = opts.initialProvider ?? null;
    this.maxIterations = opts.maxIterations ?? 15;
    this.explicitBudget = typeof opts.contextTokenBudget === 'number';
    this.contextTokenBudget = opts.contextTokenBudget ?? 24_000;
    this.manualPolicy = opts.allowedPermissions !== undefined || opts.forceApprovalPermissions !== undefined;
    this.allowedPermissions = opts.allowedPermissions;
    this.forceApprovalPermissions = opts.forceApprovalPermissions;
    this.applyPolicy();
  }

  async loadConfig(): Promise<void> {
    const cfgPath = path.join(this.appDir, 'config.json');
    if (!existsSync(cfgPath)) return;
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(await readFile(cfgPath, 'utf-8'));
    } catch {
      cfg = {};
    }
    if (!this.provider) {
      try {
        this.provider = createProvider(cfg as unknown as ProviderConfig);
      } catch {
        // Incomplete config is treated as "not configured".
      }
    }
    this.applyConfig(cfg);
  }

  getRuntimeState(): RuntimePolicy {
    return {
      provider: this.provider,
      maxIterations: this.maxIterations,
      contextTokenBudget: this.contextTokenBudget,
      permissionMode: this.permissionMode,
      allowedPermissions: this.allowedPermissions,
      forceApprovalPermissions: this.forceApprovalPermissions,
      reasoningEffort: this.reasoningEffort,
      models: this.models,
      currentModel: this.currentModel,
      savedBaseUrl: this.savedBaseUrl,
    };
  }

  listProviders(): IpcResult<{ providers: ReturnType<typeof listProviderMetas> }> {
    return { ok: true, data: { providers: listProviderMetas() } };
  }

  async setModelConfig(req: { config: Record<string, unknown> }): Promise<IpcResult<null>> {
    const cfg = req?.config;
    const providerId = cfg?.provider;
    if (typeof providerId !== 'string' || !listProviderMetas().some((p) => p.id === providerId)) {
      return err('E_PROVIDER_UNSUPPORTED', `不支持的 provider: ${providerId}`, 'llm');
    }
    const cfgPath = path.join(this.appDir, 'config.json');
    let existing: Record<string, unknown> = {};
    if (existsSync(cfgPath)) {
      try {
        existing = JSON.parse(await readFile(cfgPath, 'utf-8'));
      } catch {
        existing = {};
      }
    }
    const sameProvider = existing.provider === providerId;
    let apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
    if (!apiKey) {
      const existingKey = typeof existing.apiKey === 'string' ? existing.apiKey.trim() : '';
      if (sameProvider && existingKey) {
        apiKey = existingKey;
      } else {
        return err('E_INVALID_CONFIG', '缺少 apiKey', 'llm');
      }
    }
    // 继承已有 baseUrl / maxTokens，防止切换模型时清空配置或报错
    let baseUrl = typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim() ? cfg.baseUrl.trim() : undefined;
    if (!baseUrl && sameProvider && typeof existing.baseUrl === 'string' && existing.baseUrl.trim()) {
      baseUrl = existing.baseUrl.trim();
    }
    if (!baseUrl && this.savedBaseUrl) baseUrl = this.savedBaseUrl;
    const maxTokens = typeof cfg.maxTokens === 'number' ? cfg.maxTokens : (sameProvider && typeof existing.maxTokens === 'number' ? existing.maxTokens : undefined);
    const models = Array.isArray(cfg.models)
      ? (cfg.models as unknown[]).filter((m): m is string => typeof m === 'string' && !!m.trim()).map((m) => m.trim())
      : undefined;
    const model = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : models?.[0];
    try {
      this.provider = createProvider({
        provider: providerId,
        apiKey,
        model,
        baseUrl,
        maxTokens,
        enableReasoningEffort: true,
      });
    } catch (e) {
      return err('E_INVALID_CONFIG', `配置无效: ${e instanceof Error ? e.message : String(e)}`, 'llm');
    }
    if (models) {
      this.models = models;
    } else if (model && !this.models.includes(model)) {
      this.models = [...(this.models.length ? this.models : []), model].slice(-8);
    } else if (model) {
      this.models = [model, ...this.models.filter((m) => m !== model)];
    }
    if (model) this.currentModel = model;
    if (baseUrl) this.savedBaseUrl = baseUrl;
    const persist = {
      ...existing,
      provider: providerId,
      apiKey,
      model,
      models: this.models.length ? this.models : undefined,
      baseUrl,
      maxTokens,
      enableReasoningEffort: true,
    };
    try {
      await writeFile(cfgPath, JSON.stringify(persist, null, 2), 'utf-8');
    } catch {
      // Persistence failure does not invalidate the in-memory provider.
    }
    return { ok: true, data: null };
  }

  async fetchRemoteModels(req?: { provider?: string; apiKey?: string; baseUrl?: string }): Promise<IpcResult<{ models: string[] }>> {
    const providerId = (req?.provider as string) || this.provider?.id || 'openai-compatible';
    let apiKey = typeof req?.apiKey === 'string' ? req.apiKey.trim() : '';
    let baseUrl = (typeof req?.baseUrl === 'string' ? req.baseUrl.trim() : '') || this.savedBaseUrl || '';
    if (!apiKey || !baseUrl) {
      const cfgPath = path.join(this.appDir, 'config.json');
      if (existsSync(cfgPath)) {
        try {
          const cfg = JSON.parse(await readFile(cfgPath, 'utf-8'));
          if (!apiKey && typeof cfg.apiKey === 'string') apiKey = cfg.apiKey.trim();
          if (!baseUrl && typeof cfg.baseUrl === 'string') baseUrl = cfg.baseUrl.trim();
        } catch {}
      }
    }
    if (providerId === 'anthropic') {
      return { ok: true, data: { models: ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'] } };
    }
    if (!baseUrl) {
      if (providerId === 'deepseek') baseUrl = 'https://api.deepseek.com/v1';
      else if (providerId === 'openai') baseUrl = 'https://api.openai.com/v1';
      else return err('E_INVALID_CONFIG', '缺少 Base URL，无法拉取模型列表', 'llm');
    }
    const clean = baseUrl.replace(/\/+$/, '');
    const url = clean.endsWith('/v1') ? `${clean}/models` : `${clean}/v1/models`;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return err('E_LLM_ERROR', `拉取失败 (${res.status}): ${txt.slice(0, 100)}`, 'llm');
      }
      const json = (await res.json()) as { data?: Array<{ id?: string }> } | Array<{ id?: string }>;
      const raw = Array.isArray(json) ? json : json.data;
      const list = Array.isArray(raw) ? raw.map((m) => m?.id?.trim()).filter((id): id is string => Boolean(id)) : [];
      if (!list.length) return err('E_LLM_ERROR', '端点未返回有效的模型列表', 'llm');
      return { ok: true, data: { models: [...new Set(list)].sort() } };
    } catch (e) {
      return err('E_LLM_ERROR', `连接失败: ${e instanceof Error ? e.message : String(e)}`, 'llm');
    }
  }

  async setAgentPolicy(req: {
    permissionMode?: PermissionMode;
    maxIterations?: number;
    reasoningEffort?: 'low' | 'medium' | 'high';
  }): Promise<IpcResult<null>> {
    const mode = req?.permissionMode;
    if (mode !== undefined) {
      if (!PERMISSION_MODES.includes(mode)) {
        return err('E_INVALID_CONFIG', `未知权限模式: ${mode}`, 'unknown');
      }
      this.permissionMode = mode;
      this.applyPolicy();
    }
    const iters = req?.maxIterations;
    if (iters !== undefined) {
      if (typeof iters !== 'number' || iters < 1 || iters > 100 || !Number.isInteger(iters)) {
        return err('E_INVALID_CONFIG', 'maxIterations 必须是 1-100 的整数', 'unknown');
      }
      if (!this.manualPolicy) this.maxIterations = iters;
    }
    const effort = req?.reasoningEffort;
    if (effort !== undefined) {
      if (effort !== 'low' && effort !== 'medium' && effort !== 'high') {
        return err('E_INVALID_CONFIG', 'reasoningEffort 只能是 low / medium / high', 'unknown');
      }
      this.reasoningEffort = effort;
    }
    const cfgPath = path.join(this.appDir, 'config.json');
    let existing: Record<string, unknown> = {};
    if (existsSync(cfgPath)) {
      try {
        existing = JSON.parse(await readFile(cfgPath, 'utf-8'));
      } catch {
        existing = {};
      }
    }
    try {
      await writeFile(cfgPath, JSON.stringify({
        ...existing,
        permissionMode: this.permissionMode,
        maxIterations: this.manualPolicy ? existing.maxIterations : this.maxIterations,
        reasoningEffort: this.reasoningEffort,
      }, null, 2), 'utf-8');
    } catch {
      // Persistence failure does not affect the current run.
    }
    return { ok: true, data: null };
  }

  getAppInfo(appDir: string, sessionCount: number, pluginCount: number, mcpCount: number): IpcResult<{ info: AppInfo }> {
    const info: AppInfo = {
      version: APP_VERSION,
      appDir,
      provider: this.provider?.id ?? null,
      model: this.currentModel ?? this.models[0] ?? null,
      models: [...this.models],
      baseUrl: this.savedBaseUrl,
      permissionMode: this.permissionMode,
      maxIterations: this.maxIterations,
      reasoningEffort: this.reasoningEffort,
      sessionCount,
      pluginCount,
      mcpCount,
    };
    return { ok: true, data: { info } };
  }

  private applyConfig(cfg: Record<string, unknown>): void {
    if (!this.explicitBudget && typeof cfg.contextTokenBudget === 'number' && cfg.contextTokenBudget > 0) this.contextTokenBudget = cfg.contextTokenBudget;
    if (typeof cfg.permissionMode === 'string' && PERMISSION_MODES.includes(cfg.permissionMode as PermissionMode)) {
      this.permissionMode = cfg.permissionMode as PermissionMode; this.applyPolicy();
    }
    if (!this.manualPolicy && typeof cfg.maxIterations === 'number' && cfg.maxIterations >= 1 && cfg.maxIterations <= 100) this.maxIterations = cfg.maxIterations;
    if (Array.isArray(cfg.models)) this.models = (cfg.models as unknown[]).filter((m): m is string => typeof m === 'string' && !!m.trim());
    if (typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim()) this.savedBaseUrl = cfg.baseUrl.trim();
    if (typeof cfg.model === 'string' && cfg.model.trim()) this.currentModel = cfg.model.trim();
    if (cfg.reasoningEffort === 'low' || cfg.reasoningEffort === 'medium' || cfg.reasoningEffort === 'high') this.reasoningEffort = cfg.reasoningEffort;
  }

  private applyPolicy(): void {
    if (this.manualPolicy) return;
    const preset = POLICY_PRESETS[this.permissionMode];
    this.allowedPermissions = preset.allowed;
    this.forceApprovalPermissions = preset.force.length ? preset.force : undefined;
  }
}
