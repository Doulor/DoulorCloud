/**
 * 「商汤日日新 Key 捐献」通道。
 *
 * 与 `donation-provision.ts` 的 AI 渠道捐献是**两条不同的路**，别混：
 *
 *   - AI 渠道捐献：用户提供 baseUrl + key，我们要**逐个模型真实调用**验证，
 *     通过后**新建一个渠道**、给模型加 `donation-` 前缀，并发放额度与首捐券。
 *   - 商汤 Key 捐献：用户只提供**一个 Key**，上游地址与「Key 并进哪个渠道」
 *     都由管理面板配置（用户不能自带 —— 这本身就保证了「这个 Key 属于商汤」：
 *     只有真 Key 才能通过 token.sensenova.cn 鉴权）。校验方式只是拉一次
 *     `/v1/models` 看返回码；通过后把 Key **追加进管理员已有的那个多密钥渠道**。
 *     只解锁权限，**不发额度、不发券**（门槛太低，见 handlers/donations.ts 的
 *     grantRewards）。
 *
 * 为什么是「追加进已有渠道」而不是「新建渠道」（2026-09-25 改）：
 *   原先每笔捐献都会新建一个 tag=商汤 的渠道（「商汤01」「商汤02」…），模型名与
 *   管理员自建的商汤渠道完全相同，靠「同 group 内同名多渠道负载均衡」模拟「加入
 *   号池」。但站长实际用的是**一个多密钥渠道**（NewAPI 原生支持：`key` 字段里
 *   换行分隔多把 Key，轮询使用、某把坏了单独跳过），他要的就是「新 Key 进那个
 *   渠道」，而不是凭空多出一堆渠道条目。
 *
 *   所以现在：**只追加 Key，绝不新建渠道，也绝不碰渠道的模型列表**
 *   （模型由管理员手工维护）。
 *
 * 已实测确认的事实（决定了这里的形态）：
 *   - 商汤 Key **没有固定前缀**（不是 `sk-` 开头），所以**不能靠格式校验**，
 *     只能真调一次接口看返回码。
 *   - `GET https://token.sensenova.cn/v1/models`：带假 Key → 401；不带 Key → 401；
 *     **不存在的路径 → 404**。所以 401 vs 404 可区分「Key 无效」与「地址配错」。
 *   - 商汤是 OpenAI 兼容格式 → NewAPI 渠道类型用 1（只在旧路径「新建渠道」时用到）。
 *   - 商汤没有程序化获取 Key 的接口，只能去控制台手动创建。
 *   - 追加 Key 走 `PUT /api/channel/` 的 `key_mode: "append"`（已对 NewAPI
 *     v1.0.0-rc.40 源码核对：服务端自己读原 Key、去重、换行拼接）。为什么要用
 *     append、有哪些坑，见 newapi-client.ts 的 `appendChannelKey`。
 */
import { assertPublicHttpUrl } from "./url-guard"
import type { Env } from "./env"
import {
  extractModelIds,
  normalizeBaseUrl,
  type ProvisionResult,
} from "./donation-provision"
import {
  appendChannelKey,
  deleteChannelKey,
  getChannel,
  listChannelKeyStatus,
  type NewApiChannel,
  type NewApiChannelKeyStatus,
} from "./newapi-client"

/** 商汤控制台（Key 只能手动创建，没有程序化接口，只能给跳转链接） */
export const SENSENOVA_CONSOLE_URL = "https://platform.sensenova.cn/console"

/** 探测超时（毫秒）。只发一次请求，给足时间但不至于拖住提交。 */
const SENSENOVA_PROBE_TIMEOUT_MS = 12000

export type SenseNovaProbeResult =
  | { ok: true; models: string[] }
  | {
      ok: false
      /** invalid_key：Key 无效/无权限；bad_url：地址配错；network：其余（含超时） */
      kind: "invalid_key" | "bad_url" | "network"
      message: string
    }

/**
 * 验证商汤 Key：`GET {base}/v1/models` + `Authorization: Bearer`。
 *
 * 这是**唯一可靠**的校验手段 —— 商汤 Key 无固定前缀，格式校验没有意义。
 *
 * 判据（实测）：
 *   - 200 且有模型 → 有效
 *   - 401 / 403    → Key 无效或无权限（`invalid_key`）
 *   - 404          → 地址配错（`bad_url`，比如管理面板里填错了域名）
 *   - 其余         → `network`（超时、5xx、连接失败 —— 不怪用户，可稍后重试）
 *
 * `baseUrl` 来自管理面板配置而非用户输入，但仍做一次公网地址校验：
 * 这是服务端向任意地址发请求的 SSRF 面，纵深防御比事后排查便宜。
 */
export async function probeSenseNova(
  baseUrl: string,
  apiKey: string
): Promise<SenseNovaProbeResult> {
  const key = (apiKey ?? "").trim()
  if (!key) return { ok: false, kind: "invalid_key", message: "请填写商汤 API Key" }

  let base: string
  try {
    base = normalizeBaseUrl(baseUrl)
    assertPublicHttpUrl(base, "商汤上游地址")
  } catch (err) {
    return {
      ok: false,
      kind: "bad_url",
      message: err instanceof Error ? err.message : String(err),
    }
  }

  let res: Response
  try {
    res = await fetch(`${base}/v1/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(SENSENOVA_PROBE_TIMEOUT_MS),
    })
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError"
    return {
      ok: false,
      kind: "network",
      message: timedOut
        ? `商汤接口请求超时（超过 ${Math.round(SENSENOVA_PROBE_TIMEOUT_MS / 1000)} 秒无响应）`
        : err instanceof Error
          ? err.message
          : String(err),
    }
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "invalid_key", message: `商汤拒绝了该 Key（HTTP ${res.status}）` }
  }
  if (res.status === 404) {
    return {
      ok: false,
      kind: "bad_url",
      message: "商汤接口地址返回 404，多半是管理面板里的上游地址填错了",
    }
  }
  if (!res.ok) {
    return { ok: false, kind: "network", message: `商汤接口返回 HTTP ${res.status}` }
  }

  const models = extractModelIds(await res.json().catch(() => null))
  if (models.length === 0) {
    // Key 有效但读不到模型：上游改了接口形态，或这个 Key 一个模型都没开通。
    // 注意：这里**只影响校验结论的措辞**，不影响渠道 —— 渠道里的模型是管理员
    // 手工维护的，与我们拉到的列表无关。
    return {
      ok: false,
      kind: "network",
      message: "商汤接口可达，但没有返回任何模型（Key 可能未开通任何模型）",
    }
  }
  return { ok: true, models }
}

/**
 * 复刻 NewAPI 生成 `key_preview` 的规则（`len(key) > 10 ? key[:10] + "..." : key`）。
 *
 * 两侧规则必须**逐字一致**，否则撤销捐献时永远匹配不上渠道里的那把 Key ——
 * 而这种失败是完全静默的（表现为「没找到这把 Key」），最难排查。
 */
export function keyPreview(key: string): string {
  const k = key ?? ""
  return k.length > 10 ? `${k.slice(0, 10)}...` : k
}

/** 组装一个「失败」的 ProvisionResult（省得每个分支重复写五个字段） */
function fail(message: string, detail = ""): ProvisionResult {
  return {
    ok: false,
    channelId: null,
    message,
    detail,
    passed: [],
    failed: [],
    uncertain: [],
    // 商汤这条链路本身不据 availability 自动拒绝；保守起见一律标「非确定性」
    definitive: false,
  }
}

/**
 * 把捐献来的 Key **追加**进管理员配置的那个商汤渠道（必须是多密钥渠道）。
 *
 * 三步，缺一不可：
 *   ① 确认目标渠道存在、且 `channel_info.is_multi_key === true` —— 这一步不能省：
 *      NewAPI 对「非多密钥渠道」会忽略 `key_mode`，把新 Key 当**覆盖**写进去，
 *      渠道原有的 Key 就全没了。宁可拒绝，也不能赌。
 *   ② `PUT /api/channel/` + `key_mode: "append"`（服务端去重后换行拼接）。
 *   ③ 复核密钥数**只增不减**：数量减少说明 append 没生效、反倒把原有 Key 覆盖了 ——
 *      这是最坏情况，必须立刻让管理员知道，而不是报「成功」。
 *
 * 不碰渠道的模型列表、不新建渠道：模型由管理员手工维护。
 */
export async function appendSenseNovaKey(
  env: Env,
  opts: { apiKey: string; channelId: number }
): Promise<ProvisionResult> {
  const key = (opts.apiKey ?? "").trim()
  if (!key) return fail("缺少商汤 API Key")

  const channelId = Math.trunc(Number(opts.channelId))
  if (!Number.isFinite(channelId) || channelId <= 0) {
    return fail(
      "管理面板尚未配置「商汤接入渠道 ID」",
      "请在管理面板「中转站」设置里填写要把 Key 并入的那个渠道 ID"
    )
  }

  // ---- ① 目标渠道必须存在且是多密钥渠道 ----
  // 用单查而不是 `listChannels().find()`：渠道列表接口受分页封顶影响
  // （每页最多 100 条、页码参数叫 `p`），渠道一多就会漏掉目标 id，
  // 被误判成「渠道不存在」→ 所有捐献转人工。2026-09-30 踩过。
  let before: NewApiChannel | null = null
  try {
    before = await getChannel(env, channelId)
  } catch (err) {
    return fail("读取中转站渠道信息失败", err instanceof Error ? err.message : String(err))
  }
  if (!before) {
    return fail(
      `中转站里没有 #${channelId} 这个渠道`,
      "请检查管理面板里的「商汤接入渠道 ID」（渠道 ID 在中转站渠道列表里能看到）"
    )
  }
  if (before.channel_info?.is_multi_key !== true) {
    return fail(
      `渠道 #${channelId}「${before.name}」不是多密钥渠道，已拒绝自动加 Key`,
      "在普通渠道上追加 Key 只会把原有 Key 覆盖掉。请在中转站给该渠道开启「多密钥模式」，或改填另一个渠道 ID"
    )
  }
  const beforeSize = Number(before.channel_info?.multi_key_size ?? 0)

  // ---- ② 追加 ----
  try {
    await appendChannelKey(env, channelId, key)
  } catch (err) {
    return fail("在中转站追加 Key 失败", err instanceof Error ? err.message : String(err))
  }

  // ---- ③ 复核密钥数 ----
  let afterSize = beforeSize
  let afterName = before.name
  try {
    const after = await getChannel(env, channelId)
    if (after) {
      afterSize = Number(after.channel_info?.multi_key_size ?? beforeSize)
      afterName = after.name
    }
  } catch {
    // 复核失败不改结论：Key 已经追加进去了，只是这一瞬间读不到新数量
  }

  if (afterSize < beforeSize) {
    return {
      ok: false,
      channelId,
      message: `渠道 #${channelId}「${afterName}」的密钥数从 ${beforeSize} 变成 ${afterSize}，疑似原有 Key 被覆盖`,
      detail: "请立即到中转站检查该渠道的密钥列表并手工恢复；本次捐献未自动放行。",
      passed: [],
      failed: [],
      uncertain: [],
      definitive: false,
    }
  }

  const detail =
    afterSize === beforeSize
      ? `该 Key 已在渠道 #${channelId}「${afterName}」里（未重复添加，多密钥共 ${afterSize} 把）`
      : `Key 已并入渠道 #${channelId}「${afterName}」（多密钥 ${beforeSize} → ${afterSize} 把）`

  return {
    ok: true,
    channelId,
    message: "商汤 Key 校验通过",
    detail,
    definitive: true,
    passed: [],
    failed: [],
    uncertain: [],
  }
}

/**
 * 撤销商汤捐献时收回资源：把这一把 Key 从多密钥渠道里摘掉。
 *
 * ⚠️ **绝不能删渠道**：那个渠道是管理员自己的（里面可能还有别处来的 Key），
 * 删掉等于把整个商汤上游下架。这也是它与 AI 渠道捐献最大的语义差别
 * （AI 的渠道是本单专属的，可以删）。
 *
 * 定位「是哪一把」只能靠 `key_preview`（前 10 位）—— NewAPI 不提供明文读取。
 * 因此：匹配到**唯一**一把才动手；一把都没匹配到（可能已被手工移除）或多把
 * 前缀相同（无法确认是哪一个）都**不动手**，把情况回报给管理员。
 */
export async function releaseSenseNovaKey(
  env: Env,
  opts: { channelId: number; apiKey: string }
): Promise<{ ok: boolean; message: string }> {
  const key = (opts.apiKey ?? "").trim()
  if (!key) return { ok: false, message: "（捐献记录里没有 Key，无法自动移除）" }

  const channelId = Math.trunc(Number(opts.channelId))
  if (!Number.isFinite(channelId) || channelId <= 0) {
    return { ok: false, message: "（捐献记录里没有渠道 ID，无法自动移除）" }
  }

  let keys: NewApiChannelKeyStatus[]
  try {
    keys = await listChannelKeyStatus(env, channelId)
  } catch (err) {
    return {
      ok: false,
      message: `（读取渠道密钥失败：${err instanceof Error ? err.message : String(err)}）`,
    }
  }

  const preview = keyPreview(key)
  const hits = keys.filter((k) => k.preview === preview)
  if (hits.length === 0) {
    return {
      ok: false,
      message: `（渠道 #${channelId} 里没找到这把 Key，可能已被手工移除）`,
    }
  }
  if (hits.length > 1) {
    return {
      ok: false,
      message: `（渠道 #${channelId} 里有 ${hits.length} 把 Key 前 10 位相同，无法确定是哪一把，请到中转站手工移除）`,
    }
  }

  try {
    await deleteChannelKey(env, channelId, hits[0].index)
  } catch (err) {
    return {
      ok: false,
      message: `（从中转站渠道 #${channelId} 移除 Key 失败：${
        err instanceof Error ? err.message : String(err)
      }）`,
    }
  }
  return { ok: true, message: `已从中转站渠道 #${channelId} 移除该 Key` }
}
