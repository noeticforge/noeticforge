import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { LLMProvider, Permission } from '../../types.js';
import { createProvider, type ProviderConfig } from '../../providers/provider.js';
import { listProviderMetas } from '../../providers/registry.js';
import { APP_VERSION, PERMISSION_MODES, POLICY_PRESETS, err } from '../types.js';
import type { AppInfo, IpcResult, PermissionMode } from '../types.js';

export interface RuntimePolicy {
  provider: LLMProvider | null;
  maxIterations: number;
  contextTokenBudget: number;
  permissionMode: PermissionMode;
  allowedPermissions: Permission[] | undefined;
  forceApprovalPermissions: Permission[] | undefined;
  reasoningEffort: 'low' | 'medium' | 'high' | undefined;
  models: string[];
  currentModel: string | null;
  savedBaseUrl: string | null;
}

interface ModelPolicyOptions {
  appDir: string;
  initialProvider?: LLMProvider;
  maxIterations?: number;
  contextTokenBudget?: number;
  allowedPermissions?: Permission[];
  forceApprovalPermissions?: Permission[];
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
    let apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
    if (!apiKey) {
      const sameProvider = existing.provider === providerId;
      const existingKey = typeof existing.apiKey === 'string' ? existing.apiKey.trim() : '';
      if (sameProvider && existingKey) {
        apiKey = existingKey;
      } else {
        return err('E_INVALID_CONFIG', '缺少 apiKey', 'llm');
      }
    }
    const models = Array.isArray(cfg.models)
      ? (cfg.models as unknown[]).filter((m): m is string => typeof m === 'string' && !!m.trim()).map((m) => m.trim())
      : undefined;
    const model = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : models?.[0];
    try {
      this.provider = createProvider({
        provider: providerId,
        apiKey,
        model,
        baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : undefined,
        maxTokens: typeof cfg.maxTokens === 'number' ? cfg.maxTokens : undefined,
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
    if (typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim()) this.savedBaseUrl = cfg.baseUrl.trim();
    const persist = {
      ...existing,
      provider: providerId,
      apiKey,
      model,
      models: this.models.length ? this.models : undefined,
      baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : undefined,
      maxTokens: typeof cfg.maxTokens === 'number' ? cfg.maxTokens : undefined,
    };
    try {
      await writeFile(cfgPath, JSON.stringify(persist, null, 2), 'utf-8');
    } catch {
      // Persistence failure does not invalidate the in-memory provider.
    }
    return { ok: true, data: null };
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
    if (!this.explicitBudget && typeof cfg.contextTokenBudget === 'number' && cfg.contextTokenBudget > 0) {
      this.contextTokenBudget = cfg.contextTokenBudget;
    }
    if (typeof cfg.permissionMode === 'string' && PERMISSION_MODES.includes(cfg.permissionMode as PermissionMode)) {
      this.permissionMode = cfg.permissionMode as PermissionMode;
      this.applyPolicy();
    }
    if (!this.manualPolicy && typeof cfg.maxIterations === 'number' && cfg.maxIterations >= 1 && cfg.maxIterations <= 100) {
      this.maxIterations = cfg.maxIterations;
    }
    if (Array.isArray(cfg.models)) {
      this.models = (cfg.models as unknown[]).filter((m): m is string => typeof m === 'string' && !!m.trim());
    }
    if (typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim()) {
      this.savedBaseUrl = cfg.baseUrl.trim();
    }
    if (typeof cfg.model === 'string' && cfg.model.trim()) {
      this.currentModel = cfg.model.trim();
    }
    if (cfg.reasoningEffort === 'low' || cfg.reasoningEffort === 'medium' || cfg.reasoningEffort === 'high') {
      this.reasoningEffort = cfg.reasoningEffort;
    }
  }

  private applyPolicy(): void {
    if (this.manualPolicy) return;
    const preset = POLICY_PRESETS[this.permissionMode];
    this.allowedPermissions = preset.allowed;
    this.forceApprovalPermissions = preset.force.length ? preset.force : undefined;
  }
}
