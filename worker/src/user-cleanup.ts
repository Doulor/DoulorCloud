/**
 * 删除用户时回收「外部资源」。
 *
 * 背景：`handlers/admin.ts` 的 `deleteUser` 原先只执行一句 `DELETE FROM users WHERE id = ?`。
 * D1 侧靠 `ON DELETE CASCADE` 能清掉大部分业务行，但**外部资源一个都不会动**：
 *   · Cloudflare Email Routing 规则 —— 变成永久孤儿，继续占「每域 200 条」硬配额
 *     （2026-09-26 线上实测：198 个邮箱里 189 个仍挂着规则，上限 200，已经贴边）
 *   · Cloudflare DNS 记录 / Worker Route —— 悬空解析，子域名被永久占用
 *   · R2 对象（网盘 / 头像 / 社区图 / 临时箱）—— 永久留在桶里继续计费
 *   · NewAPI 账号 / 捐献渠道 / 商汤 Key —— 渠道仍可被调用，资源白送
 *   · WorkBuddy 反代网关账号 —— 仍挂在共享池里
 *
 * ⚠️ 顺序铁律：所有「需要从表里读句柄」的清理都必须在删 `users` 行**之前**完成
 * （mailboxes / dns_records / subdomains 等会随 CASCADE 一起消失，之后取不到 id）。
 *
 * 单项失败**不中断**整体流程，而是收集进 `errors` 回报给管理员 ——
 * 一个坏掉的 CF 规则不应该让整个删号操作失败、并把用户留在半清理状态。
 */
import { cfDeleteDnsRecord, cfDeleteEmailRule } from "./cloudflare"
import { deleteObject, deletePrefix, getPlatformBucketId } from "./r2"
import { detachCustomDomain } from "./custom-domain"
import { purgeUserStorage } from "./handlers/storage"
import { releaseDonationChannel } from "./donation-provision"
import { releaseSenseNovaKey } from "./sensenova"
import { wb2RemoveAccount } from "./wb2api-client"
import { cli2DeleteAccount } from "./cli2api-client"
import { adminSetUserStatus } from "./newapi-client"
import { AVATAR_TYPES, avatarKey } from "./identity"
import type { Env } from "./env"

/** 删号清理的执行结果（写进审计日志，便于事后核对） */
export interface UserCleanupReport {
  emailRules: number
  dnsRecords: number
  customDomains: number
  storageObjects: number
  releasedChannels: number
  releasedSubscriptions: number
  releasedFrpNodes: number
  wb2Removed: number
  cli2Removed: number
  newapiDisabled: boolean
  errors: string[]
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 回收某个用户的全部外部资源。**必须在删除 `users` 行之前调用。**
 */
export async function purgeUserExternalResources(
  env: Env,
  userId: string,
  username: string
): Promise<UserCleanupReport> {
  const report: UserCleanupReport = {
    emailRules: 0,
    dnsRecords: 0,
    customDomains: 0,
    storageObjects: 0,
    releasedChannels: 0,
    releasedSubscriptions: 0,
    releasedFrpNodes: 0,
    wb2Removed: 0,
    cli2Removed: 0,
    newapiDisabled: false,
    errors: [],
  }

  // ---------- 1. Cloudflare：Email Routing 规则 ----------
  // 新邮箱已不再逐条建规则（catch-all 由本 Worker 接管），但**历史遗留**的规则仍挂在
  // Cloudflare 上（线上尚存数十条，占「每域 200 条」硬配额），所以按「有 rule_id 就删」处理。
  const mailboxes = await env.DB.prepare(
    "SELECT address, rule_id FROM mailboxes WHERE user_id = ? AND rule_id IS NOT NULL AND rule_id != ''"
  )
    .bind(userId)
    .all<{ address: string; rule_id: string }>()
  for (const mb of mailboxes.results ?? []) {
    try {
      await cfDeleteEmailRule(env, env.ZONE_ID, mb.rule_id)
      report.emailRules++
    } catch (err) {
      report.errors.push(`Email Routing 规则（${mb.address}）：${errText(err)}`)
    }
  }

  // ---------- 2. Cloudflare：DNS 记录 + 自定义域 Worker Route ----------
  const dnsRows = await env.DB.prepare(
    `SELECT cf_id FROM dns_records
      WHERE cf_id IS NOT NULL AND cf_id != ''
        AND (domain_id IN (SELECT id FROM domains WHERE user_id = ?)
             OR subdomain_id IN (SELECT id FROM subdomains WHERE user_id = ?))`
  )
    .bind(userId, userId)
    .all<{ cf_id: string }>()
  for (const d of dnsRows.results ?? []) {
    try {
      await cfDeleteDnsRecord(env, env.ZONE_ID, d.cf_id)
      report.dnsRecords++
    } catch (err) {
      report.errors.push(`DNS 记录 ${d.cf_id}：${errText(err)}`)
    }
  }

  // 绑过「自定义直链域名」的子域名各有一条 Worker Route，必须摘掉，
  // 否则该域名永久指向本 Worker。detachCustomDomain 是幂等的（找不到 Route 就跳过），
  // 所以子域名与直链前缀都过一遍是安全的。
  const fqdnRows = await env.DB.prepare(
    `SELECT fqdn FROM subdomains WHERE user_id = ?
     UNION
     SELECT fqdn FROM storage_prefixes WHERE user_id = ?`
  )
    .bind(userId, userId)
    .all<{ fqdn: string }>()
  for (const r of fqdnRows.results ?? []) {
    try {
      await detachCustomDomain(env, r.fqdn)
      report.customDomains++
    } catch (err) {
      report.errors.push(`自定义域 ${r.fqdn}：${errText(err)}`)
    }
  }

  // ---------- 3. R2：网盘 / 头像 / 社区图 / 临时箱 ----------
  const platformBucket = await getPlatformBucketId(env)

  // 网盘：走现成的 purgeUserStorage（内部按 storage_accounts.prefix 删整个目录）
  try {
    report.storageObjects += await purgeUserStorage(env, userId)
  } catch (err) {
    report.errors.push(`网盘文件：${errText(err)}`)
  }

  // 头像：avatars/<username>.<ext>，四种扩展名都试（不存在时 R2 也返回成功）
  for (const ext of Object.values(AVATAR_TYPES)) {
    try {
      await deleteObject(env, avatarKey(username, ext), platformBucket)
    } catch (err) {
      report.errors.push(`头像 .${ext}：${errText(err)}`)
    }
  }

  // 社区图片：community/<postId>/。注意帖子是**软删**（deleted_at 非空），
  // 被删的帖子图片同样要清，所以这里不带 deleted_at 过滤。
  const posts = await env.DB.prepare("SELECT id FROM posts WHERE user_id = ?")
    .bind(userId)
    .all<{ id: string }>()
  for (const p of posts.results ?? []) {
    try {
      report.storageObjects += await deletePrefix(env, `community/${p.id}/`, 20, platformBucket)
    } catch (err) {
      report.errors.push(`社区图片 ${p.id}：${errText(err)}`)
    }
  }

  // 临时分享箱：temporary/<code>/
  const batches = await env.DB.prepare(
    "SELECT code FROM tempbox_batches WHERE creator_user_id = ?"
  )
    .bind(userId)
    .all<{ code: string }>()
  for (const b of batches.results ?? []) {
    try {
      report.storageObjects += await deletePrefix(env, `temporary/${b.code}/`, 20, platformBucket)
    } catch (err) {
      report.errors.push(`分享箱 ${b.code}：${errText(err)}`)
    }
  }

  // ---------- 4. 捐献产出的资源：渠道 / 商汤 Key / 订阅源 / frp 节点 ----------
  const donations = await env.DB.prepare(
    "SELECT id, type, status, newapi_channel_id, payload FROM donations WHERE user_id = ?"
  )
    .bind(userId)
    .all<{
      id: string
      type: string
      status: string
      newapi_channel_id: number | null
      payload: string
    }>()

  for (const d of donations.results ?? []) {
    // 只有「已批准」的单据才真的产出过资源
    if (d.status !== "approved") continue
    try {
      if (d.type === "ai" && d.newapi_channel_id) {
        // AI 渠道是本单专属的，直接删
        if (await releaseDonationChannel(env, d.newapi_channel_id)) report.releasedChannels++
      } else if (d.type === "sensenova" && d.newapi_channel_id) {
        // ⚠️ 商汤的 channel_id 指向**管理员自己的共享多密钥渠道**，
        // 只能摘掉这一把 Key，绝不能按 id 删渠道（见 revokeDonation 的说明）。
        let apiKey = ""
        try {
          apiKey = String((JSON.parse(d.payload) as { apiKey?: unknown }).apiKey ?? "").trim()
        } catch {
          apiKey = ""
        }
        const r = await releaseSenseNovaKey(env, { channelId: d.newapi_channel_id, apiKey })
        if (!r.ok) report.errors.push(`商汤 Key：${r.message}`)
      } else if (d.type === "proxy") {
        // 只删本单导入的订阅源，不碰管理员手工添加的
        const del = await env.DB.prepare(
          "DELETE FROM proxy_subscriptions WHERE source_donation_id = ?"
        )
          .bind(d.id)
          .run()
        report.releasedSubscriptions += del.meta?.changes ?? 0
      } else if (d.type === "frp") {
        // 停用而不删除：删节点会级联清掉已分配的端口与申请单
        const upd = await env.DB.prepare(
          `UPDATE frp_nodes
              SET enabled = 0, status = 'offline',
                  status_note = '捐献人账号已删除', status_updated_at = ?
            WHERE source_donation_id = ? AND enabled = 1`
        )
          .bind(new Date().toISOString(), d.id)
          .run()
        if ((upd.meta?.changes ?? 0) > 0) report.releasedFrpNodes++
      }
    } catch (err) {
      report.errors.push(`捐献资源 ${d.type}/${d.id}：${errText(err)}`)
    }
  }

  // ---------- 5. NewAPI 账号 ----------
  const napi = await env.DB.prepare(
    "SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ newapi_user_id: number | null }>()
  if (napi?.newapi_user_id) {
    try {
      // NewAPI 没有「删除用户」接口，只能 disable。
      // disable 会清 token 缓存，让该账号下所有 API Key 立即失效。
      await adminSetUserStatus(env, napi.newapi_user_id, "disable")
      report.newapiDisabled = true
    } catch (err) {
      report.errors.push(`NewAPI 账号禁用：${errText(err)}`)
    }
  }

  // ---------- 6. WorkBuddy 反代网关 ----------
  const bindings = await env.DB.prepare(
    "SELECT uid FROM wb2api_bindings WHERE user_id = ? AND status = 'active'"
  )
    .bind(userId)
    .all<{ uid: string }>()
  for (const b of bindings.results ?? []) {
    try {
      await wb2RemoveAccount(env, b.uid)
      report.wb2Removed++
    } catch (err) {
      report.errors.push(`反代账号 ${b.uid}：${errText(err)}`)
    }
  }

  // ---------- 6b. CLI2API 反代网关（第二条通道） ----------
  const cli2Bindings = await env.DB.prepare(
    "SELECT account_id FROM cli2api_bindings WHERE user_id = ? AND status = 'active'"
  )
    .bind(userId)
    .all<{ account_id: string }>()
  for (const b of cli2Bindings.results ?? []) {
    try {
      await cli2DeleteAccount(env, b.account_id)
      report.cli2Removed++
    } catch (err) {
      report.errors.push(`CLI2API 账号 ${b.account_id}：${errText(err)}`)
    }
  }

  // ---------- 7. 无外键、不会随 CASCADE 消失的表 ----------
  try {
    await env.DB.prepare("DELETE FROM tempbox_batches WHERE creator_user_id = ?")
      .bind(userId)
      .run()
  } catch (err) {
    report.errors.push(`分享箱记录：${errText(err)}`)
  }
  // 自定义称号授予关系（user_titles 有 FK CASCADE，但 D1 的 FK 执行不保证，显式清掉防孤儿）
  try {
    await env.DB.prepare("DELETE FROM user_titles WHERE user_id = ?")
      .bind(userId)
      .run()
  } catch (err) {
    report.errors.push(`自定义称号：${errText(err)}`)
  }
  // `invite_rewards` 刻意**保留**：它是「某被邀请人只发过一次奖励」的去重凭据，
  // 删掉会让同一个被邀请人重新注册后被再次计入奖励。悬空引用不影响任何查询。

  return report
}
