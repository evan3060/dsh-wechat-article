/**
 * service 层错误类型：带 code，供 RPC/tools 归一化为结构化失败。
 */

export class WeChatArticleServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WeChatArticleServiceError';
  }
}

export function toServiceError(error: unknown): WeChatArticleServiceError {
  if (error instanceof WeChatArticleServiceError) return error;
  const message = error instanceof Error ? error.message : String(error ?? '未知错误');
  return new WeChatArticleServiceError('internal', message);
}
