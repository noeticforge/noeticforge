import { describe, expect, it } from 'vitest';
import { contentToText, isMessageContent } from '../src/types.js';

describe('contentToText', () => {
  it('字符串原样返回', () => {
    expect(contentToText('hi')).toBe('hi');
  });
  it('分片拼接文本，图片输出占位符', () => {
    expect(
      contentToText([
        { type: 'text', text: 'a' },
        { type: 'image', mediaType: 'image/png', data: 'xx' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\n[图片 image/png]\nb');
  });
});

describe('isMessageContent', () => {
  it('任意字符串（含空串）都是合法内容', () => {
    expect(isMessageContent('hi')).toBe(true);
    expect(isMessageContent('')).toBe(true);
  });
  it('非空分片数组合法：文本与图片', () => {
    expect(isMessageContent([{ type: 'text', text: 'x' }])).toBe(true);
    expect(isMessageContent([{ type: 'image', mediaType: 'image/png', data: 'aa' }])).toBe(true);
  });
  it('非法结构拒绝', () => {
    expect(isMessageContent([])).toBe(false);
    expect(isMessageContent([{ type: 'text' }])).toBe(false);
    expect(isMessageContent([{ type: 'image', mediaType: 'image/png' }])).toBe(false);
    expect(isMessageContent([{ type: 'unknown', text: 'x' }])).toBe(false);
    expect(isMessageContent({ type: 'text', text: 'x' })).toBe(false);
    expect(isMessageContent(null)).toBe(false);
    expect(isMessageContent(42)).toBe(false);
  });
});
