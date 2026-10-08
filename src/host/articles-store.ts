/**
 * 文章存取（service 拆分，单文件 <=300 行纪律）：
 * CRUD + 预览 + 管线产物落库（persistProduced）。写操作经注入的 serialize 串行化。
 */

import { randomUUID } from 'node:crypto';
import type { ArticleDetail, ArticleListItem, RunParams } from '../shared/contract';
import { convertArticle } from '../render/convert';
import { ArticleRecordSchema, type ImageRecord, type SettingsRecord } from './domain';
import type { DomainTables } from './store';
import type { RunStore } from './pipeline/engine';
import { articleToDetail, articleToListItem } from './views';
import { WeChatArticleServiceError } from './service-errors';
import { countImagePlaceholders, replaceImagePlaceholders } from './pipeline/image-placeholders';

export interface ArticleStoreDeps {
  readonly tables: DomainTables;
  readonly runStore: RunStore;
  readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly nowIso: () => string;
  readonly getSettings: () => SettingsRecord;
}

export class ArticleStore {
  constructor(private readonly deps: ArticleStoreDeps) {}

  list(): ArticleListItem[] {
    return [...this.deps.tables.articles.entries()]
      .map(([, record]) => record)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .map(articleToListItem);
  }

  get(id: string): ArticleDetail {
    const record = this.deps.tables.articles.get(id);
    if (!record) throw new WeChatArticleServiceError('article-not-found', `文章不存在：${id}`);
    return articleToDetail(record);
  }

  async save(input: { id?: string; slug: string; title: string; digest: string; markdown: string; theme: string }): Promise<ArticleDetail> {
    return this.deps.serialize(async () => {
      const now = this.deps.nowIso();
      const existing = input.id ? this.deps.tables.articles.get(input.id) : undefined;
      const record = ArticleRecordSchema.parse({
        v: 1,
        id: existing?.id ?? `art_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        slug: input.slug,
        title: input.title,
        digest: input.digest,
        status: existing?.status ?? 'editing',
        markdown: input.markdown,
        theme: input.theme,
        bodyImageIds: existing?.bodyImageIds ?? [],
        ...(existing?.coverImageId ? { coverImageId: existing.coverImageId } : {}),
        ...(existing?.wechatMediaId ? { wechatMediaId: existing.wechatMediaId } : {}),
        ...(existing?.thumbMediaId ? { thumbMediaId: existing.thumbMediaId } : {}),
        ...(existing?.lastRunId ? { lastRunId: existing.lastRunId } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      await this.deps.tables.articles.put(record.id, record);
      return articleToDetail(record);
    });
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    return this.deps.serialize(async () => ({ deleted: await this.deps.tables.articles.delete(id) }));
  }

  preview(input: { id: string } | { markdown: string; theme: string }): { html: string } {
    if ('id' in input) {
      const article = this.get(input.id);
      return { html: convertArticle({ markdown: article.markdown, theme: article.theme }) };
    }
    return { html: convertArticle({ markdown: input.markdown, theme: input.theme }) };
  }

  /** 管线渲染完成后落库：绑定 articleId 则更新，否则按成稿新建（slug/标题/摘要推导）。返回文章 id。 */
  async persistProduced(markdown: string, runId: string): Promise<string> {
    return this.deps.serialize(async () => {
      const now = this.deps.nowIso();
      const run = this.deps.runStore.get(runId);
      const existing = run?.articleId ? this.deps.tables.articles.get(run.articleId) : undefined;
      const record = ArticleRecordSchema.parse({
        v: 1,
        id: existing?.id ?? `art_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        slug: existing?.slug ?? `run-${runId.slice(4, 16)}`,
        // v0.5 标题硬绑：启动 brief 给定标题优先于成稿推导（给了就是最终标题）。
        title: existing?.title ?? run?.paramsSnapshot.brief?.title ?? deriveTitle(markdown),
        digest: existing?.digest ?? deriveDigest(markdown),
        status: 'rendered',
        markdown,
        theme: run?.paramsSnapshot.theme ?? this.deps.getSettings().defaultTheme,
        bodyImageIds: existing?.bodyImageIds ?? [],
        ...(existing?.coverImageId ? { coverImageId: existing.coverImageId } : {}),
        ...(existing?.wechatMediaId ? { wechatMediaId: existing.wechatMediaId } : {}),
        ...(existing?.thumbMediaId ? { thumbMediaId: existing.thumbMediaId } : {}),
        lastRunId: runId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      await this.deps.tables.articles.put(record.id, record);
      return record.id;
    });
  }

  /** images 步产物回绑（P0-1）：封面/正文图 id 写回文章记录——推送核心流的绑定链。 */
  async bindImages(
    articleId: string,
    bound: { readonly coverImageId?: string; readonly bodyImageIds: readonly string[] },
  ): Promise<void> {
    await this.deps.serialize(async () => {
      const record = this.deps.tables.articles.get(articleId);
      if (!record) return;
      const merged = ArticleRecordSchema.parse({
        ...record,
        coverImageId: bound.coverImageId ?? record.coverImageId,
        bodyImageIds: bound.bodyImageIds.length ? [...bound.bodyImageIds] : record.bodyImageIds,
        updatedAt: this.deps.nowIso(),
      });
      await this.deps.tables.articles.put(articleId, merged);
    });
  }

  /**
   * 正文配图占位替换（2026-10-08）：把 markdown 里的 `![alt](图片待生成)` 按
   * bodyImageIds 顺序换成 data URI。
   *
   * 为什么需要（实测因果链见 pipeline/image-placeholders.ts 头注释）：
   * llm.ts:185 的提示词要求 LLM 写占位符并声明「后续管线会替换」，但该替换从未实现，
   * 导致推送到微信的 content 里 `<img>` 数为 0——正文一张图都没有。
   *
   * 用 data URI 而非微信 URL：本地预览可直接显示；真实推送时
   * wechat/client.ts 的 replaceImageSources 会按出现顺序把这些 `<img src>`
   * 换成 `mmbiz.qpic.cn` 的 URL（微信正文不接受 base64）。两条路径共用同一批位置。
   *
   * @returns 实际替换处数；无占位符、文章不存在或图片缺失返回 0。
   */
  async replaceImagePlaceholders(articleId: string, bodyImageIds: readonly string[]): Promise<number> {
    const images = bodyImageIds
      .map((id) => this.deps.tables.images.get(id))
      .filter((image): image is ImageRecord => Boolean(image?.base64));
    if (!images.length) return 0;
    return this.deps.serialize(async () => {
      const record = this.deps.tables.articles.get(articleId);
      if (!record?.markdown) return 0;
      const before = countImagePlaceholders(record.markdown);
      if (!before) return 0;
      const replaced = replaceImagePlaceholders(record.markdown, images);
      const after = countImagePlaceholders(replaced);
      if (after === before) return 0;
      await this.deps.tables.articles.put(
        articleId,
        ArticleRecordSchema.parse({ ...record, markdown: replaced, updatedAt: this.deps.nowIso() }),
      );
      return before - after;
    });
  }
}

function deriveTitle(markdown: string): string {
  const heading = markdown.trim().match(/^#{0,2}\s*(.+)$/m);
  return (heading?.[1] ?? '未命名稿件').slice(0, 40);
}

function deriveDigest(markdown: string): string {
  return markdown.replace(/[#>*`\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 110);
}

export type { RunParams };
