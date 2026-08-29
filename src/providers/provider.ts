import type { LLMProvider } from '../types.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';

export type ProviderId = 'deepseek' | 'openai' | 'anthropic';

export interface ProviderConfig {
  provider: ProviderId;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

/** 切换模型 = 改配置文件，代码零改动 */
export function createProvider(cfg: ProviderConfig): LLMProvider {
  if (!cfg.apiKey) {
    throw new Error(`provider "${cfg.provider}" 需要 apiKey，请在 config.json 中配置`);
  }
  switch (cfg.provider) {
    case 'deepseek':
      return new OpenAICompatibleProvider({
        id: 'deepseek',
        baseUrl: cfg.baseUrl ?? 'https://api.deepseek.com/v1',
        apiKey: cfg.apiKey,
        model: cfg.model ?? 'deepseek-chat',
      });
    case 'openai':
      return new OpenAICompatibleProvider({
        id: 'openai',
        baseUrl: cfg.baseUrl ?? 'https://api.openai.com/v1',
        apiKey: cfg.apiKey,
        model: cfg.model ?? 'gpt-4o-mini',
      });
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: cfg.apiKey,
        model: cfg.model ?? 'claude-sonnet-4-5',
        baseUrl: cfg.baseUrl,
      });
  }
}
