import type { Translate } from '../lib/context';
import { Icon } from '../components/Icon';
import { cardT } from './card-text';
import { WECHAT_ARTICLE_TURN_DATA_KEY } from './deliverables';
import type { WeChatArticleDeliverableArticle } from './deliverables';
import { isOverlayAvailable, openOverlayWithArticle } from './overlay-bridge';

/**
 * turnTail 产物行组件（architecture §5.1 / uiux §1.0，M2）。
 *
 * [rc.2] rc.2 变更：`conversation.chat.turnTail` 的 kind 由 **chain 变成 list**
 * （rc.2 权威声明：dsh-client-ui-chat/lib/client.js:6855-6858
 *   `"conversation.chat.turnTail": { kind: "list", scope: "session" }`）。
 * chain 时代靠 `select` 做 decline-before-mount、结果经 `matched` prop 注入；
 * list 槽不再有 select/matched，组件**自己**从 owner 的 turn 数据里读，并在无数据时
 * 返回 null（等价的零成本挂载）。owner 形状见 dsh-client-ui-chat renderSlot 调用：
 *   renderSlot("conversation.chat.turnTail", { turn, seq, openFile })
 *
 * 每行 = 文章标题 + 状态 chip（成稿/已推送）；点击 → openOverlayWithArticle
 * （AC-M2-04，overlayAvailable=false 时行降为纯文本）。
 */

export interface DeliverablesRowProps {
  /** turnTail owner 的 turn 面（rc.2 list 槽直接透传 owner）。 */
  readonly turn?: TurnFaceLike;
  readonly seq?: number;
  readonly openFile?: (path: string) => void;
  readonly t?: Translate;
}

/** owner.turn 的最小读取面（只取 data.get，避免依赖宿主完整类型）。 */
interface TurnFaceLike {
  readonly data?: { get(key: string): unknown };
}

export function DeliverablesRow({ turn, t }: DeliverablesRowProps) {
  const tt = cardT(t);
  const data = turn?.data?.get(WECHAT_ARTICLE_TURN_DATA_KEY) as { articles?: unknown } | undefined;
  const articles =
    data && typeof data === 'object' && Array.isArray(data.articles) && data.articles.length > 0
      ? (data.articles as WeChatArticleDeliverableArticle[])
      : null;
  if (!articles) return null;
  const clickable = isOverlayAvailable();
  return (
    <div className="wa-chatcard wa-chatcard--tail">
      <div className="wa-chatcard__tailhead">
        <Icon name="file-text" size={12} />
        <span className="wa-chatcard__kind">
          {tt('chat.deliverables')}（{articles.length}）
        </span>
      </div>
      <ul className="wa-chatcard__taillist">
        {articles.map((article) => (
          <li key={article.articleId} className="wa-chatcard__tailitem">
            {clickable ? (
              <button
                type="button"
                className="wa-chatcard__tailbtn"
                data-testid="wa-chatcard-tail-article"
                onClick={() => openOverlayWithArticle(article.articleId)}
              >
                <span className="wa-chatcard__title" title={article.title}>
                  《{article.title}》
                </span>
                <span className={article.state === 'pushed' ? 'wa-chatcard__chip wa-chatcard__chip--ok' : 'wa-chatcard__chip'}>
                  {article.state === 'pushed' ? tt('chat.state.pushed') : tt('chat.state.drafted')}
                </span>
              </button>
            ) : (
              <>
                <span className="wa-chatcard__title" title={article.title}>
                  《{article.title}》
                </span>
                <span className={article.state === 'pushed' ? 'wa-chatcard__chip wa-chatcard__chip--ok' : 'wa-chatcard__chip'}>
                  {article.state === 'pushed' ? tt('chat.state.pushed') : tt('chat.state.drafted')}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
