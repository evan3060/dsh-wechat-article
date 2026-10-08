import { describe, expect, it } from 'vitest';
import { sanitizeUrl } from '@/render/sanitize';
import { convertArticle } from '@/render/convert';

/**
 * [2026-10-08] data: 协议放行（图片类）。
 *
 * 背景：正文配图占位替换（host/pipeline/image-placeholders.ts）把 `![alt](图片待生成)`
 * 换成本地 data URI 供写作台预览；未放行 data: 时 sanitizeUrl 直接丢 src，
 * 预览与推送正文里一张图都没有（实测 <img> 数量 = 0，alt 文本仍在）。
 *
 * 安全边界：只放行 **image + base64**，data:text/html、data:image/svg+xml
 * （可内嵌脚本）一律拒绝——否则等于开了个 XSS 口子。
 */

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('sanitizeUrl：data: 图片放行', () => {
  it('放行常见图片 data URI（含 base64 里的 + / =）', () => {
    for (const mime of ['png', 'jpeg', 'jpg', 'gif', 'webp', 'bmp']) {
      expect(sanitizeUrl(`data:image/${mime};base64,AAAA+/=`), mime).not.toBeNull();
    }
  });

  it('拒绝非图片 data URI（防 XSS）', () => {
    expect(sanitizeUrl('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==')).toBeNull();
    expect(sanitizeUrl('data:application/javascript;base64,YWxlcnQoMSk=')).toBeNull();
  });

  it('拒绝 svg（可内嵌脚本）', () => {
    expect(sanitizeUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBeNull();
  });

  it('拒绝 data: 但载荷非 base64', () => {
    expect(sanitizeUrl('data:image/png,rawbytes')).toBeNull();
  });

  it('既有协议行为不回归', () => {
    expect(sanitizeUrl('https://mmbiz.qpic.cn/a.png')).not.toBeNull();
    expect(sanitizeUrl('http://example.com/a.png')).not.toBeNull();
    expect(sanitizeUrl('mailto:a@b.com')).not.toBeNull();
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('convertArticle：data URI 图片能渲染成 <img>', () => {
  it('含 data URI 的 markdown 渲染出 <img src="data:image/...">', () => {
    const md = `![示意图](${PNG})\n\n正文文字。`;
    const html = convertArticle({ markdown: md, theme: 'professional-clean' });
    expect(html).toContain('<img');
    expect(html).toContain('data:image/png;base64,');
  });

  it('非图片 data URI 仍被丢弃但保留 alt 文本', () => {
    const md = '![危险](data:text/html;base64,PHNjcmlwdD4=)';
    const html = convertArticle({ markdown: md, theme: 'professional-clean' });
    expect(html).not.toContain('<img');
    expect(html).toContain('危险');
  });
});
