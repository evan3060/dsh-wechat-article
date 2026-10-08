import { describe, expect, it, vi } from 'vitest';
import { createImagesGenerator } from '@/host/images';
import type { ImageRecord, SettingsRecord } from '@/host/domain';

/**
 * [2026-10-08] 配图提示词内容驱动。
 *
 * 缺陷：generate 只收 count 与 articleId，提示词是两句写死的固定句
 *（「为文章生成封面图：风格克制…深色纯色背景，无文字水印」/「正文配图 N：…」），
 * 完全不看文章写了什么。实测产出是几块大面积纯色——用户反馈「没有任何意义」。
 *
 * 契约已扩展：generate 增 title / digest / topics（topics 来自大纲小节）。
 */

const B64 = Buffer.from('x').toString('base64');

function settings(over: Partial<SettingsRecord> = {}): SettingsRecord {
  return {
    wechatAppId: '', wechatApiBaseUrl: 'https://api.weixin.qq.com', wechatAuthor: '',
    defaultTheme: 'professional-clean', defaultImageSize: '1024x1024', llmDefault: {},
    runHistoryLimit: 200, hotspotAggregatorUrl: '', agentToolsEnabled: false,
    imageProviders: [], ...over,
  } as SettingsRecord;
}

function harness() {
  const prompts: string[] = [];
  const persisted: ImageRecord[] = [];
  const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
    prompts.push(JSON.parse(String(init?.body)).prompt);
    return new Response(JSON.stringify({ data: [{ b64_json: B64 }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const gen = createImagesGenerator({
    getSettings: () => settings({
      imageProviders: [{ providerId: 'openai', credentialRef: 'WECHAT_ARTICLE_IMG_OPENAI' }],
    }),
    resolveCredential: async () => 'sk',
    now: () => new Date('2026-10-08T00:00:00Z'),
    persist: async (r) => { persisted.push(...r); },
    fetchImpl,
  });
  return { gen, prompts, persisted };
}

describe('配图提示词随文章内容变化', () => {
  it('封面提示词包含文章标题', async () => {
    const { gen, prompts } = harness();
    await gen.generate({ count: 0, title: '微信正文配图的正确做法', digest: '讲清占位替换与 CDN 上传' });
    expect(prompts[0]).toContain('微信正文配图的正确做法');
    expect(prompts[0]).toContain('讲清占位替换与 CDN 上传');
  });

  it('封面提示词要求图例与中文标签（不再是纯色背景）', async () => {
    const { gen, prompts } = harness();
    await gen.generate({ count: 0, title: '标题' });
    const p = prompts[0];
    expect(p).toMatch(/图例/);
    expect(p).toMatch(/中文/);
    expect(p).not.toMatch(/深色纯色背景/);
  });

  it('封面提示词要求 2.35:1 横向构图且主体避开上下边缘', async () => {
    const { gen, prompts } = harness();
    await gen.generate({ count: 0, title: '标题' });
    expect(prompts[0]).toMatch(/2\.35:1/);
  });

  it('正文配图按大纲小节逐张生成，互不重复', async () => {
    const { gen, prompts } = harness();
    await gen.generate({
      count: 2, title: '正文配图',
      topics: ['占位符与 CDN 上传流程', '不同压缩率的视觉对比'],
    });
    const bodies = prompts.slice(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('占位符与 CDN 上传流程');
    expect(bodies[1]).toContain('不同压缩率的视觉对比');
    expect(bodies[0]).not.toBe(bodies[1]);
  });

  it('无 topics 时回退到通用配图提示词（不崩）', async () => {
    const { gen, prompts } = harness();
    await gen.generate({ count: 1, title: '标题' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('第 1 张正文配图');
  });

  it('无 title 时有可用的兜底主题词', async () => {
    const { gen, prompts } = harness();
    await gen.generate({ count: 0 });
    expect(prompts[0]).toContain('微信公众号文章');
  });

  it('不同文章产出不同提示词（旧实现下两篇提示词完全相同）', async () => {
    const a = harness(); const b = harness();
    await a.gen.generate({ count: 0, title: '文章甲', digest: '主旨甲' });
    await b.gen.generate({ count: 0, title: '文章乙', digest: '主旨乙' });
    expect(a.prompts[0]).not.toBe(b.prompts[0]);
  });
});
