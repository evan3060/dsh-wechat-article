import { useState } from 'react';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { ErrorNote, SkeletonBlock } from '../components/bits';
import { useStore } from '../store';
import { DisciplineSection, ProxySection, WechatSection } from './settings-sections';
import type { SettingsGroup } from './settings-sections';
import { ImagesSection, LlmSection } from './settings-models';

/**
 * 设置（DESIGN §9.6）：左栏 5 组竖导航 + 右侧内容区（每组一屏，避免长表单滚动迷失）。
 */

const GROUPS: ReadonlyArray<{ id: SettingsGroup; label: string; icon: IconName; hint: string }> = [
  { id: 'wechat', label: '公众号', icon: 'message-circle', hint: 'AppID / AppSecret / 作者名' },
  { id: 'llm', label: '模型服务', icon: 'cpu', hint: '复用宿主供应商与模型' },
  { id: 'images', label: '图片供应商', icon: 'image', hint: '9 家 fallback 链排序' },
  { id: 'proxy', label: 'API 代理', icon: 'globe', hint: '微信接口统一出口 + 连接测试' },
  { id: 'discipline', label: '发布纪律', icon: 'shield', hint: '草稿箱锁定，无自动群发' },
];

export function SettingsPanel() {
  const store = useStore();
  const { snapshot, rpc, refreshSnapshot } = store;
  const [group, setGroup] = useState<SettingsGroup>('wechat');

  return (
    <div className={store.narrow ? 'wa-settings wa-settings--narrow' : 'wa-settings'}>
      {!store.narrow ? (
        <nav className="wa-settings__nav" aria-label="设置分组">
          {GROUPS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={group === item.id ? 'wa-settings__nav-item wa-settings__nav-item--active' : 'wa-settings__nav-item'}
              aria-current={group === item.id ? 'true' : undefined}
              onClick={() => setGroup(item.id)}
            >
              <Icon name={item.icon} size={16} />
              <span className="wa-settings__nav-label">{item.label}</span>
              <span className="wa-settings__nav-hint">{item.hint}</span>
            </button>
          ))}
        </nav>
      ) : (
        <nav className="wa-settings__nav wa-settings__nav--row" aria-label="设置分组">
          {GROUPS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={group === item.id ? 'wa-settings__chip wa-settings__chip--active' : 'wa-settings__chip'}
              aria-current={group === item.id ? 'true' : undefined}
              onClick={() => setGroup(item.id)}
            >
              <Icon name={item.icon} size={16} />
              {item.label}
            </button>
          ))}
        </nav>
      )}
      <div className="wa-settings__content">
        {snapshot.status === 'loading' ? (
          <SkeletonBlock lines={5} />
        ) : snapshot.status === 'error' ? (
          <ErrorNote title="设置读取失败（存储不可用）。" action={<button type="button" className="wa-link" onClick={() => void refreshSnapshot()}>重试</button>} />
        ) : group === 'wechat' ? (
          <WechatSection config={snapshot.data.config} rpc={rpc} onSaved={refreshSnapshot} />
        ) : group === 'llm' ? (
          <LlmSection config={snapshot.data.config} rpc={rpc} onSaved={refreshSnapshot} />
        ) : group === 'images' ? (
          <ImagesSection config={snapshot.data.config} rpc={rpc} onSaved={refreshSnapshot} />
        ) : group === 'proxy' ? (
          <ProxySection config={snapshot.data.config} rpc={rpc} onSaved={refreshSnapshot} />
        ) : (
          <DisciplineSection />
        )}
      </div>
    </div>
  );
}
