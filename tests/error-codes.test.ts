import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../src/shared/error-codes.js';

describe('错误码单一事实源', () => {
  it('每个错误码都有非空中文文案', () => {
    for (const [code, text] of Object.entries(ERROR_CODES)) {
      expect(code).toMatch(/^E_[A-Z0-9_]+$/);
      expect(text.trim().length).toBeGreaterThan(4);
    }
  });

  it('覆盖循环 / 配置 / 会话 / 插件 / MCP 全部域', () => {
    const codes = Object.keys(ERROR_CODES);
    for (const must of [
      'E_INVALID_MESSAGE', 'E_LLM_ERROR', 'E_MAX_ITERATIONS', 'E_INTERNAL',
      'E_PROVIDER_NOT_CONFIGURED', 'E_INVALID_CONFIG',
      'E_SESSION_NOT_FOUND', 'E_SESSION_IN_USE',
      'E_PLUGIN_LOAD_FAILED', 'E_PLUGIN_BUILTIN', 'E_CHECKSUM_MISMATCH',
      'E_MCP_NOT_FOUND',
    ]) {
      expect(codes).toContain(must);
    }
  });
});
