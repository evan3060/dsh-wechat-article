/**
 * 正文配图占位替换（2026-10-08 补完 wewrite 未完成的功能）。
 *
 * ── 缺陷因果链（逐环实测，非推断）────────────────────────────────────────
 * ① `src/host/pipeline/llm.ts:185` 的 draft 提示词要求 LLM 写
 *    「![描述](图片待生成)」占位，并明说「后续管线会替换」。
 * ② 但全仓 grep「图片待生成」只命中这一处 —— **没有任何替换逻辑**（承诺未兑现）。
 * ③ marked 会把占位渲染成 `<img src="%E5%9B%BE%E7%89%87...">`（中文被 URL-encode）。
 * ④ 该串能过 `sanitizeUrl` 的 `URL_SAFE_CHARS`（纯 ASCII），所以 `<img>` **不会**被 sanitize 丢弃。
 * ⑤ 但 `wechat/client.ts` 的 `replaceImageSources` 是**按出现顺序**把已上传图片的
 *    URL 填进现有 `<img src>`——占位符存在，它本该能被替换……
 * ⑥ 实测推送到微信的 content 里 `<img>` 数量 = **0**。
 *
 * → 结论：占位符本身不是 URL 语义（`图片待生成` 不是资源地址），真正的问题是
 *   **它从未被换成任何真实图片**，导致正文无图可显示。本模块补上这一步。
 *
 * ── 替换为什么用 data URI ────────────────────────────────────────────────
 * 微信正文不接受 base64，真实推送靠 `replaceImageSources` 再换成
 * `mmbiz.qpic.cn` 的 URL。本地预览则需要 data URI（无鉴权、可直接 <img src>）。
 * 故替换目标是 `data:<mime>;base64,<...>`：本地能显示，推送时被
 * `replaceImageSources` 按序覆盖成微信 URL——两条路径共用同一批 `<img>` 位置。
 */

/** LLM 约定的占位 URL 片段（中文，llm.ts 提示词里的原样字面量）。 */
export const IMAGE_PLACEHOLDER = '图片待生成';

/**
 * 匹配 `![alt](图片待生成)`。
 * alt 允许任意非 ] 字符（含空）；URL 只认占位符本身，避免误伤真实图片链接。
 */
const PLACEHOLDER_RE = new RegExp(
  `!\\[([^\\]]*)\\]\\(${IMAGE_PLACEHOLDER}\\)`,
  'g',
);

/** 最小 base64 形态探测：判断是否为可内联的图片 data URI。 */
const DATA_URI_RE = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/;

export interface InlineImage {
  readonly base64: string;
  readonly mime: string;
}

/**
 * 按出现顺序把占位符替换成 data URI。
 *
 * @param markdown - 文章 markdown（可能含 0..n 个占位符）
 * @param images   - 与占位符顺序对应的图片（通常是 bodyImageIds 对应的记录）
 * @returns 替换后的 markdown；图片不足时**多余占位符保持原样**（不丢内容，
 *          且 alt 文本仍在——对齐 sanitize.ts:26 的「资源被丢弃，保留 alt 文本」）
 */
export function replaceImagePlaceholders(markdown: string, images: readonly InlineImage[]): string {
  let index = 0;
  return markdown.replace(PLACEHOLDER_RE, (whole, alt: string) => {
    const image = images[index];
    if (!image) return whole;
    index += 1;
    return `![${alt}](data:${image.mime};base64,${image.base64})`;
  });
}

/** 占位符数量（诊断/测试用）。 */
export function countImagePlaceholders(markdown: string): number {
  return (markdown.match(PLACEHOLDER_RE) ?? []).length;
}

/** 该 data URI 是否可安全内联进 markdown（复检，避免把非图片 data URI 塞进正文）。 */
export function isInlineImageDataUri(uri: string): boolean {
  return DATA_URI_RE.test(uri);
}