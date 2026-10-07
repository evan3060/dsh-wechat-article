import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createRpc, WeChatArticleRpcError, describeRpcFailure } from '@/client/lib/rpc';
import { API_PREFIX } from '@/shared/contract';
import type { ClientContext } from '@/client/lib/context';

/**
 * [rc.2] 客户端传输层：改走 `fetch` 直连 `/api/dsh-wechat-article/<endpoint>`。
 *
 * 本文件补的是**传输层**覆盖 —— 迁移前 createRpc 零测试（766 全绿属假绿），
 * 旧实现用的是 `ctx.connection.rpc.call(channel, …)`，那条路在 rc.2 已不可用。
 */

const ctx = {} as ClientContext;

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: string, init: RequestInit) => impl(url, init));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[rc.2] 客户端端点调用（fetch 直连）', () => {
  it('打到 /api 前缀下的精确路径，POST + JSON body', async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true, value: { articles: [], runs: [] } }));
    const rpc = createRpc(ctx);
    await rpc.call('snapshot');
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_PREFIX}/snapshot`);
    expect(url.startsWith('/api/'), '必须落在 /api 之下（宿主围栏只覆盖 /api）').toBe(true);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBe('{}');
  });

  it('多段端点名原样拼接（article/list 不被编码或截断）', async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true, value: [] }));
    await createRpc(ctx).call('article/list');
    const [url] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API_PREFIX}/article/list`);
  });

  it('ok 信封 → 返回 value', async () => {
    mockFetch(() => jsonResponse({ ok: true, value: { id: 'a1' } }));
    await expect(createRpc(ctx).call('article/get', { id: 'a1' })).resolves.toEqual({ id: 'a1' });
  });

  it('ok:false 信封 → 抛 WeChatArticleRpcError，message 带 [code] 前缀', async () => {
    mockFetch(() =>
      jsonResponse({ ok: false, error: { code: 'llm-not-configured', message: '尚未配置默认模型', details: {} } }),
    );
    await expect(createRpc(ctx).call('article/rewrite')).rejects.toThrow(
      /\[llm-not-configured\] 尚未配置默认模型/,
    );
  });

  it('不再经 ctx.connection.rpc.call（该通道在 rc.2 无法注册）', async () => {
    const legacyCall = vi.fn();
    const legacyCtx = { connection: { rpc: { call: legacyCall } } } as unknown as ClientContext;
    mockFetch(() => jsonResponse({ ok: true, value: 1 }));
    await createRpc(legacyCtx).call('snapshot');
    expect(legacyCall, '旧传输面不应再被调用').not.toHaveBeenCalled();
  });

  it('宿主前置拒绝（HTTP 400 空 body）→ 归一为带状态码的错误，不抛裸 TypeError', async () => {
    mockFetch(() => new Response('', { status: 400 }));
    const err = await createRpc(ctx)
      .call('article/get')
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WeChatArticleRpcError);
    expect((err as WeChatArticleRpcError).message).toMatch(/HTTP 400/);
  });

  it('网络异常（非 fetch 抛出）→ 归一为 WeChatArticleRpcError', async () => {
    mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const err = await createRpc(ctx)
      .call('snapshot')
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WeChatArticleRpcError);
    expect((err as WeChatArticleRpcError).message).toMatch(/Failed to fetch/);
  });

  it('AbortSignal 透传给 fetch（取消链路保留）', async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true, value: null }));
    const controller = new AbortController();
    await createRpc(ctx).call('snapshot', {}, controller.signal);
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('错误分类链路仍工作：errcode 40164 判为 IP 白名单问题', () => {
    const notice = describeRpcFailure(
      new WeChatArticleRpcError('wechat/pushDraft', 'invalid ip', { errcode: 40164 }),
    );
    expect(notice.ipWhitelist).toBe(true);
    expect(notice.title).toMatch(/白名单/);
  });
});
