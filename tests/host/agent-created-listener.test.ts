/**
 * M0 闸门 3（B3）回归测试：agent/created 监听器绝不能让宿主 agent 创建失败。
 *
 * ── 契约来源（rc.2 实测，非推断）────────────────────────────────────────────
 * `@deepseek-ai/dsh-agent@0.2.0-rc.2` `lib/types/index.d.ts:288-290` 逐字：
 *   "Register a live agent with source `startup`. **Rejects if the id is already
 *    registered or a serial `agent/created` listener fails.**"
 * 即 agent/created 是**串行**监听，且监听器抛错会让 `agents.register()` reject。
 * 官方 README.zh.md:108 也写明「等待 register() 以 startup 来源完成串行创建监听器」。
 *
 * ── 因此本文件钉死的不变量 ───────────────────────────────────────────────────
 * 我们在 `agent/created` 上的监听器**在任何输入下都不得抛出**，否则会把宿主
 * 自己的 agent 创建链一起打挂。判据是：用一个「注册必炸」的 agent 触发监听器后，
 * 监听器调用本身必须正常返回（不 throw），而不是把错误冒泡给宿主。
 *
 * 为什么不用 `CreateAgentOptions.setup`（闸门 3 原计划）：
 * `setup` 是 **create() 调用方**传入的字段（`CreateAgentOptions.setup` /
 * `ResumeAgentOptions.setup`），宿主创建 agent 时不会传我们的 setup，工具反而挂不上。
 * 且 `agent/created` 并未被废弃——rc.2 里 dsh-schedule / dsh-api-session-controller /
 * dsh-tool-subagent / dsh-hooks-codex 等官方插件仍在用（README.zh.md:177 另有约束：
 * 监听器不得 await `agent.whenIdle()` 或自身 owner 的 dispose）。
 */

import { describe, expect, it, vi } from 'vitest';
import { registerAgentTools } from '@/host/agent-tools';
import type { WeChatArticleService } from '@/host/service';
import { makeAgent, makeCtx } from './agent-tools.test';
import { makeFakeService } from './agent-tools.test';

type EventListener = (...args: unknown[]) => unknown;

/** 取一次干净装配后 `agent/created` 的监听器。 */
function createdListener(): EventListener {
  const harness = makeCtx({ agents: [makeAgent('agent_root')] });
  registerAgentTools(harness.ctx, makeFakeService() as unknown as WeChatArticleService, { enabled: true });
  const listener = harness.listeners.get('agent/created');
  expect(listener, '应订阅 agent/created').toBeTypeOf('function');
  return listener as EventListener;
}

describe('B3：agent/created 监听器不得抛出（B3-r1）', () => {
  it('B3-r1-a: 正常 agent → 监听器返回 undefined，不抛', () => {
    const listener = createdListener();
    const agent = makeAgent('agent_ok');
    expect(() => listener({ agent: agent.agent })).not.toThrow();
    expect(agent.registered).toHaveLength(5);
  });

  it('B3-r1-b: tools.register 抛错 → 监听器吞掉错误仍正常返回（宿主创建链不被牵连）', () => {
    const listener = createdListener();
    const boom = makeAgent('agent_boom', () => {
      throw new Error('宿主 tools seam 不可用');
    });
    // 关键断言：监听器**不 throw**。若冒泡，rc.2 的 agents.register() 会 reject，
    // 进而让全应用无法创建任何 agent。
    expect(() => listener({ agent: boom.agent })).not.toThrow();
    // 既定语义：mount() 的 register 循环在首个抛错处中断（一个坏工具不级联），
    // 因此这里只尝试了第 1 个工具就进了 catch。
    expect(boom.register, '首个 register 抛错后循环中断').toHaveBeenCalledTimes(1);
  });

  it('B3-r1-c: register 返回非函数（宿主 seam 形态异常）→ 不抛', () => {
    const listener = createdListener();
    const weird = makeAgent('agent_weird', () => undefined);
    expect(() => listener({ agent: weird.agent })).not.toThrow();
    expect(weird.register).toHaveBeenCalledTimes(5);
  });

  it('B3-r1-d: 事件载荷里没有 agent 字段 → 静默跳过，不抛', () => {
    const listener = createdListener();
    expect(() => listener({})).not.toThrow();
    expect(() => listener({ agent: undefined })).not.toThrow();
    // 空载荷也算：修复前 `(event as {agent?}).agent` 会在 undefined 上抛 TypeError，
    // 而 B3 意味着这会让宿主的 agents.register() 失败 → 全应用无法建 agent。
    expect(() => listener(undefined)).not.toThrow();
    expect(() => listener(null)).not.toThrow();
  });

  it('B3-r1-e: 载荷里的 agent 缺 ctx.tools → 不抛（不假设宿主形状）', () => {
    const listener = createdListener();
    expect(() => listener({ agent: { id: 'agent_bare' } })).not.toThrow();
    expect(() => listener({ agent: { id: 'agent_nullctx', ctx: null } })).not.toThrow();
  });

  it('B3-r1-f: agent.id 是 Symbol 等非字符串 → 不抛（字符串化不炸）', () => {
    const listener = createdListener();
    const sym = Symbol('agent_id');
    expect(() => listener({ agent: { id: sym, ctx: { tools: { register: vi.fn() } } } })).not.toThrow();
  });
});

describe('B3：闸门关闭时不注册（不得因闸门抛错）', () => {
  it('B3-r2: 闸门关闭 → 零装配零 disposer，且不订阅监听器', () => {
    // 闸门读法见 src/host/agent-tools/index.ts:26 readGate —— service.agentToolsEnabled()
    // 是**方法**且优先；fake 没有该面时回落 options.enabled。
    const harness = makeCtx({ agents: [makeAgent('agent_root')] });
    const disposers = registerAgentTools(
      harness.ctx,
      makeFakeService() as unknown as WeChatArticleService,
      { enabled: false },
    );
    expect(disposers, '闸门关死且无翻转面 → 零装配零 disposer').toEqual([]);
    expect(harness.listeners.get('agent/created')).toBeUndefined();
  });

  it('B3-r3: 动态闸门初值 false → 监听器已订阅但安全；翻 true 后恢复注册', () => {
    // 带 onAgentToolsChanged 面的真 service：即使初值 false 也装配骨架（等热恢复），
    // 此时 agent/created 是**已订阅**的，必须验证它在该状态下依然安全。
    const base = makeFakeService() as unknown as Record<string, unknown>;
    const listeners: Array<(value: boolean) => void> = [];
    let enabled = false;
    const service = {
      ...base,
      agentToolsEnabled: () => enabled,
      onAgentToolsChanged: (listener: (value: boolean) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
    };
    const harness = makeCtx({ agents: [makeAgent('agent_root')] });
    registerAgentTools(harness.ctx, service as unknown as WeChatArticleService, { enabled: true });
    const listener = harness.listeners.get('agent/created');
    expect(listener, '动态闸门面下应已订阅监听器').toBeTypeOf('function');

    const late = makeAgent('agent_late');
    expect(() => (listener as EventListener)({ agent: late.agent })).not.toThrow();
    expect(late.registered, '闸门 false → 不注册').toHaveLength(0);

    enabled = true;
    for (const fn of listeners) fn(true);
    expect(() => (listener as EventListener)({ agent: late.agent })).not.toThrow();
    expect(late.registered, '闸门翻 true → 恢复注册 5 个').toHaveLength(5);
  });
});
