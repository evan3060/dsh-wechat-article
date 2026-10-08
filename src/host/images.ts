/**
 * 图片步装配（F7 / AC-9）：providers fallback 链 + ImageRecord 产线。
 * 从 service 拆出（单文件 <=300 行纪律）；凭据经注入的 resolver 读取（ADR-006）。
 */

import { randomUUID } from 'node:crypto';
import { CREDENTIAL_REFS, DEFAULT_IMAGE_PROVIDER_CHAIN, type ImageProviderId } from '../shared/image-provider-ids';
import type { ImageProviderConfig } from '../shared/contract';
import type { ImageRecord, SettingsRecord } from './domain';
import type { ImagesGenerator } from './pipeline/engine';
import { runImageFallback } from './providers/registry';
import type { ImageGenRequest, ImageProvider, ResolvedProviderConfig } from './providers/types';
import { createAzureOpenAiProvider } from './providers/azure-openai';
import { createDoubaoProvider } from './providers/doubao';
import { createDashscopeProvider } from './providers/dashscope';
import { createGeminiProvider } from './providers/gemini';
import { createJimengProvider } from './providers/jimeng';
import { createMinimaxProvider } from './providers/minimax';
import { createOpenAiProvider } from './providers/openai';
import { createOpenrouterProvider } from './providers/openrouter';
import { createReplicateProvider } from './providers/replicate';
import { createCustomProvider } from './providers/custom-openai';

/**
 * 内置 provider 工厂表（键为内置 9 家的 id）。
 *
 * [2026-10-08] 不再是 `Record<ImageProviderId, …>` 的全量表——ImageProviderId 放宽为
 * string 后不可能穷举。改为按 id 查表，未命中则回落通用 OpenAI 兼容 adapter
 * （见 `createCustomProvider`）。
 */
export const PROVIDER_FACTORIES: Readonly<Record<string, (fetchImpl?: typeof fetch) => ImageProvider>> = {
  openai: createOpenAiProvider,
  doubao: createDoubaoProvider,
  dashscope: createDashscopeProvider,
  jimeng: createJimengProvider,
  minimax: createMinimaxProvider,
  azure_openai: createAzureOpenAiProvider,
  gemini: createGeminiProvider,
  openrouter: createOpenrouterProvider,
  replicate: createReplicateProvider,
};

export interface ImagesGeneratorDeps {
  readonly getSettings: () => SettingsRecord;
  readonly resolveCredential: (ref: string) => Promise<string | undefined>;
  readonly now: () => Date;
  readonly persist: (records: readonly ImageRecord[]) => Promise<void>;
  /** 传输层注入（测试路由 / 出口代理），缺省走全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
}

export function createImagesGenerator(deps: ImagesGeneratorDeps): ImagesGenerator {
  return {
    generate: async ({ count, articleId, title, digest, topics }) => {
      const settings = deps.getSettings();
      const chain = settings.imageProviders.length
        ? settings.imageProviders
        : DEFAULT_IMAGE_PROVIDER_CHAIN.map((providerId): ImageProviderConfig => ({
            providerId,
            credentialRef: CREDENTIAL_REFS.image(providerId),
          }));
      const keys = await Promise.all(
        chain.map(async (entry) => String((await deps.resolveCredential(entry.credentialRef)) ?? '')),
      );
      const configs = new Map<ImageProviderId, ResolvedProviderConfig>(
        chain.map((entry, index) => [
          entry.providerId,
          {
            apiKey: keys[index],
            ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
            ...(entry.model ? { model: entry.model } : {}),
          },
        ]),
      );
      // [2026-10-08] 解除 providerId 硬编码：不再 filter 掉未内置的 provider——
      // 内置 id 查 PROVIDER_FACTORIES 拿专用 adapter，自定义 id 走通用 OpenAI 兼容
      // adapter（createCustomProvider）。旧代码的 `.filter(IMAGE_PROVIDER_IDS.includes)`
      // 会把 `newapi` 之类静默丢弃，用户配了却永远不生效。
      //
      // 自定义 provider 缺 baseUrl 时不静默跳过（那会让用户以为配错了顺序），
      // 而是抛明确错误——schema 层已用 refine 拦过一次，这里是运行期兜底。
      const providers = chain.map((entry) => {
        const factory = PROVIDER_FACTORIES[entry.providerId];
        if (factory) return factory(deps.fetchImpl);
        if (!entry.baseUrl?.trim()) {
          throw new Error(
            `自定义出图供应商「${entry.providerId}」缺少 baseUrl：请在设置 → 图片供应商里补上 OpenAI 兼容服务地址（如 https://host/v1）`,
          );
        }
        return createCustomProvider(entry.providerId, deps.fetchImpl);
      });
      const resolveConfig = (providerId: ImageProviderId): ResolvedProviderConfig =>
        configs.get(providerId) ?? { apiKey: '' };

      const make = async (prompt: string): Promise<ImageRecord> => {
        const req: ImageGenRequest = { prompt, size: settings.defaultImageSize, n: 1 };
        const outcome = await runImageFallback(providers, resolveConfig, req);
        const image = outcome.result.images[0];
        return {
          v: 1,
          id: `img_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          // P0-1：真实文章 id 溯源（render 步落库后回传；无绑定场景兜底占位）
          articleId: articleId ?? 'pending',
          kind: 'body',
          mime: image?.mime ?? 'image/png',
          base64: (image?.buffer ?? Buffer.alloc(0)).toString('base64'),
          provider: outcome.providerId,
          model: outcome.result.model,
          prompt,
          createdAt: deps.now().toISOString(),
        };
      };

      // ── 封面提示词（2026-10-08 由固定句改为内容驱动）────────────────────────
      // 旧句「风格克制、信息密度高，深色纯色背景，无文字水印」与文章无关，实测产出
      // 是几块大面积纯色（用户反馈：没有任何意义）。现按标题/摘要构造
      // 「信息图封面」提示词：要求主体图形 + 图例 + 简短中文标签，替代纯色背景。
      const subject = (title ?? '微信公众号文章').slice(0, 40);
      const angle = (digest ?? '').replace(/\s+/g, ' ').slice(0, 120);
      const coverPrompt = [
        `为中文文章《${subject}》生成一张**信息图风格的封面图**。`,
        angle ? `文章主旨：${angle}。` : '',
        '硬性要求：',
        '1) 必须有具体视觉主体——用流程箭头、架构分层、对比矩阵、步骤时间轴之一表达文章核心概念，不要纯色背景或抽象色块；',
        '2) 必须有图例（legend），用色块/线条旁标注简短中文标签说明含义；',
        '3) 可含 3-6 个简短中文词组作为要点标签（如「占位替换」「CDN 上传」），每组不超过 6 字，横向排布；',
        '4) 配色克制（深蓝或墨绿主色 + 米白底），元素层级清晰，留白充足；',
        '5) 输出 2.35:1 附近的横向构图，主体内容避开上下边缘（上下各留约 15% 空白，中心区域放主体），',
        '不要水印、不要二维码、不要人物照片。',
      ].filter(Boolean).join('');

      const cover = await make(coverPrompt);

      // ── 正文配图：按小节标题逐张生成，各配各的主题 ─────────────────────────
      const sections = topics?.length ? topics : [];
      const bodies: ImageRecord[] = [];
      for (let index = 0; index < count; index += 1) {
        const section = sections[index]?.slice(0, 30);
        bodies.push(await make([
          section
            ? `为中文文章《${subject}》的「${section}」一节生成信息图配图。`
            : `为中文文章《${subject}》生成第 ${index + 1} 张正文配图。`,
          '要求：单一主题的示意图或图表，结构清晰，',
          '含简短中文标签标注关键元素，可带图例说明配色或符号含义，',
          '配色克制（深蓝/墨绿 + 米白底），留白充足，不要水印与二维码。',
        ].join('')));
      }
      const stored = [{ ...cover, kind: 'cover' as const }, ...bodies];
      await deps.persist(stored);
      return { coverImageId: stored[0].id, bodyImageIds: bodies.map((record) => record.id) };
    },
  };
}
