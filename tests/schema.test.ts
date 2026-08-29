import { describe, expect, it } from 'vitest';
import { validateArguments } from '../src/core/schema.js';

describe('validateArguments', () => {
  it('无 schema 或空 schema = 不约束', () => {
    expect(validateArguments({ any: 'thing' }, undefined)).toBeNull();
    expect(validateArguments({ any: 'thing' }, {})).toBeNull();
  });

  it('合法参数通过', () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' }, n: { type: 'number' } },
      required: ['path'],
    };
    expect(validateArguments({ path: 'a.txt', n: 1 }, schema)).toBeNull();
  });

  it('缺必填字段 → 返回可读错误（非 null）', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
    const err = validateArguments({}, schema);
    expect(err).toBeTruthy();
    expect(err).toContain('required');
  });

  it('类型不符 → 返回错误', () => {
    const schema = { type: 'object', properties: { n: { type: 'number' } } };
    expect(validateArguments({ n: 'abc' }, schema)).toBeTruthy();
  });

  it('additionalProperties: false 拦截多余字段', () => {
    const schema = { type: 'object', properties: {}, additionalProperties: false };
    expect(validateArguments({ extra: 1 }, schema)).toBeTruthy();
  });

  it('schema 本身非法 → 返回描述性错误而不是抛异常', () => {
    const err = validateArguments({}, { type: 123 } as never);
    expect(err).toBeTruthy();
    expect(err).toContain('Schema');
  });
});
