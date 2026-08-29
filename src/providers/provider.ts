import type { LLMProvider } from '../types.js';
import { createProviderFromRegistry, hasProvider } from './registry.js';

/**
 * Provider 配置 → LLMProvider。v0.2 起实际实现委托给注册表（providers/registry.ts），
 * 本文件保留为兼容入口与配置类型定义。接新厂商 = registerProviderFactory 一行，代码零改动。
 */

export interface ProviderConfig {
  /** 注册表中的 provider id（openai-compatible / deepseek / openai / anthropic / 自注册） */
  provider: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Anthropic Messages API 的 max_tokens（缺省 8192） */
  maxTokens?: number;
}

/** 切换模型 = 改配置文件，代码零改动 */
export function createProvider(cfg: ProviderConfig): LLMProvider {
  if (!cfg.apiKey) {
    throw new Error(`provider "${cfg.provider}" 需要 apiKey，请在 config.json 中配置`);
  }
  if (!hasProvider(cfg.provider)) {
    throw new Error(`不支持的 provider: ${cfg.provider}，请在 config.json 中改用已注册的 provider id`);
  }
  return createProviderFromRegistry(cfg);
}
