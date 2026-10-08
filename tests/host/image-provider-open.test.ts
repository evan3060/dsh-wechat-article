import { describe, expect, it, vi } from 'vitest';
import { ImageProviderConfigSchema } from '@/shared/schema-base';
import {
  BUILTIN_IMAGE_PROVIDER_IDS,
  CREDENTIAL_REFS,
  isBuiltinImageProviderId,
  type ImageProviderId,
} from '@/shared/image-provider-ids';
import { createImagesGenerator } from '@/host/images';
import { createCustomProvider } from '@/host/providers/custom-openai';
import type { ImageRecord, SettingsRecord } from '@/host/domain';

/**
 * [2026-10-08] 解除 providerId 硬编码的回归测试。
 *
 * 背景：此前 ImageProviderConfigSchema.providerId 是 `z.enum(IMAGE_PROVIDER_IDS)`
 * （封闭 9 家），且 images.ts 装配时 `.filter(entry => IMAGE_PROVIDER_IDS.includes(...))`
 * 会把未内置的 provider **静默丢弃** —— 用户配了却永远不生效，且无任何报错。
 * 这与本插件「领域名词必须可配置或可移除」的总纲（docs/规划 §2.3）冲突：
 * 换一个出图服务竟然需要发一次代码。
 *
 * 现在：providerId 是任意非空字符串；未内置的走通用 OpenAI 兼容 adapter。
 */

const B64 = Buffer.from('fake-png-bytes').toString('base64');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeSettings(overrides: Partial<SettingsRecord> = {}): SettingsRecord {
  return {
    wechatAppId: '',
    wechatApiBaseUrl: 'https://api.weixin.qq.com',
    wechatAuthor: '',
    defaultTheme: 'professional-clean',
    defaultImageSize: '1024x1024',
    llmDefault: {},
    runHistoryLimit: 200,
    hotspotAggregatorUrl: '',
    agentToolsEnabled: false,
    imageProviders: [],
    ...overrides,
  } as SettingsRecord;
}

describe('providerId 开放化：schema 层', () => {
  it('内置 9 家仍可用（向后兼容）', () => {
    for (const id of BUILTIN_IMAGE_PROVIDER_IDS) {
      const r = ImageProviderConfigSchema.safeParse({ providerId: id, credentialRef: 'X' });
      expect(r.success, `${id} 应继续合法`).toBe(true);
    }
  });

  it('自定义 providerId 被接受（旧 enum 会拒）', () => {
    const r = ImageProviderConfigSchema.safeParse({
      providerId: 'newapi',
      model: 'agnes-image-2.5-flash',
      baseUrl: 'https://api.example.com/v1',
      credentialRef: 'WECHAT_ARTICLE_IMG_NEWAPI',
    });
    expect(r.success).toBe(true);
  });

  it('自定义 provider 缺 baseUrl 时被拒（避免默默打错地址）', () => {
    const r = ImageProviderConfigSchema.safeParse({
      providerId: 'newapi',
      credentialRef: 'WECHAT_ARTICLE_IMG_NEWAPI',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toMatch(/baseUrl/);
    }
  });

  it('内置 provider 可省略 baseUrl（adapter 自带 defaultBaseUrl）', () => {
    expect(ImageProviderConfigSchema.safeParse({ providerId: 'openai', credentialRef: 'X' }).success).toBe(true);
  });

  it('空 providerId 被拒', () => {
    expect(ImageProviderConfigSchema.safeParse({ providerId: '  ', credentialRef: 'X' }).success).toBe(false);
  });

  it('凭据名归一：providerId 含 -/. 也能生成合法 POSIX 名', () => {
    expect(CREDENTIAL_REFS.image('my-provider')).toBe('WECHAT_ARTICLE_IMG_MY_PROVIDER');
    expect(CREDENTIAL_REFS.image('a.b')).toBe('WECHAT_ARTICLE_IMG_A_B');
  });
});

describe('providerId 开放化：isBuiltin 窄化', () => {
  it('内置 id 判定为 true，自定义 id 为 false', () => {
    expect(isBuiltinImageProviderId('openai')).toBe(true);
    expect(isBuiltinImageProviderId('newapi')).toBe(false);
  });
});

describe('通用 OpenAI 兼容 adapter', () => {
  it('请求打到 baseUrl + /images/generations，带 Bearer，model 取用户配置', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ b64_json: B64 }] }),
    ) as unknown as typeof fetch;
    const provider = createCustomProvider('newapi', fetchImpl);

    const result = await provider.generate(
      { prompt: '一只猫', size: '1024x1024', n: 1 },
      { apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', model: 'agnes-image-2.5-flash' },
    );

    expect(result.images).toHaveLength(1);
    expect(result.model).toBe('agnes-image-2.5-flash');
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe('https://api.example.com/v1/images/generations');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String((init as RequestInit).body)).model).toBe('agnes-image-2.5-flash');
  });

  it('未配 model 时回落到通用兜底串（不出现 model: undefined）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ b64_json: B64 }] })) as unknown as typeof fetch;
    const provider = createCustomProvider('newapi', fetchImpl);
    await provider.generate({ prompt: 'x', size: '1024x1024', n: 1 }, { apiKey: 'k', baseUrl: 'https://h/v1' });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body)).model).toBe('gpt-image-1');
  });
});

describe('装配层：自定义 provider 真的会被用（旧代码会静默丢弃）', () => {
  it('settings 里的自定义 provider 参与 fallback 并产出 ImageRecord', async () => {
    const persisted: ImageRecord[] = [];
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ b64_json: B64 }] })) as unknown as typeof fetch;

    const gen = createImagesGenerator({
      getSettings: () =>
        makeSettings({
          imageProviders: [
            {
              providerId: 'newapi',
              model: 'agnes-image-2.5-flash',
              baseUrl: 'https://api.example.com/v1',
              credentialRef: 'WECHAT_ARTICLE_IMG_NEWAPI',
            },
          ],
        }),
      resolveCredential: async (ref) => (ref === 'WECHAT_ARTICLE_IMG_NEWAPI' ? 'sk-test' : undefined),
      now: () => new Date('2026-10-08T00:00:00.000Z'),
      persist: async (records) => {
        persisted.push(...records);
      },
      fetchImpl,
    });

    const out = await gen.generate({ count: 0, articleId: 'art_1' });

    // 关键断言：自定义 provider 被真实调用（旧实现会 filter 掉它 → fetch 0 次）
    expect(fetchImpl).toHaveBeenCalled();
    expect(out.coverImageId).toBeTruthy();
    expect(persisted).toHaveLength(1); // cover 1 张（count=0 → 无正文图）
    expect(persisted[0].provider).toBe('newapi');
    expect(persisted[0].articleId).toBe('art_1');
  });

  it('自定义 provider 缺 baseUrl → 抛可行动错误（而非静默跳过）', async () => {
    const gen = createImagesGenerator({
      // 直接绕过 schema 构造非法配置，模拟存量脏数据
      getSettings: () =>
        makeSettings({
          imageProviders: [
            { providerId: 'newapi', credentialRef: 'WECHAT_ARTICLE_IMG_NEWAPI' } as never,
          ],
        }),
      resolveCredential: async () => 'sk-test',
      now: () => new Date('2026-10-08T00:00:00.000Z'),
      persist: async () => undefined,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    await expect(gen.generate({ count: 0 })).rejects.toThrow(/baseUrl/);
  });

  it('内置 provider 仍走专用 adapter（行为未回归）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ b64_json: B64 }] })) as unknown as typeof fetch;
    const gen = createImagesGenerator({
      getSettings: () =>
        makeSettings({
          imageProviders: [{ providerId: 'openai', credentialRef: 'WECHAT_ARTICLE_IMG_OPENAI' }],
        }),
      resolveCredential: async () => 'sk-openai',
      now: () => new Date('2026-10-08T00:00:00.000Z'),
      persist: async () => undefined,
      fetchImpl,
    });
    const out = await gen.generate({ count: 0 });
    expect(out.coverImageId).toBeTruthy();
    // 内置 openai 的 model 由 Jerry 指令锁定 gpt-image-2
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body)).model).toBe('gpt-image-2');
  });

  it('自定义 provider 在链中排在内置之后时，可在内置失败后接管', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      // 内置 openai 打真实域名 → 模拟失败；自定义 newapi 成功
      if (String(url).includes('api.openai.com')) return new Response('nope', { status: 500 });
      return jsonResponse({ data: [{ b64_json: B64 }] });
    }) as unknown as typeof fetch;

    const gen = createImagesGenerator({
      getSettings: () =>
        makeSettings({
          imageProviders: [
            { providerId: 'openai', credentialRef: 'WECHAT_ARTICLE_IMG_OPENAI' },
            {
              providerId: 'newapi',
              model: 'agnes-image-2.5-flash',
              baseUrl: 'https://api.example.com/v1',
              credentialRef: 'WECHAT_ARTICLE_IMG_NEWAPI',
            },
          ],
        }),
      resolveCredential: async (ref) => (ref.includes('NEWAPI') ? 'sk-newapi' : 'sk-openai'),
      now: () => new Date('2026-10-08T00:00:00.000Z'),
      persist: async () => undefined,
      fetchImpl,
    });

    const out = await gen.generate({ count: 0 });
    expect(calls.some((u) => u.includes('api.openai.com')), '内置先试').toBe(true);
    expect(calls.some((u) => u.includes('api.example.com')), '自定义接管').toBe(true);
    expect(out.coverImageId).toBeTruthy();
  });
});

describe('回归：类型面 ImageProviderId 已是开放 string', () => {
  it('任意字符串都可赋给 ImageProviderId', () => {
    const ids: ImageProviderId[] = ['openai', 'newapi', 'my-provider', 'a.b'];
    expect(ids).toHaveLength(4);
  });
});