/**
 * 渲染层安全基线：转义 + URL 消毒 + 受限标签集（架构 §3：无 style/link、样式全内联）。
 * markdown 内的原始 HTML 只放行白名单标签与白名单属性；script/iframe 一律转义为文本。
 */

const TEXT_ESCAPE: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const ATTR_ESCAPE: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '"': '&quot;' };

export function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (ch) => TEXT_ESCAPE[ch]);
}

export function escapeAttr(text: string): string {
  return text.replace(/[&<"]/g, (ch) => ATTR_ESCAPE[ch]);
}

export function escapeCode(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ ...TEXT_ESCAPE, '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

/** URL 协议白名单 + 危险字符黑名单（含引号，杜绝属性逃逸注入）。 */
const URL_SAFE_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
/**
 * 允许的协议。
 *
 * `data:` 于 2026-10-08 加入：正文配图占位替换（pipeline/image-placeholders.ts）把
 * `![alt](图片待生成)` 换成本地 data URI，供写作台预览直接显示（真实推送时
 * wechat/client.ts 的 replaceImageSources 会再换成 mmbiz.qpic.cn 的 URL）。
 * 未加前 data URI 被 sanitize 丢弃 → 预览与推送正文里一张图都没有。
 *
 * 只放行**图片** data URI（见 DATA_IMAGE_RE），不放行 data:text/html 等可执行载荷。
 */
const URL_SCHEMES = new Set(['http', 'https', 'mailto', 'data']);

/** 图片类 data URI：`data:image/<子类型>;base64,<载荷>`。 */
const DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/i;

/**
 * URL 消毒：合法返回原串（调用方再做属性转义），非法返回 null（资源被丢弃，保留 alt 文本）。
 * javascript: 伪协议、带引号/尖括号/空白的 URL 一律拒绝。
 */
export function sanitizeUrl(rawUrl: string): string | null {
  const url = rawUrl.trim();
  if (!url) return null;
  const scheme = url.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  if (scheme && !URL_SCHEMES.has(scheme[1].toLowerCase())) return null;
  if (!URL_SAFE_CHARS.test(url)) return null;
  // data: 额外收紧为「图片 + base64」——通用 data: 可承载 html/svg 等可执行载荷。
  if (scheme && scheme[1].toLowerCase() === 'data' && !DATA_IMAGE_RE.test(url)) return null;
  return url;
}

/** 受限标签集（微信正文友好子集；h1 不在列——标题由发布字段承载）。 */
const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'figcaption', 'figure', 'font', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'section', 'span', 'strong', 'sub',
  'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul',
]);

const ALLOWED_ATTRS = new Set([
  'align', 'alt', 'class', 'colspan', 'height', 'href', 'rowspan', 'size', 'src', 'start', 'style',
  'title', 'width',
]);

const VOID_TAGS = new Set(['br', 'hr', 'img']);

/**
 * 单个标签消毒：白名单内重建（属性白名单 + href/src 过 sanitizeUrl），否则返回 null。
 */
export function sanitizeHtmlTag(rawTag: string): string | null {
  const match = rawTag.match(/^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)>$/s);
  if (!match) return null;
  const [, closing, rawName, attrText] = match;
  const name = rawName.toLowerCase();
  if (!ALLOWED_TAGS.has(name)) return null;
  if (closing) return `</${name}>`;
  const attrs: string[] = [];
  const attrRe = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const attrMatch of attrText.matchAll(attrRe)) {
    const attrName = attrMatch[1].toLowerCase();
    if (!ALLOWED_ATTRS.has(attrName) || attrName.startsWith('on')) continue;
    const rawValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
    if (attrName === 'href' || attrName === 'src') {
      const url = sanitizeUrl(rawValue);
      if (url === null) continue;
      attrs.push(`${attrName}="${escapeAttr(url)}"`);
      continue;
    }
    const value = rawValue.replace(/[<>]/g, '').replace(/[\u0000-\u001f]/g, '');
    attrs.push(`${attrName}="${escapeAttr(value)}"`);
  }
  const attrSuffix = attrs.length ? ` ${attrs.join(' ')}` : '';
  return VOID_TAGS.has(name) ? `<${name}${attrSuffix} />` : `<${name}${attrSuffix}>`;
}

/** 混合片段消毒：标签逐个过白名单，其余文本全转义。 */
export function sanitizeHtmlFragment(text: string): string {
  return text.replace(/<\/?[a-zA-Z][^>]*>|[^<]+/gs, (part) => {
    if (!part.startsWith('<')) return escapeText(part);
    const sanitized = sanitizeHtmlTag(part);
    return sanitized ?? escapeText(part);
  });
}
