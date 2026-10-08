import { describe, expect, it } from 'vitest';
import {
  IMAGE_PLACEHOLDER,
  countImagePlaceholders,
  isInlineImageDataUri,
  replaceImagePlaceholders,
} from '@/host/pipeline/image-placeholders';

/**
 * [2026-10-08] 正文配图占位替换。
 *
 * 缺陷背景（实测因果链，详见 src/host/pipeline/image-placeholders.ts 头注释）：
 *   llm.ts:185 的 draft 提示词要求 LLM 写 `![alt](图片待生成)` 占位并声明
 *   「后续管线会替换」，但全仓 grep「图片待生成」只命中这一处 —— 替换从未实现。
 *   实测推送到微信的 content 里 `<img>` 数量 = 0，正文一张图都没有。
 */

const IMG_A = { mime: 'image/png', base64: 'AAAA' };
const IMG_B = { mime: 'image/jpeg', base64: 'BBBB' };

describe('占位符识别', () => {
  it('计数 LLM 约定的占位符', () => {
    const md = `![a](${IMAGE_PLACEHOLDER})\n\n正文\n\n![b](${IMAGE_PLACEHOLDER})`;
    expect(countImagePlaceholders(md)).toBe(2);
  });

  it('无占位符时为 0', () => {
    expect(countImagePlaceholders('纯文字，无图')).toBe(0);
  });

  it('不误伤真实图片链接（只认占位符本身）', () => {
    const md = '![真图](https://example.com/a.png)';
    expect(countImagePlaceholders(md)).toBe(0);
    const out = replaceImagePlaceholders(md, [IMG_A]);
    expect(out).toBe(md);
  });

  it('alt 为空也能识别', () => {
    expect(countImagePlaceholders(`![](${IMAGE_PLACEHOLDER})`)).toBe(1);
  });
});

describe('替换行为', () => {
  it('按顺序把占位符换成 data URI，保留 alt', () => {
    const md = `![封面图](${IMAGE_PLACEHOLDER})\n\n文字\n\n![正文图](${IMAGE_PLACEHOLDER})`;
    const out = replaceImagePlaceholders(md, [IMG_A, IMG_B]);
    expect(out).toContain('![封面图](data:image/png;base64,AAAA)');
    expect(out).toContain('![正文图](data:image/jpeg;base64,BBBB)');
    expect(countImagePlaceholders(out)).toBe(0);
  });

  it('图片不足时多余占位符保持原样（不丢内容，alt 仍在）', () => {
    const md = `![a](${IMAGE_PLACEHOLDER})\n![b](${IMAGE_PLACEHOLDER})\n![c](${IMAGE_PLACEHOLDER})`;
    const out = replaceImagePlaceholders(md, [IMG_A]);
    expect(out).toContain('![a](data:image/png;base64,AAAA)');
    // b/c 没有对应图片 → 原样保留
    expect(countImagePlaceholders(out)).toBe(2);
  });

  it('无图片时原样返回', () => {
    const md = `![a](${IMAGE_PLACEHOLDER})`;
    expect(replaceImagePlaceholders(md, [])).toBe(md);
  });

  it('替换后的 data URI 能过 sanitize 的 URL 安全正则（否则渲染层会丢 src）', () => {
    const out = replaceImagePlaceholders(`![a](${IMAGE_PLACEHOLDER})`, [IMG_A]);
    const src = out.match(/src="([^"]+)"|\((data:[^)]+)\)/)?.[1] ?? out.slice(out.indexOf('(') + 1);
    // 与 src/render/sanitize.ts 的 URL_SAFE_CHARS 同款：纯 ASCII 安全字符集
    const SAFE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
    expect(SAFE.test(src)).toBe(true);
  });
});

describe('data URI 复检', () => {
  it('接受图片类 data URI', () => {
    expect(isInlineImageDataUri('data:image/png;base64,AAAA')).toBe(true);
    expect(isInlineImageDataUri('data:image/jpeg;base64,AAAA')).toBe(true);
    expect(isInlineImageDataUri('data:image/webp;base64,AAAA')).toBe(true);
  });

  it('拒绝非图片或空载荷', () => {
    expect(isInlineImageDataUri('data:text/plain;base64,AAAA')).toBe(false);
    expect(isInlineImageDataUri('data:image/png;base64,')).toBe(false);
    expect(isInlineImageDataUri('https://example.com/a.png')).toBe(false);
  });
});

describe('回归：占位符的 URL-encode 陷阱', () => {
  it('占位符是中文，经 marked 会变成 %E5%… 形式——本模块直接匹配中文原串', () => {
    // 说明：marked 会把 图片待生成 URL-encode 成 %E5%9B%BE%E7%89%87%E5%BE%85%E7%94%9F%E6%88%90，
    // 若将来改为在 HTML 层替换，必须改成匹配 encode 后形态，否则会漏。
    const md = `![x](${IMAGE_PLACEHOLDER})`;
    expect(replaceImagePlaceholders(md, [IMG_A])).not.toContain(IMAGE_PLACEHOLDER);
  });
});