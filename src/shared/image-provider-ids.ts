/**
 * 图片供应商 ID（架构 §7.1；2026-10-08 解除硬编码枚举）。
 *
 * 历史：此处曾是 `z.enum(IMAGE_PROVIDER_IDS)` 的封闭 9 家，只能靠改代码接新服务。
 * 但九成出图服务都是 OpenAI 兼容（`POST {base}/images/generations` + Bearer + b64_json），
 * 硬编码 enum 让「换一家服务」变成一次代码发布——与本插件「领域名词必须可配置或可移除」
 * 的总纲（docs/规划 §2.3）冲突。
 *
 * 现状：**内置 9 家仍是预设**（协议细节确有差异：gemini 是 :predictRaw、replicate 是
 * 独立 REST、各家默认模型不同），但 providerId 不再是封闭集合——任何未内置的 id
 * 走通用 OpenAI 兼容 adapter，由 settings.imageProviders 提供
 * baseUrl + model + credentialRef 即可，无需改代码。
 */

/** 内置 9 家（有专用 adapter 与默认模型；与 tests/host/providers-registry.test.ts 钉定的集合一致）。 */
export const BUILTIN_IMAGE_PROVIDER_IDS = [
  'openai',
  'doubao',
  'dashscope',
  'jimeng',
  'minimax',
  'azure_openai',
  'gemini',
  'openrouter',
  'replicate',
] as const;

export type BuiltinImageProviderId = (typeof BUILTIN_IMAGE_PROVIDER_IDS)[number];

/**
 * providerId 全集：内置 id ∪ 任意自定义字符串。
 *
 * 与旧名的语义差别：旧 `ImageProviderId` 是封闭 union（仅 9 家）；现在是开放 string——
 * 内置 adapter 查表用 `isBuiltinImageProviderId` 做窄化，自定义 id 不会误入查表分支。
 */
export type ImageProviderId = string;

/** @deprecated 旧名保留以兼容既有 import，值已等同 BUILTIN_IMAGE_PROVIDER_IDS。 */
export const IMAGE_PROVIDER_IDS = BUILTIN_IMAGE_PROVIDER_IDS;

/** 默认 fallback 链：用户可在设置里重排/删减/插入自定义 provider，缺省顺序锁定。 */
export const DEFAULT_IMAGE_PROVIDER_CHAIN: readonly BuiltinImageProviderId[] = [...BUILTIN_IMAGE_PROVIDER_IDS];

/** 各家缺省模型（ResolvedProviderConfig.model 缺省时的回退值；openai 由 Jerry 指令锁定 gpt-image-2）。 */
export const DEFAULT_PROVIDER_MODELS: Readonly<Record<BuiltinImageProviderId, string>> = {
  openai: 'gpt-image-2',
  doubao: 'doubao-seededit-3-0-i2i',
  dashscope: 'wanx2.1-t2i-turbo',
  jimeng: 'jimeng-2.1-latest',
  minimax: 'image-01',
  azure_openai: 'gpt-image-2',
  gemini: 'gemini-2.5-flash-image',
  openrouter: 'openai/gpt-image-2',
  replicate: 'black-forest-labs/flux-schnell',
};

/**
 * 自定义 provider 未填 model 时的兜底模型串。
 * 避免请求体里出现 model: undefined 被远端拒；实际使用应优先 settings 里配的 model。
 */
export const CUSTOM_PROVIDER_FALLBACK_MODEL = 'gpt-image-1';

/** 凭据引用（ctx.credentials 的 POSIX 环境变量名，F19/F20）。 */
export const CREDENTIAL_REFS = {
  wechatSecret: 'WECHAT_ARTICLE_WECHAT_SECRET',
  /** providerId 允许含 `-`/`.`，凭据名统一归一为大写非字母数字，避免 POSIX 名非法。 */
  image: (providerId: ImageProviderId): string =>
    `WECHAT_ARTICLE_IMG_${providerId.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}`,
} as const;

/** 该 id 是否有内置专用 adapter（决定走专用实现还是通用 OpenAI 兼容实现）。 */
export function isBuiltinImageProviderId(value: string): value is BuiltinImageProviderId {
  return (BUILTIN_IMAGE_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * 任意非空字符串都是合法 providerId（自定义 provider 走通用 adapter）。
 * 保留此函数仅为兼容既有调用点的命名。
 */
export function isImageProviderId(value: string): value is ImageProviderId {
  return value.length > 0;
}