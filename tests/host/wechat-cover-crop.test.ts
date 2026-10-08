import { describe, expect, it, vi } from 'vitest';
import { createWeChatClient } from '@/host/wechat/client';

/**
 * [2026-10-08] 封面双比例裁剪（cover_info.crop_percent_list）。
 *
 * 需求：封面在两处展示比例不同——消息列表 2.35:1，转发卡片与公众号主页 1:1。
 * 官方 draft/add 契约：cover_info.crop_percent_list 以图片左上 (0,0)、
 * 右下 (1,1) 建坐标系，x1/y1/x2/y2 是比例值字符串；news 仅支持 "2.35_1"/"1_1"。
 * 不传时微信自行裁剪，两个比例共用同一构图。
 */

interface DraftBody { articles: Array<Record<string, never>> }

interface CropEntry { ratio: string; x1: string; y1: string; x2: string; y2: string }

/** 从 draft/add 请求体里取 cover_info.crop_percent_list（带断言，缺字段即测试失败）。 */
function cropList(article: Record<string, never>): CropEntry[] {
  const info = article.cover_info as { crop_percent_list?: CropEntry[] } | undefined;
  if (!info?.crop_percent_list) throw new Error('请求体缺 cover_info.crop_percent_list');
  return info.crop_percent_list;
}

/** 抓 draft/add 的请求体。 */
function captureDraftBody() {
  const calls: Array<{ articles: Array<Record<string, never>> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes('/cgi-bin/draft/add')) {
      calls.push(JSON.parse(String(init?.body)) as unknown as DraftBody);
      return new Response(JSON.stringify({ media_id: 'M1' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).includes('/cgi-bin/token')) {
      return new Response(JSON.stringify({ access_token: 'T', expires_in: 7200 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    // 永久素材上传（封面 thumb_media_id 的来源）
    if (String(url).includes('/cgi-bin/material/add_material')) {
      return new Response(JSON.stringify({ media_id: 'THUMB1', url: 'https://mmbiz.qpic.cn/t/1' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const client = createWeChatClient({
    fetchImpl,
    now: () => Date.now(),
    getSettings: () => ({ apiBaseUrl: 'https://api.weixin.qq.com', author: '作者' }),
    getCredentials: () => ({ appId: 'wx_test', secret: 'secret' }),
  } as never);

  return { client, calls, fetchImpl };
}

const BASE_INPUT = {
  title: '标题',
  digest: '摘要',
  contentHtml: '<p>正文</p>',
  thumbImage: { buffer: Buffer.from('x'), mime: 'image/png' },
  contentImages: [],
  ...{},
};

describe('封面双比例裁剪', () => {
  it('draft/add 带 cover_info.crop_percent_list，含 2.35_1 与 1_1 两个 ratio', async () => {
    const { client, calls } = captureDraftBody();
    await client.pushDraft(BASE_INPUT as never);
    expect(calls).toHaveLength(1);
    const art = calls[0].articles[0];
    expect(art.cover_info, '缺 cover_info 时微信用默认裁剪，两比例共用构图').toBeDefined();
    const ratios = cropList(art).map((c) => c.ratio);
    expect(ratios).toContain('2.35_1');
    expect(ratios).toContain('1_1');
  });

  it('2.35_1 取满宽、居中，高度 = 1/2.35', async () => {
    const { client, calls } = captureDraftBody();
    await client.pushDraft(BASE_INPUT as never);
    const c = cropList(calls[0].articles[0]).find((x) => x.ratio === '2.35_1')!;
    expect(c.x1).toBe('0');
    expect(c.x2).toBe('1');
    const h = Number(c.y2) - Number(c.y1);
    expect(h).toBeCloseTo(1 / 2.35, 3);
    // 垂直居中
    expect(Number(c.y1)).toBeCloseTo(Number(c.y2) + Number(c.y1) ? (1 - h) / 2 : 0, 3);
  });

  it('1_1 取整幅（x,y 均 0→1）', async () => {
    const { client, calls } = captureDraftBody();
    await client.pushDraft(BASE_INPUT as never);
    const c = cropList(calls[0].articles[0]).find((x) => x.ratio === '1_1')!;
    expect([c.x1, c.y1, c.x2, c.y2]).toEqual(['0', '0', '1', '1']);
  });

  it('坐标是字符串（官方契约要求比例值字符串，非数字）', async () => {
    const { client, calls } = captureDraftBody();
    await client.pushDraft(BASE_INPUT as never);
    for (const c of cropList(calls[0].articles[0])) {
      for (const value of [c.x1, c.y1, c.x2, c.y2]) {
        expect(typeof value, `${c.ratio} 坐标应为字符串`).toBe('string');
      }
    }
  });

  it('既有字段不回归：thumb_media_id / content / title 仍在', async () => {
    const { client, calls } = captureDraftBody();
    await client.pushDraft(BASE_INPUT as never);
    const art = calls[0].articles[0];
    expect(art.thumb_media_id).toBeTruthy();
    expect(art.content).toBe('<p>正文</p>');
    expect(art.title).toBe('标题');
  });
});
