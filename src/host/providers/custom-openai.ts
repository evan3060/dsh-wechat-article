/**
 * 通用 OpenAI 兼容出图 adapter（2026-10-08 新增，解除 providerId 硬编码的落地端）。
 *
 * 九成出图服务都是 OpenAI Images 兼容形状：
 *   POST {baseUrl}/images/generations
 *   Authorization: Bearer {apiKey}
 *   { model, prompt, size, n }
 *   响应 { data: [ { b64_json } | { url } ] }
 *
 * 自定义 provider（providerId 不在内置 9 家）由此实现：baseUrl / model / credentialRef
 * 全部来自 settings.imageProviders 的用户配置，**新增一家服务不需要改代码**。
 *
 * 与内置 openai provider 的差别（有意为之，别合并）：
 *   - 内置 openai 的 model 由 Jerry 指令锁定 gpt-image-2（v0.1 契约，见 providers/openai.ts）；
 *   - 通用 adapter **以用户配的 model 为准**（declareProvider 已按
 *     `cfg.model ?? declaration.defaultModel` 解析好再传给 body）。
 *     自定义服务（如 newapi / agnes-image-2.5-flash）本就不该被内置默认值覆盖。
 */

import { declareProvider } from './transport';
import { CUSTOM_PROVIDER_FALLBACK_MODEL, type ImageProviderId } from '../../shared/image-provider-ids';

/**
 * 自定义 provider 工厂：按 providerId 产出一个 OpenAI 兼容 adapter 实例。
 *
 * baseUrl 必填（schema 层已用 refine 保证自定义 provider 必须填），这里仍留兜底常量：
 * 真正的缺值拦截在 images.ts 生成链里做（见 assertCustomBaseUrl 的使用点），
 * 这里给空串只会让 joinUrl 拼出畸形地址，不如让上层先拦。
 */
export function createCustomProvider(providerId: ImageProviderId, fetchImpl?: typeof fetch) {
  return declareProvider({
    id: providerId,
    defaultBaseUrl: '',
    defaultModel: CUSTOM_PROVIDER_FALLBACK_MODEL,
    endpoint: () => ({ path: '/images/generations' }),
    headers: (cfg) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    }),
    // model 由 declareProvider 解析（用户配置优先，缺省回落 defaultModel）后传进来
    body: (req, model) => ({
      model,
      prompt: req.prompt,
      size: req.size,
      n: req.n,
    }),
  }, fetchImpl);
}

/** 自定义 provider 必须显式配置 baseUrl（内置的可用 adapter 自带 defaultBaseUrl）。 */
export function assertCustomBaseUrl(providerId: ImageProviderId, baseUrl: string | undefined): string {
  const trimmed = (baseUrl ?? '').trim();
  if (!trimmed) {
    throw new Error(
      `自定义出图供应商「${providerId}」缺少 baseUrl：请在设置 → 图片供应商里补上 OpenAI 兼容服务地址（如 https://host/v1）`,
    );
  }
  return trimmed;
}