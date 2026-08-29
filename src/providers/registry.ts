import type { LLMProvider } from '../types.js';
import type { ProviderConfig } from './provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';

/**
 * Provider 注册表（v0.2）：「换模型」从硬编码 switch 变成注册制，
 * 与工具注册表同一哲学——底座不认识任何具体厂商，只认识注册表。
 *
 * 内置四个 id：
 *   - openai-compatible  通用预设（必填 baseUrl）：Ollama / LM Studio / 智谱 / 通义 / 月之暗面… 即插
 *   - deepseek / openai  openai-compatible 的预设值（baseUrl/model 有默认）
 *   - anthropic          独立 Messages API
 */

export interface ProviderMeta {
  id: string;
  /** UI 展示名 */
  label: string;
  /** 是否必须提供 baseUrl（通用 OpenAI 兼容预设为 true） */
  requiresBaseUrl: boolean;
  defaultBaseUrl?: string;
  defaultModel?: string;
}

type ProviderFactory = (cfg: ProviderConfig) => LLMProvider;

const factories = new Map<string, ProviderFactory>();
const metas = new Map<string, ProviderMeta>();

function openaiCompatible(cfg: ProviderConfig, fallbacks: { baseUrl: string; model: string }): LLMProvider {
  return new OpenAICompatibleProvider({
    id: cfg.provider,
    baseUrl: cfg.baseUrl ?? fallbacks.baseUrl,
    apiKey: cfg.apiKey!,
    model: cfg.model ?? fallbacks.model,
    // reasoning_effort 透传默认关闭：严格网关会对未知字段报 400，需在 config.json 显式开启
    enableReasoningEffort: cfg.enableReasoningEffort === true,
  });
}

function register(id: string, meta: ProviderMeta, factory: ProviderFactory): void {
  factories.set(id, factory);
  metas.set(id, meta);
}

register(
  'openai-compatible',
  { id: 'openai-compatible', label: 'OpenAI 兼容（自定义 baseUrl）', requiresBaseUrl: true },
  (cfg) => {
    if (!cfg.baseUrl) {
      throw new Error('provider "openai-compatible" 需要配置 baseUrl（例如 http://127.0.0.1:11434/v1）');
    }
    return openaiCompatible(cfg, { baseUrl: cfg.baseUrl, model: cfg.model ?? 'default' });
  },
);

register(
  'deepseek',
  { id: 'deepseek', label: 'DeepSeek', requiresBaseUrl: false, defaultBaseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  (cfg) => openaiCompatible(cfg, { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }),
);

register(
  'openai',
  { id: 'openai', label: 'OpenAI', requiresBaseUrl: false, defaultBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  (cfg) => openaiCompatible(cfg, { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }),
);

register(
  'anthropic',
  { id: 'anthropic', label: 'Anthropic', requiresBaseUrl: false, defaultBaseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-5' },
  (cfg) => new AnthropicProvider({
    apiKey: cfg.apiKey!,
    model: cfg.model ?? 'claude-sonnet-4-5',
    baseUrl: cfg.baseUrl,
    maxTokens: cfg.maxTokens,
  }),
);

register(
  'anthropic-compatible',
  { id: 'anthropic-compatible', label: 'Anthropic 兼容（自定义 baseUrl）', requiresBaseUrl: true },
  (cfg) => {
    if (!cfg.baseUrl) {
      throw new Error('provider "anthropic-compatible" 需要配置 baseUrl（例如自建 Anthropic 格式网关）');
    }
    return new AnthropicProvider({
      apiKey: cfg.apiKey!,
      model: cfg.model ?? 'default',
      baseUrl: cfg.baseUrl,
      maxTokens: cfg.maxTokens,
    });
  },
);

export function registerProviderFactory(id: string, meta: ProviderMeta, factory: ProviderFactory): void {
  if (factories.has(id)) {
    throw new Error(`Provider 重复注册: ${id}`);
  }
  register(id, meta, factory);
}

export function listProviderMetas(): ProviderMeta[] {
  return [...metas.values()];
}

/** 未知 provider 抛错；apiKey 缺失由 createProvider 统一校验 */
export function createProviderFromRegistry(cfg: ProviderConfig): LLMProvider {
  const factory = factories.get(cfg.provider);
  if (!factory) {
    throw new Error(`不支持的 provider: ${cfg.provider}（可用: ${[...factories.keys()].join(', ')}）`);
  }
  return factory(cfg);
}

export function hasProvider(id: string): boolean {
  return factories.has(id);
}
