import type { ComponentType } from 'react';
import type { ClientContext, CommandRowOwnerPropsLike, InputTriggersServiceLike, InputZonePropsLike } from '../lib/context';
import type { WeChatArticleRpc } from '../lib/rpc';
import { WeChatArticleComposerButton } from './wechat-article-button';
import { WeChatArticleCommandRow } from './commandview-wechat-article';
import { createWeChatArticleAtSource } from './at-source';

/**
 * M3 composer 装配（architecture §3 M3 / §6 D7-D10，各自独立 try/catch）：
 * - conversation.input.right「写作」按钮（D7：槽缺失 → 无按钮，/wechat-article 仍可用）。
 * - conversation.chat.commandview keyed 'wechat-article'（宿主 GenericCommandCard 兜底）。
 * - ctx.inputTriggers.registerSource（D10：服务缺失 → 无 @ 源，手输仍可用）。
 */

function warnDegraded(action: string, error: unknown): void {
  console.warn(`[dsh-wechat-article] ${action} 失败，已降级跳过`, error);
}

export function registerComposer(ctx: ClientContext, rpc: WeChatArticleRpc): void {
  const disposers: Array<() => void> = [];
  const safeRegister = (label: string, register: () => () => void): void => {
    try {
      const dispose = register();
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      warnDegraded(label, error);
    }
  };

  safeRegister('slots.register（conversation.input.right）', () =>
    ctx.slots.register(
      { name: 'conversation.input.right', id: 'wechat-article', order: 100 },
      WeChatArticleComposerButton as ComponentType<InputZonePropsLike>,
    ),
  );

  const CommandRowAdapter = function WeChatArticleCommandview(props: CommandRowOwnerPropsLike) {
    return <WeChatArticleCommandRow node={props.node} rpc={rpc} />;
  };
  safeRegister('slots.register（conversation.chat.commandview wechat-article）', () =>
    ctx.slots.register({ name: 'conversation.chat.commandview', key: 'wechat-article' }, CommandRowAdapter),
  );

  // D10：inputTriggers 经 ctx.inject 动态子 fiber 探测（P0-1 修复方案 b，理由见
  // register-chat.tsx 的 conversationEvents 块注释：rc.7 cordis 不解析静态 inject 的
  // `?` 后缀，静态声明会让整个 client 永久 pending；动态子 fiber 缺服务时休眠，
  // 不进 boot sweep，composer 按钮与命令行注册零影响）。
  try {
    ctx.inject?.(['inputTriggers'], function wechatArticleAtSourceRegister(subCtx: ClientContext) {
      const triggers = (subCtx as ClientContext & { readonly inputTriggers?: InputTriggersServiceLike }).inputTriggers;
      if (!triggers || typeof triggers.registerSource !== 'function') return; // 防御
      const dispose = triggers.registerSource(createWeChatArticleAtSource(rpc));
      subCtx.effect(() => dispose, 'wechat-article-at-source');
    });
  } catch (error) {
    warnDegraded('ctx.inject（inputTriggers）', error);
  }

  if (disposers.length > 0) {
    ctx.effect(
      () => () => {
        disposers.forEach((dispose) => dispose());
      },
      'wechat-article-composer',
    );
  }
}
