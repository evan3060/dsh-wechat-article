import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * [rc.2] 装配层回归：RPC 注册失败**不得**阻断工具 / 命令 / 调度器注册。
 *
 * 背景（实测定位，2026-10-06）：
 *   rc.2 上 `registerWeChatArticleRpc` 必然抛错，两条注册路径都不可用——
 *     ① rpc.handle(channel, handler)：宿主实现内部取 `owner.webServer.register(route)`
 *        （dsh-client-connection/lib/index.js:640-656），owner 是 connection 服务
 *        **自己 fiber** 的 ctx，未声明 webServer → 抛
 *        `cannot get property "webServer" without inject`。
 *     ② rpc.intercept('/api', …)：/api 是独占槽（同文件 :666），已被宿主
 *        dsh-api-gateway 占用 → 抛 `shared RPC channel "/api" already has an interceptor`。
 *
 * 修复前该异常被 apply() 的**外层** catch 吞掉，导致紧随其后的
 * `registerAgentTools` / `registerWeChatArticleCommand` / `service.startScheduler()`
 * 全部未执行 —— 这才是「Agent 调不到 wechat_* 工具」的真根因。
 *
 * 修法：把 RPC 注册单独包一层 try/catch，让它降级而不阻断（wewrite「降级不崩」纪律）。
 * 本文件钉住这个行为，防止将来有人「顺手」把内层 catch 去掉。
 */

const SRC = new URL('../../src/host/', import.meta.url).pathname;
const read = (rel: string) => readFileSync(SRC + rel, 'utf8');

describe('[rc.2] RPC 降级隔离', () => {
  const index = () => read('index.ts');

  it('registerWeChatArticleRpc 调用被独立的 try/catch 包住', () => {
    const src = index();
    const at = src.indexOf('registerWeChatArticleRpc(');
    expect(at, '应存在 RPC 注册调用').toBeGreaterThan(-1);
    // 往回找最近的 "try {"，确认它在自己的 try 里，而不是直接裸调
    const before = src.slice(Math.max(0, at - 600), at);
    const innerTry = before.lastIndexOf('try {');
    const outerTry = before.lastIndexOf('try {', innerTry - 1);
    expect(innerTry, 'RPC 调用前应有一个 try').toBeGreaterThan(-1);
    expect(
      outerTry,
      'RPC 调用应有**独立**的 try（两个连续 try = 单独隔离），否则异常会阻断后续注册',
    ).toBeGreaterThan(-1);
  });

  it('内层 catch 明确说明「Agent 工具不受影响」', () => {
    expect(index()).toMatch(/Agent 工具不受影响/);
  });

  it('工具 / 命令 / 调度器注册在 RPC try 块**之外**（即不会被其异常跳过）', () => {
    const src = index();
    const rpcAt = src.indexOf('registerWeChatArticleRpc(');
    const toolsAt = src.indexOf('registerAgentTools(');
    const cmdAt = src.indexOf('registerWeChatArticleCommand(');
    const schedAt = src.indexOf('startScheduler()');
    expect(toolsAt).toBeGreaterThan(rpcAt);
    expect(cmdAt).toBeGreaterThan(rpcAt);
    expect(schedAt).toBeGreaterThan(rpcAt);
    // 三者都在同一个外层 try 内、RPC 内层 catch 之后
    const afterInnerCatch = src.indexOf('Agent 工具不受影响');
    expect(toolsAt, '工具注册应在 RPC 降级点之后').toBeGreaterThan(afterInnerCatch);
    expect(cmdAt, '命令注册应在 RPC 降级点之后').toBeGreaterThan(afterInnerCatch);
    expect(schedAt, '调度器启动应在 RPC 降级点之后').toBeGreaterThan(afterInnerCatch);
  });

  it('不再存在 RPC_AUTHORITY（rc.2 的 handle 没有第三个 options 参数）', () => {
    expect(read('rpc.ts')).not.toMatch(/RPC_AUTHORITY/);
    expect(index()).not.toMatch(/RPC_AUTHORITY/);
  });

  it('rpc.ts 用 handle 的 rc.2 两参形状（无 authority 第三参）', () => {
    const src = read('rpc.ts');
    expect(src).toMatch(/rpc\.handle\(\s*RPC_CHANNEL,/);
    // 只看代码行：注释里保留 authority 的历史说明是合理的（记录 rc.7→rc.2 的迁移）
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code, '代码里不应再出现 authority 选项').not.toMatch(/authority/);
  });

  it('注释记录了两条被实测封死的路径（防止后人重走弯路）', () => {
    const src = read('rpc.ts');
    expect(src).toMatch(/webServer/);
    expect(src).toMatch(/already has an interceptor/);
  });
});

describe('[rc.2] rpc.handle 的运行期降级行为', () => {
  it('宿主抛错时 registerWeChatArticleRpc 让错误冒泡（由调用方隔离，而非静默成功）', async () => {
    const { registerWeChatArticleRpc } = await import('@/host/rpc');
    const boom = {
      handle: () => {
        throw new Error('cannot get property "webServer" without inject');
      },
      intercept: () => () => undefined,
    };
    const service = {} as never;
    // 错误必须冒泡给调用方 —— 否则 index.ts 的内层 catch 形同虚设
    expect(() => registerWeChatArticleRpc(boom as never, service)).toThrow(/webServer/);
  });

  it('rpc 服务缺失时仍降级为 no-op（不抛）', async () => {
    const { registerWeChatArticleRpc } = await import('@/host/rpc');
    const warn = vi.fn();
    await expect(registerWeChatArticleRpc(undefined, {} as never, { warn } as never)).resolves.toBeTypeOf(
      'function',
    );
    expect(warn).toHaveBeenCalled();
  });
});