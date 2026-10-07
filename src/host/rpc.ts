/**
 * 写作台 HTTP 适配层（架构 §3：薄，只做 payload 校验 + 转发 service + 响应形状复核）。
 *
 * [rc.2] 旧的「通道 authority=loopback」约定随 rpc.handle 弃用一并移除：当前走
 * `connection.fetch` 精确路由面，鉴权与来源围栏由宿主 /api 通道统一施加
 * （connection 的 admit()/requestRejection 对每条 /api 请求生效），
 * 插件侧不再自带通道级 authority 概念。详见 registerWeChatArticleRpc 的注释。
 */

import {
  API_PREFIX,
  RPC_ENDPOINTS,
  rpcContract,
  type RunParams,
  type RpcEndpoint,
} from '../shared/contract';
import type { ConnectionFetchService, HostLogger } from './platform';
import type { WeChatArticleService } from './service';

type ContractEntry = { readonly request: { safeParse(input: unknown): { success: boolean; data?: unknown; error?: { issues: { path: (string | number)[]; message: string }[] } } }; readonly response: { safeParse(input: unknown): { success: boolean; data?: unknown; error?: { issues: { path: (string | number)[]; message: string }[] } } } };

/** dispatch 的宽松 payload 面（request schema 已校验，这里只取字段）。 */
interface RpcPayload {
  readonly id?: string;
  readonly runId?: string;
  readonly callId?: string;
  readonly articleId?: string;
  readonly enabled?: boolean;
  readonly limit?: number;
  readonly rank?: number;
  readonly url?: string;
  readonly ref?: string;
  readonly value?: string;
  readonly params?: RunParams;
  readonly slug?: string;
  readonly title?: string;
  readonly digest?: string;
  readonly markdown?: string;
  readonly text?: string;
  readonly instruction?: string;
  readonly theme?: string;
  readonly name?: string;
  readonly rrule?: string;
  readonly timeZone?: string;
}

async function dispatch(service: WeChatArticleService, endpoint: RpcEndpoint, payload: RpcPayload): Promise<unknown> {
  switch (endpoint) {
    case 'snapshot':
      return service.snapshot();
    case 'hotspots/fetch':
      return service.fetchHotspots(payload.limit ?? 20);
    case 'hotspots/digestItem':
      return service.digestHotspotItem({
        rank: Number(payload.rank),
        title: String(payload.title),
        url: String(payload.url),
      });
    case 'article/list':
      return service.listArticles();
    case 'article/get':
      return service.getArticle(String(payload.id));
    case 'article/save':
      return service.saveArticle({
        ...(payload.id ? { id: payload.id } : {}),
        slug: String(payload.slug),
        title: String(payload.title),
        digest: String(payload.digest),
        markdown: String(payload.markdown),
        theme: String(payload.theme),
      });
    case 'article/delete':
      return service.deleteArticle(String(payload.id));
    case 'article/preview':
      return service.previewArticle(
        payload.id ? { id: payload.id } : { markdown: String(payload.markdown), theme: String(payload.theme) },
      );
    case 'article/rewrite':
      return service.rewriteText({
        text: String(payload.text),
        instruction: String(payload.instruction),
        ...(payload.title !== undefined ? { title: String(payload.title) } : {}),
      });
    case 'run/start':
      return service.startRun({
        trigger: 'manual',
        params: payload.params as RunParams,
        ...(payload.articleId ? { articleId: payload.articleId } : {}),
      });
    case 'run/cancel':
      return service.cancelRun(String(payload.runId));
    case 'run/detail':
      // runId/callId 二选一（M2 运行卡 callId 兜底链）；request schema 已保证其一非空
      return service.runDetail(payload.runId ? { runId: String(payload.runId) } : { callId: String(payload.callId) });
    case 'schedule/save':
      return service.saveSchedule({
        ...(payload.id ? { id: payload.id } : {}),
        name: String(payload.name),
        rrule: String(payload.rrule),
        timeZone: String(payload.timeZone),
        params: payload.params as RunParams,
        enabled: Boolean(payload.enabled),
      });
    case 'schedule/delete':
      return service.deleteSchedule(String(payload.id));
    case 'schedule/toggle':
      return service.toggleSchedule(String(payload.id), Boolean(payload.enabled));
    case 'schedule/runNow':
      return service.runScheduleNow(String(payload.id));
    case 'config/get':
      return service.getConfig();
    case 'config/set':
      return service.setConfig(payload as unknown as Record<string, unknown>);
    case 'credentials/set':
      return service.setCredential(String(payload.ref), String(payload.value));
    case 'credentials/describe':
      return service.describeCredentials();
    case 'llm/options':
      return service.listLlmOptions();
    case 'wechat/pushDraft':
      return service.pushArticleDraft(String(payload.articleId));
    case 'wechat/diagnose':
      return service.diagnoseWeChat();
    default:
      throw new Error(`未知端点：${endpoint satisfies never}`);
  }
}

/**
 * 平台契约（P0，2026-08-20 QA 实测确诊）：DSH 宿主 dsh-client-connection 的
 * rpcResultSchema 对 result 做联合校验，error.code 必须落在宿主 rpcErrorSchema 的
 * code 枚举内，且**每个分支都必填 details 字段**（枚举清单从宿主包实测核对：
 * ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-connection/lib/client.js 的
 * rpcErrorSchema discriminatedUnion，共 39 个——bad-request / cancelled /
 * session-not-found / model-unavailable / session-conflict / invalid-time-zone /
 * workspace-attach-failed / workspace-not-found / workspace-invalid-path /
 * workspace-name-conflict / workspace-move-invalid / directory-unreadable /
 * directory-exists / directory-create-failed / directory-picker-unavailable /
 * agent-preset-read-only / agent-preset-locked / agent-preset-conflict /
 * agent-preset-not-found / agent-preset-invalid / agent-busy / attachment-error /
 * queue-item-not-found / steer-unavailable / command-error / unknown-command /
 * settings-rejected / settings-conflict / credential-rejected /
 * model-discovery-failed / title-invalid / fork-unavailable /
 * subagent-parent-unavailable / subagent-not-found / subagent-catalog-diagnostic /
 * subagent-not-resumable / subagent-unauthorized / subagent-delivery-unavailable /
 * internal）。
 * 除 internal / cancelled / command-error / unknown-command 四个 details:object({})
 * 分支外，其余分支的 details 都带必填结构化字段（如 bad-request 要 {issues:[]}、
 * session-not-found 要 {sessionId}），插件侧无法恒满足。插件自有码
 * （PI_AI_ERROR / digest-timeout / llm-not-configured / …）不在枚举内 → 宿主整包
 * 拒收，zod invalid_union 全文（~1.7KB）直接泄漏成用户看到的错误消息
 * （tests/e2e/artifacts/qa-digest/qa-digest-report.json item-01）。
 * 收敛策略：信封 code 统一 'internal' + details:{}（恒过校验），真实 code 以
 * '[code] ' 前缀保留进 message——客户端按 message 展示，前端按前缀映射错误文案。
 */
/** 宿主枚举内且 details 形状插件恒能满足的 code（details: object({}) 分支）。 */
const HOST_RPC_ERROR_CODE = 'internal';

/** 插件错误 → 宿主白名单错误信封：code 收敛 internal，真实 code 进 message 前缀。 */
function toHostRpcErrorEnvelope(
  error: unknown,
  truncate: (text: string) => string,
): { ok: false; error: { code: typeof HOST_RPC_ERROR_CODE; message: string; details: Record<string, never> } } {
  const rawCode = typeof (error as { code?: unknown })?.code === 'string' && (error as { code?: unknown }).code
    ? (error as { code: string }).code
    : 'rpc-failed';
  const message = truncate(error instanceof Error ? error.message : String(error));
  return {
    ok: false,
    error: {
      code: HOST_RPC_ERROR_CODE,
      message: rawCode === HOST_RPC_ERROR_CODE ? message : `[${rawCode}] ${message}`,
      details: {},
    },
  };
}

/**
 * 注册写作台的 Web 面板端点（rc.2 走 `connection.fetch.register` 精确路由面）。
 *
 * [rc.2] 为什么不再用 `rpc.handle(channel, …)`（实测定位，勿轻易回退）：
 *   ① handle：宿主实现内部执行 `owner.webServer.register(route)`
 *      （dsh-client-connection/lib/index.js:640-656），而 `owner` 来自
 *      `get rpc() { const owner = this.ctx }` —— 那是 **connection 服务自己 fiber**
 *      的 ctx。该 fiber 自 **0.1.5-rc.1（2026-09-10）** 起不再声明 webServer 依赖
 *      （对照实测：0.1.2-rc.1 的 inject 是 ['webServer','credentials']，
 *        0.1.5-rc.1 起只剩 ['credentials']）→ 抛
 *        `cannot get property "webServer" without inject`。
 *      在插件自己的 inject 里补 webServer **无效**（实测已证）。
 *   ② intercept('/api', …)：/api 是**独占**槽（同文件 :666
 *      `if (this.interceptors.has(channel)) throw`），已被宿主 dsh-api-gateway 占用。
 *   ③ Typert：本地端点注册表 TypertLocalRegistry 只有 get/hasSeen/list/subscribe，
 *      **无 register**；本地端点仅能由代码生成的 Typert 包贡献（需 model+codec），
 *      普通插件拿不到。且 /api interceptor 独占，无路由可承接。
 *
 * 改用 `connection.fetch.register`：精确 Fetch 路由面，只要求 path 在 /api 之下、
 * 每段匹配 /^[A-Za-z0-9_$.-]+$/、methods 非空不重复；无独占限制、不依赖 webServer，
 * 且匹配优先于 /api 的 RPC interceptor。四个官方插件在用（session-controller /
 * session-log-export / ui-deliverables / file-upload）。
 *
 * 代价：fetch 面是**精确**路由（createSharedFetchHandler 用 fetchRoutes.get(pathname)
 * 查表），故 RPC_ENDPOINTS 的每个端点各注册一条路由，而非一条前缀路由。
 * 请求/响应信封 `{ok:true,value}` / `{ok:false,error:{code,message,details}}`
 * 与官方 fetch 路由逐字段一致（对照 dsh-client-file-upload 的 handleFileUploadHttp），
 * 故既有 dispatch + 双端 zod 校验 + 错误分类逻辑**原样保留**。
 */
export function registerWeChatArticleRpc(
  connection: { readonly fetch?: ConnectionFetchService } | undefined,
  service: WeChatArticleService,
  logger?: HostLogger,
): Promise<() => void> {
  if (!connection?.fetch) {
    logger?.warn('dsh-wechat-article: connection.fetch 服务缺失，Web 面板不可用（Agent 工具仍可用）');
    return Promise.resolve(() => undefined);
  }
  const truncate = (text: string): string => (text.length > 500 ? `${text.slice(0, 500)}…` : text);

  /** 单一端点的执行体：校验 → dispatch → 复核响应形状 → 包信封。 */
  const run = async (endpoint: string, payload: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, never> } }> => {
    const entry = (rpcContract as Record<string, ContractEntry | undefined>)[endpoint];
    if (!entry) throw new Error(`未知端点：${endpoint}`);
    const parsedRequest = entry.request.safeParse(payload ?? {});
    if (!parsedRequest.success || parsedRequest.data === undefined) {
      const issues = parsedRequest.error?.issues ?? [];
      throw new Error(`请求校验失败（${endpoint}）：${issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    }
    try {
      const result = await dispatch(service, endpoint as RpcEndpoint, parsedRequest.data as RpcPayload);
      const checked = entry.response.safeParse(result);
      if (!checked.success || checked.data === undefined) {
        const issues = checked.error?.issues ?? [];
        throw new Error(`响应形状漂移（${endpoint}）：${issues[0] ? `${issues[0].path.join('.')}: ${issues[0].message}` : '未知问题'}`);
      }
      return { ok: true as const, value: checked.data };
    } catch (error) {
      return toHostRpcErrorEnvelope(error, truncate);
    }
  };

  const disposers: Array<() => void | Promise<void>> = [];
  for (const endpoint of RPC_ENDPOINTS) {
    const path = `${API_PREFIX}/${endpoint}`;
    const stop = connection.fetch.register({
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 });
        }
        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return Response.json({ ok: false, error: { code: 'gateway/bad-request', message: 'body is not JSON', details: {} } }, { status: 400 });
        }
        return Response.json(await run(endpoint, payload));
      },
    });
    if (typeof stop === 'function') disposers.push(stop);
    else if (stop && typeof (stop as Promise<() => void>).then === 'function') disposers.push(() => void (stop as Promise<() => void>));
  }
  return Promise.resolve(() => {
    for (const dispose of disposers.reverse()) void dispose();
  });
}
