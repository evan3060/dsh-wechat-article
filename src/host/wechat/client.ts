/**
 * 微信公众平台 API 客户端（F30 端点族）：
 * token / media/uploadimg / material/add_material / draft add。
 * apiBaseUrl 从 getSettings() 注入并贯穿全部请求（AC-2 无混合路径）；
 * 推送编排原子化（AC-1：draft/add 失败抛错，绝不返回半成品 mediaId）；
 * errcode 分类诊断在 diagnostics.ts（AC-6：40164 特判）。
 */

import { truncateMessage } from '../redaction';
import {
  classifyErrcode,
  extractExitIp,
  hintForClassification,
  NETWORK_HINT,
  type WeChatClassification,
} from './diagnostics';
import { resolveApiBaseUrl } from './egress';

export class WeChatApiError extends Error {
  readonly errcode: number;
  readonly classification: WeChatClassification;
  readonly hint?: string;

  constructor(errcode: number, classification: WeChatClassification, hint?: string, message?: string) {
    super(message ?? `微信 API 错误 ${errcode}`);
    this.name = 'WeChatApiError';
    this.errcode = errcode;
    this.classification = classification;
    this.hint = hint;
  }
}

export interface WeChatCredentials {
  readonly appId: string;
  readonly secret: string;
}

export interface WeChatSettings {
  readonly apiBaseUrl: string;
  readonly author: string;
}

export interface WeChatClientDeps {
  readonly fetchImpl?: typeof fetch;
  readonly getCredentials: () => WeChatCredentials;
  readonly getSettings: () => WeChatSettings;
  readonly now?: () => number;
}

export interface WeChatBinary {
  readonly buffer: Buffer;
  readonly mime: string;
  readonly filename?: string;
}

export interface PushDraftInput {
  readonly title: string;
  readonly digest: string;
  readonly contentHtml: string;
  readonly thumbImage: WeChatBinary;
  readonly contentImages: readonly WeChatBinary[];
  readonly author?: string;
}

export interface DiagnoseResult {
  readonly reachable: boolean;
  readonly ipWhitelisted?: boolean;
  readonly errcode?: number;
  readonly hint: string;
}

const IMAGE_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)(\2)/gis;

/** cover_info.crop_percent_list 条目（官方契约：坐标为 0..1 比例值字符串）。 */
export interface CoverCropEntry {
  readonly ratio: '2.35_1' | '1_1' | '16_9';
  readonly x1: string;
  readonly y1: string;
  readonly x2: string;
  readonly y2: string;
}

/**
 * 成功结果的联合访问面（tests 契约先例）：调用方 `promise.catch(() => error)` 取
 * 成功类型 | WeChatApiError 联合后直接访问 errcode/classification/message。
 * 这些可选字段在运行时恒不出现，纯类型面。
 */
type SuccessAccess = { readonly errcode?: undefined; readonly classification?: undefined; readonly message?: undefined };
export type WeChatToken = string & SuccessAccess;
export type PushDraftResult = { readonly mediaId: string; readonly thumbMediaId: string } & SuccessAccess;

export function createWeChatClient(deps: WeChatClientDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  let cachedToken: { token: string; expiresAt: number } | null = null;

  function toApiError(errcode: number, errmsg: string | undefined): WeChatApiError {
    const classification = classifyErrcode(errcode);
    const exitIp = classification === 'IP_WHITELIST' ? extractExitIp(errmsg ?? '') : undefined;
    return new WeChatApiError(
      errcode,
      classification,
      hintForClassification(classification, exitIp),
      truncateMessage(`微信 API 错误 ${errcode}：${errmsg ?? '未知错误'}`),
    );
  }

  async function callJson(path: string, query: Record<string, string>, init?: RequestInit): Promise<Record<string, unknown>> {
    const base = resolveApiBaseUrl(deps.getSettings().apiBaseUrl);
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), init);
    } catch (error) {
      throw new WeChatApiError(
        -2,
        'NETWORK',
        NETWORK_HINT,
        `微信 API 网络请求失败：${error instanceof Error ? error.message : String(error ?? '未知错误')}`,
      );
    }
    const data = (await response.json()) as Record<string, unknown>;
    const errcode = typeof data.errcode === 'number' ? data.errcode : 0;
    if (errcode !== 0) throw toApiError(errcode, typeof data.errmsg === 'string' ? data.errmsg : undefined);
    return data;
  }

  async function fetchAccessToken(): Promise<WeChatToken> {
    if (cachedToken && now() < cachedToken.expiresAt) return cachedToken.token;
    const { appId, secret } = deps.getCredentials();
    const data = await callJson('/cgi-bin/token', {
      grant_type: 'client_credential',
      appid: appId,
      secret,
    });
    const token = data.access_token;
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 0;
    if (typeof token !== 'string' || !token) {
      throw new WeChatApiError(-1, 'SYSTEM', 'token 响应未包含 access_token', '微信 token 响应未包含 access_token');
    }
    cachedToken = { token, expiresAt: now() + expiresIn * 1000 };
    return token;
  }

  function multipart(image: WeChatBinary, field = 'media'): FormData {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(image.buffer)], { type: image.mime });
    form.append(field, blob, image.filename ?? `wechat-article-${field}.${image.mime.split('/')[1] ?? 'png'}`);
    return form;
  }

  async function uploadContentImage(image: WeChatBinary): Promise<string> {
    const token = await fetchAccessToken();
    const data = await callJson('/cgi-bin/media/uploadimg', { access_token: token }, {
      method: 'POST',
      body: multipart(image),
    });
    if (typeof data.url !== 'string' || !data.url) {
      throw new WeChatApiError(-1, 'SYSTEM', 'uploadimg 响应未包含 CDN URL', '微信 uploadimg 响应未包含 CDN URL');
    }
    return data.url;
  }

  async function uploadThumbMaterial(image: WeChatBinary): Promise<string> {
    const token = await fetchAccessToken();
    const data = await callJson('/cgi-bin/material/add_material', { access_token: token, type: 'image' }, {
      method: 'POST',
      body: multipart(image),
    });
    if (typeof data.media_id !== 'string' || !data.media_id) {
      throw new WeChatApiError(-1, 'SYSTEM', 'add_material 响应未包含 media_id', '微信 add_material 响应未包含 media_id');
    }
    return data.media_id;
  }

  /**
   * 封面双比例裁剪区（cover_info.crop_percent_list）。
   *
   * [2026-10-08] 官方契约（draft/add 文档 Body.articles.cover_info）：
   * 以图片左上 (0,0)、右下 (1,1) 建平面坐标系，x1/y1/x2/y2 是**比例值字符串**（0..1）。
   * news（图文消息）仅支持 "2.35_1" 与 "1_1" 两个 ratio —— 分别对应
   * 消息列表（2.35:1）与转发卡片/公众号主页（1:1）。
   *
   * 缺省不传时微信自行裁剪，两个比例会落在同一块区域（实测表现：列表与卡片
   * 看到的是同一构图）。故显式给出两个 ratio 的裁剪区。
   *
   * 值取「居中最大内接」：先按目标比例从原图取最大居中区域，再归一化回 0..1。
   * 2.35_1 取满宽（x 0→1）后按比例定高；1_1 取居中正方形。
   */
  function buildCoverCrop(ratio: '2.35_1' | '1_1'): CoverCropEntry {
    if (ratio === '2.35_1') {
      // 2.35:1 → 高度占比 1/2.35 ≈ 0.4255，上下各留一半
      const h = 1 / 2.35;
      const y1 = (1 - h) / 2;
      return { ratio, x1: '0', y1: y1.toFixed(4), x2: '1', y2: (y1 + h).toFixed(4) };
    }
    // 1:1 → 居中正方形：宽高各取 1
    return { ratio, x1: '0', y1: '0', x2: '1', y2: '1' };
  }

  async function addDraft(input: {
    title: string;
    digest: string;
    author: string;
    contentHtml: string;
    thumbMediaId: string;
    contentImageUrls?: readonly string[];
    /** 覆盖默认双比例裁剪（测试/调试用；缺省按居中最大内接生成）。 */
    coverCrop?: readonly CoverCropEntry[];
  }): Promise<string> {
    const token = await fetchAccessToken();
    const data = await callJson('/cgi-bin/draft/add', { access_token: token }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        articles: [
          {
            title: input.title,
            author: input.author,
            digest: input.digest,
            content: input.contentHtml,
            thumb_media_id: input.thumbMediaId,
            show_cover_pic: 0,
            // [2026-10-08] 双比例封面裁剪：消息列表 2.35:1 + 转发卡片/主页 1:1。
            // 不传时微信用默认裁剪，两个比例共用同一构图。
            cover_info: {
              crop_percent_list: input.coverCrop ?? [buildCoverCrop('2.35_1'), buildCoverCrop('1_1')],
            },
          },
        ],
      }),
    });
    if (typeof data.media_id !== 'string' || !data.media_id) {
      throw new WeChatApiError(-1, 'SYSTEM', 'draft/add 响应未包含 media_id', '微信 draft/add 响应未包含 media_id');
    }
    return data.media_id;
  }

  function replaceImageSources(html: string, uploadedUrls: readonly string[]): string {
    let index = 0;
    return html.replace(IMAGE_SRC_RE, (whole, prefix: string, quote: string, _source: string) => {
      if (index >= uploadedUrls.length) return whole;
      const replacement = uploadedUrls[index];
      index += 1;
      return `${prefix}${quote}${replacement}${quote}`;
    });
  }

  async function pushDraft(input: PushDraftInput): Promise<PushDraftResult> {
    const token = await fetchAccessToken();
    const uploadedUrls: string[] = [];
    for (const image of input.contentImages) {
      const url = await callJson('/cgi-bin/media/uploadimg', { access_token: token }, {
        method: 'POST',
        body: multipart(image),
      }).then((data) => {
        if (typeof data.url !== 'string' || !data.url) {
          throw new WeChatApiError(-1, 'SYSTEM', 'uploadimg 响应未包含 CDN URL', '微信 uploadimg 响应未包含 CDN URL');
        }
        return data.url;
      });
      uploadedUrls.push(url);
    }
    const thumbMediaId = await uploadThumbMaterial(input.thumbImage);
    const finalHtml = replaceImageSources(input.contentHtml, uploadedUrls);
    const mediaId = await addDraft({
      title: input.title,
      digest: input.digest,
      author: input.author ?? deps.getSettings().author,
      contentHtml: finalHtml,
      thumbMediaId,
      contentImageUrls: uploadedUrls,
    });
    return { mediaId, thumbMediaId };
  }

  async function diagnose(): Promise<DiagnoseResult> {
    try {
      await fetchAccessToken();
      return { reachable: true, ipWhitelisted: true, hint: '微信 API 连接正常，当前出口 IP 已在白名单。' };
    } catch (error) {
      if (error instanceof WeChatApiError) {
        if (error.classification === 'NETWORK') {
          return { reachable: false, hint: error.hint ?? NETWORK_HINT };
        }
        if (error.classification === 'IP_WHITELIST') {
          return {
            reachable: true,
            ipWhitelisted: false,
            errcode: error.errcode,
            hint: hintForClassification('IP_WHITELIST', extractExitIp(error.message)),
          };
        }
        return {
          reachable: true,
          errcode: error.errcode,
          hint: error.hint ?? hintForClassification(error.classification),
        };
      }
      return { reachable: false, hint: NETWORK_HINT };
    }
  }

  return {
    fetchAccessToken,
    uploadContentImage,
    uploadThumbMaterial,
    addDraft,
    pushDraft,
    diagnose,
  };
}
