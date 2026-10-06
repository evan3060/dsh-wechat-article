/**
 * M0 闸门 5 回归测试：rc.2 客户端三处断裂。
 *
 * 每条断言都对应一个**实测确认**的 rc.2 契约，不是推断：
 *
 * 1. `conversationEvents` 服务**已删除**（rc.2 全仓 grep 0 命中），注册面改由
 *    `ctx.uiConversation.events` 提供。
 * 2. `conversation.chat.turnTail` 的 kind 由 **chain 变 list**
 *    （权威声明 dsh-client-ui-chat/lib/client.js:6855-6858
 *      `"conversation.chat.turnTail": { kind: "list", scope: "session" }`）。
 *    list 槽没有 select/priority；组件自己从 owner.turn 读数据判空。
 * 3. 所有 `slots.register` 必须包在 `ctx.slots.inject(<槽位>, cb)` 里
 *    （官方样板 dsh-client-ui-chat/lib/client.js:6865）。
 *
 * 这三处在迁移前**零测试覆盖**——旧测试只测已废弃的 chain 选择器，
 * 所以「745 全过」并不代表客户端能在 rc.2 上工作。本文件补上该覆盖。
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DeliverablesRow, type DeliverablesRowProps } from '@/client/chat/deliverables-row';

const SRC = new URL('../../src/client/', import.meta.url).pathname;
const read = (rel: string) => readFileSync(SRC + rel, 'utf8');
/** 只保留代码行：剔除 // 与 * 开头的注释行，避免把注释里的字面量算进去。 */
const readCode = (rel: string) =>
  read(rel)
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');

describe('rc.2 断裂 1：conversationEvents 已删除，改走 uiConversation.events', () => {
  const chat = () => read('chat/register-chat.tsx');

  it('不再注入已删除的 conversationEvents 服务', () => {
    expect(chat()).not.toMatch(/inject\?\.\(\['conversationEvents'\]/);
    expect(chat()).toMatch(/inject\?\.\(\['uiConversation'\]/);
  });

  it('注册面从 subCtx.uiConversation.events 取，不再是 subCtx.conversationEvents', () => {
    expect(chat()).toMatch(/subCtx\.uiConversation\?\.events/);
    expect(chat()).not.toMatch(/subCtx\.conversationEvents\b/);
  });

  it('本地窄面声明已同步（context.ts 暴露 uiConversation.events）', () => {
    const ctx = read('lib/context.ts');
    expect(ctx).toMatch(/uiConversation\?:/);
    expect(ctx).toMatch(/readonly events:/);
  });
});

describe('rc.2 断裂 2：turnTail 由 chain 变 list', () => {
  const chat = () => read('chat/register-chat.tsx');
  const ctx = () => read('lib/context.ts');

  it('注册用 list 形状（id/order），不再有 chain 的 select/priority', () => {
    expect(chat()).toMatch(/name: 'conversation\.chat\.turnTail', id: 'wechat-article', order: 100/);
    // 旧 chain 字段从**代码**里消失（注释里提及历史形状不算）
    const code = readCode('chat/register-chat.tsx');
    const at = code.indexOf("name: 'conversation.chat.turnTail'");
    expect(at, '应存在 turnTail 注册').toBeGreaterThan(-1);
    const registration = code.slice(Math.max(0, at - 200), at + 200);
    expect(registration, '注册参数不应含 select').not.toMatch(/\bselect\s*:/);
    expect(registration, '注册参数不应含 priority').not.toMatch(/\bpriority\s*:/);
  });

  it('窄面声明的 turnTail 选项也是 list 形状', () => {
    expect(ctx()).toMatch(/name: 'conversation\.chat\.turnTail';\s*\n\s*readonly id: string;/);
  });

  it('组件自己从 owner.turn 读数据：无数据返回 null（等价的零成本挂载）', () => {
    const owner = (data?: unknown) => ({ turn: { data: { get: () => data } } });
    // 空 / 缺字段 / 空数组 → 不渲染
    expect(DeliverablesRow({ turn: undefined } as DeliverablesRowProps)).toBeNull();
    expect(DeliverablesRow(owner(undefined) as DeliverablesRowProps)).toBeNull();
    expect(DeliverablesRow(owner({}) as DeliverablesRowProps)).toBeNull();
    expect(DeliverablesRow(owner({ articles: [] }) as DeliverablesRowProps)).toBeNull();
  });

  it('有数据时渲染产物行（rc.2 list 条目走 owner 面，不靠 matched 注入）', () => {
    const article = {
      articleId: 'a1',
      title: '测试稿',
      status: 'rendered' as const,
      statusLabel: '成稿',
      updatedAt: '2026-10-06T00:00:00Z',
    };
    const el = DeliverablesRow({
      turn: { data: { get: () => ({ articles: [article] }) } },
      t: (k: string) => k,
    } as unknown as DeliverablesRowProps);
    expect(el, '有数据时应渲染').not.toBeNull();
  });
});

describe('rc.2 断裂 3：槽位注册必须包 slots.inject', () => {
  const files = ['index.tsx', 'chat/register-chat.tsx', 'composer/register-composer.tsx'];

  it('每个源文件的每个 register 都有对应 inject 包裹', () => {
    for (const rel of files) {
      const src = readCode(rel);
      const registers = (src.match(/ctx\.slots\.register\(/g) || []).length;
      const injects = (src.match(/ctx\.slots\.inject\(/g) || []).length;
      expect(registers, `${rel}: register 数`).toBeGreaterThan(0);
      expect(injects, `${rel}: inject 数应与 register 数一致`).toBe(registers);
    }
  });

  it('窄面声明暴露 slots.inject', () => {
    expect(read('lib/context.ts')).toMatch(/inject\(slot: string, callback: \(\) => unknown\): \(\) => void;/);
  });

  it('没有裸 register 残留（任何 register 都在 inject 回调内）', () => {
    for (const rel of files) {
      const src = readCode(rel);
      // 每个 register 之前应能遇到 inject（容忍换行）
      let idx = -1;
      while ((idx = src.indexOf('ctx.slots.register(', idx + 1)) !== -1) {
        const before = src.slice(Math.max(0, idx - 160), idx);
        expect(before, `${rel} @${idx} 附近的 register 前应有 inject`).toMatch(/ctx\.slots\.inject\(/);
      }
    }
  });
});

describe('闸门 4：工具定义带 output.schema（rc.2 JSON-Schema-first）', () => {
  it('产物里存在 output.schema 形状', () => {
    const idx = process.cwd();
    const lib = readFileSync(`${idx}/lib/index.js`, 'utf8');
    expect(lib).toMatch(/output\s*:\s*\{\s*schema/);
  });
});

describe('回归护栏：降级路径仍可用', () => {
  it('safeRegister 的 try/catch 保留（槽缺失时降级不崩）', () => {
    const src = read('chat/register-chat.tsx');
    expect(src).toMatch(/warnDegraded/);
    expect(vi.isMockFunction(vi.fn())).toBe(true); // 保持 vitest 导入被使用
  });
});