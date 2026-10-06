import type { ReactNode } from 'react';

/**
 * 编辑器底部状态栏信息带（StatusStrip，DESIGN §4.2）。
 * 全等宽：字数 · 门禁分 · 图 N/N · 模型名 + 保存状态（工程编辑风签名）。
 */

export function StatusStrip({ items, saveState, onRetrySave }: { items: readonly ReactNode[]; saveState: 'idle' | 'saving' | 'saved' | 'error'; onRetrySave: () => void }) {
  return (
    <footer className="wa-statusstrip">
      <div className="wa-statusstrip__info">
        {items.map((item, index) => (
          <span key={index} className="wa-statusstrip__item">
            {index > 0 ? <span className="wa-statusstrip__sep">·</span> : null}
            {item}
          </span>
        ))}
      </div>
      <div className="wa-statusstrip__save">
        {saveState === 'saving' ? '保存中…' : null}
        {saveState === 'saved' ? '已自动保存' : null}
        {saveState === 'error' ? (
          <>
            <span className="wa-statusstrip__save-error">保存失败 · 网络不可用</span>
            <button type="button" className="wa-statusstrip__retry" onClick={onRetrySave}>
              重试保存
            </button>
          </>
        ) : null}
      </div>
    </footer>
  );
}
