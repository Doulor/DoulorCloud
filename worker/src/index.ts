import { ApiError, json } from "./http"
import { getSessionTokens, clearedSessionCookie } from "./auth"
import type { Env } from "./env"
import * as authHandlers from "./handlers/auth"
import * as stickerHandlers from "./handlers/stickers"
import * as dnsHandlers from "./handlers/dns"
import * as emailHandlers from "./handlers/email"
import * as subdomainHandlers from "./handlers/subdomains"
import * as adminHandlers from "./handlers/admin"
import * as adminLabHandlers from "./handlers/admin-lab"
import * as labPromptHandlers from "./handlers/lab-prompts"
import * as labSkillHandlers from "./handlers/lab-skills"
import * as labSearchHandlers from "./handlers/lab-search"
import * as adminDnsHandlers from "./handlers/admin-dns"
import * as adminSubdomainHandlers from "./handlers/admin-subdomains"
import * as adminMailboxHandlers from "./handlers/admin-mailboxes"
import * as adminUsersStatusHandlers from "./handlers/admin-users-status"
import * as adminRootDomainHandlers from "./handlers/admin-root-domains"
import * as adminChannelHandlers from "./handlers/admin-channels"
import * as adminPermHandlers from "./handlers/admin-perms"
import * as noticeHandlers from "./handlers/notices"
import * as storageHandlers from "./handlers/storage"
import { rootDomainFor } from "./root-domains"
import * as newapiHandlers from "./handlers/newapi"
import * as labHandlers from "./handlers/lab"
import * as settingsHandlers from "./handlers/settings"
import * as donationHandlers from "./handlers/donations"
import * as voucherHandlers from "./handlers/vouchers"
import * as wb2apiHandlers from "./handlers/wb2api"
import * as qoder2apiHandlers from "./handlers/qoder2api"
import * as myInviteHandlers from "./handlers/my-invites"
import * as frpHandlers from "./handlers/frp"
import * as profileHandlers from "./handlers/profile"
import * as identityHandlers from "./handlers/identity"
import * as proxyHandlers from "./handlers/proxy"
import * as cfQuotaHandlers from "./handlers/cf-quota"
import * as tempboxHandlers from "./handlers/tempbox"
import * as announcementHandlers from "./handlers/announcements"
import * as funLinkHandlers from "./handlers/fun-links"
import * as funLinkProbeHandlers from "./handlers/fun-link-probe"
import * as titleHandlers from "./handlers/titles"
import * as r2AdminHandlers from "./handlers/r2-admin"
import * as achievementHandlers from "./handlers/achievements"
import * as leaderboardHandlers from "./handlers/leaderboard"
import * as communityHandlers from "./handlers/community"
import * as spaceHandlers from "./handlers/space"
import * as analyticsHandlers from "./handlers/analytics"
import * as auditHandlers from "./handlers/audit"
import * as chatHandlers from "./handlers/chat"
import * as dmHandlers from "./handlers/dm"
import * as oauthHandlers from "./handlers/oauth"
import * as feedbackHandlers from "./handlers/feedback"
import * as chatUploadHandlers from "./handlers/chat-upload"
import * as twoFactorHandlers from "./handlers/two-factor"
import * as login2faHandlers from "./handlers/login-2fa"
import * as checkinHandlers from "./handlers/checkin"
import * as publicApiHandlers from "./handlers/public-api"
import { stripInternalHeaders } from "./api-source"
import * as adminApiHandlers from "./handlers/admin-api"
import * as eventHandlers from "./handlers/events"
import * as moderationHandlers from "./handlers/moderation"
import * as moderationListHandlers from "./handlers/moderation-lists"
import * as pointHandlers from "./handlers/points"
import * as dbBackupHandlers from "./handlers/db-backup"
import * as attentionHandlers from "./handlers/attention"
import { renderProfileHtml, renderNotFoundHtml } from "./profile-page"
import { incomingEmail } from "./email-delivery"
import { runMaintenance } from "./maintenance"
import { processScheduledPublishes } from "./scheduled-publish"
import { scanRiskAccounts } from "./risk-scan"

/**
 * 「到点发布」专用的 cron 表达式（每分钟）。必须与 wrangler.toml 的 [triggers] crons 一致 ——
 * scheduled 处理器靠它区分「每小时的完整运维」和「每分钟的发布 tick」。
 */
const SCHEDULED_PUBLISH_CRON = "* * * * *"

export interface WorkerContext {
  env: Env
  request: Request
}

/**
 * 路由表：一个条目 = 一条接口。
 *
 * 顺序即匹配优先级，跟原来 if-chain 的书写顺序一一对应 —— 冲突的路径
 * （如 /community/posts/<id>/comments 必须排在 /community/posts/<id> 前）靠顺序保证。
 * 新接口追加到对应分组末尾即可，不用再在 800 行的 if-chain 里找位置。
 *
 * 表由 buildRoutes() 返回，因为闭包要捕获 env / request / ctx。
 */
type Handler<T> = (m: T) => Response | Promise<Response>

type RouteRule =
  | { kind: "exact"; path: string; method: string; handle: Handler<void> }
  | {
      kind: "regex"
      match: (p: string) => RegExpMatchArray | null
      methods: string[]
      handle: Handler<RegExpMatchArray>
    }
  | {
      kind: "branch"
      match: (p: string) => RegExpMatchArray | null
      handle: (m: RegExpMatchArray, method: string) => Response | Promise<Response> | null
    }

function buildRoutes(env: Env, request: Request, ctx?: ExecutionContext): RouteRule[] {
  return [
  {
    kind: "exact",
    path: "/register",
    method: "POST",
    handle: () =>
      authHandlers.register(env, request),
  },

  {
    kind: "exact",
    path: "/register-status",
    method: "GET",
    handle: () =>
      authHandlers.registerStatus(env),
  },

  {
    kind: "exact",
    path: "/login",
    method: "POST",
    handle: () =>
      authHandlers.login(env, request),
  },

  // ---- 登录第二步：二次验证（2FA）----
  // 口令通过后若该账号要求 2FA，/login 会返回 challengeId 而不下发 session，
  // 前端拿着它来这两个接口完成验证。
  {
    kind: "exact",
    path: "/login/2fa",
    method: "POST",
    handle: () => login2faHandlers.verifyLoginTwoFactor(env, request),
  },
  {
    kind: "exact",
    path: "/login/2fa/send-email",
    method: "POST",
    handle: () => login2faHandlers.sendLoginTwoFactorEmail(env, request),
  },

  {
    kind: "exact",
    path: "/logout",
    method: "POST",
    handle: () =>
      authHandlers.logout(env, request),
  },

  {
    kind: "exact",
    path: "/me",
    method: "GET",
    handle: () =>
      authHandlers.me(env, request, ctx),
  },

  {
    kind: "exact",
    path: "/password",
    method: "PUT",
    handle: () =>
      authHandlers.changePassword(env, request),
  },

  {
    kind: "exact",
    path: "/password/forgot",
    method: "POST",
    handle: () =>
      authHandlers.forgotPassword(env, request),
  },

  {
    kind: "exact",
    path: "/password/reset",
    method: "POST",
    handle: () =>
      authHandlers.resetPassword(env, request),
  },

  {
    kind: "exact",
    path: "/settings/email",
    method: "GET",
    handle: () =>
      settingsHandlers.getEmailSettings(env, request),
  },

  {
    kind: "exact",
    path: "/downloads",
    method: "GET",
    handle: () =>
      settingsHandlers.publicDownloads(env, request),
  },

  {
    kind: "exact",
    path: "/settings/email/verify",
    method: "POST",
    handle: () =>
      settingsHandlers.verifyRealEmail(env, request),
  },

  // ---- 二次认证（2FA）自助管理 ----
  {
    kind: "exact",
    path: "/settings/2fa",
    method: "GET",
    handle: () => twoFactorHandlers.getTwoFactorSettings(env, request),
  },
  {
    kind: "exact",
    path: "/settings/2fa/totp/start",
    method: "POST",
    handle: () => twoFactorHandlers.startTotpSetup(env, request),
  },
  {
    kind: "exact",
    path: "/settings/2fa/totp/confirm",
    method: "POST",
    handle: () => twoFactorHandlers.confirmTotpSetup(env, request),
  },
  {
    kind: "exact",
    path: "/settings/2fa/totp/disable",
    method: "POST",
    handle: () => twoFactorHandlers.disableTotp(env, request),
  },
  {
    kind: "exact",
    path: "/settings/2fa/email",
    method: "POST",
    handle: () => twoFactorHandlers.setEmailTwoFactor(env, request),
  },
  {
    kind: "exact",
    path: "/settings/2fa/recovery/regenerate",
    method: "POST",
    handle: () => twoFactorHandlers.regenerateRecoveryCodes(env, request),
  },
  // 已登录状态下的「二次验证码」发送入口（2026-10-10：改动 2FA 设置时要重新认证）
  {
    kind: "exact",
    path: "/settings/2fa/step-up/send",
    method: "POST",
    handle: () => twoFactorHandlers.sendTwoFactorStepUpCode(env, request),
  },
  {
    kind: "exact",
    path: "/settings/2fa/disable",
    method: "POST",
    handle: () => twoFactorHandlers.disableTwoFactor(env, request),
  },
  // 站长的最后一道保险：给丢了手机的人拆掉这道锁
  {
    kind: "exact",
    path: "/admin/2fa/reset",
    method: "POST",
    handle: () => twoFactorHandlers.adminResetTwoFactor(env, request),
  },

  {
    kind: "exact",
    path: "/settings/email",
    method: "PUT",
    handle: () =>
      settingsHandlers.changeRealEmail(env, request),
  },

  {
    kind: "exact",
    path: "/settings/notify",
    method: "PUT",
    handle: () =>
      settingsHandlers.updateNotifySetting(env, request),
  },

  {
    kind: "exact",
    path: "/settings/username",
    method: "PUT",
    handle: () =>
      settingsHandlers.changeUsername(env, request),
  },

  {
    kind: "exact",
    path: "/settings/account/delete-code",
    method: "POST",
    handle: () =>
      settingsHandlers.requestDeleteCode(env, request),
  },

  {
    kind: "exact",
    path: "/settings/account/delete",
    method: "POST",
    handle: () =>
      settingsHandlers.deleteOwnAccount(env, request),
  },

  {
    kind: "exact",
    path: "/settings/nickname",
    method: "PUT",
    handle: () =>
      identityHandlers.updateNickname(env, request),
  },

  {
    kind: "exact",
    path: "/settings/avatar",
    method: "POST",
    handle: () =>
      identityHandlers.uploadAvatar(env, request),
  },

  {
    kind: "exact",
    path: "/settings/avatar",
    method: "DELETE",
    handle: () =>
      identityHandlers.deleteAvatar(env, request),
  },

  {
    kind: "exact",
    path: "/dns",
    method: "GET",
    handle: () =>
      dnsHandlers.listDns(env, request),
  },

  {
    kind: "exact",
    path: "/dns",
    method: "POST",
    handle: () =>
      dnsHandlers.createDns(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/dns\/([^/]+)$/),
    methods: ["PUT"],
    handle: (dnsMatch: RegExpMatchArray) =>
      dnsHandlers.updateDns(env, request, decodeURIComponent(dnsMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/dns\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (dnsMatch: RegExpMatchArray) =>
      dnsHandlers.deleteDns(env, request, decodeURIComponent(dnsMatch[1])),
  },

  {
    kind: "exact",
    path: "/subdomains",
    method: "GET",
    handle: () =>
      subdomainHandlers.listSubdomains(env, request),
  },

  {
    kind: "exact",
    path: "/subdomains",
    method: "POST",
    handle: () =>
      subdomainHandlers.createSubdomain(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/subdomains\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (subdomainMatch: RegExpMatchArray) =>
      subdomainHandlers.deleteSubdomain(env, request, decodeURIComponent(subdomainMatch[1])),
  },

  {
    kind: "exact",
    path: "/admin/users",
    method: "GET",
    handle: () =>
      adminHandlers.listUsers(env, request),
  },

  // 用户列表批量封禁 / 解封（勾选多行 → 批量操作；复用单人封禁的全部联动）。
  // ⚠️ 固定路径必须排在下面的 `/admin/users/:username` 正则之前，否则会被当成 username。
  {
    kind: "exact",
    path: "/admin/users/bulk-status",
    method: "POST",
    handle: () => adminUsersStatusHandlers.bulkSetUserStatus(env, request),
  },

  // 用户「最近活动」分页（支持查看更多 / 懒加载）
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)\/activity$/),
    methods: ["GET"],
    handle: (adminUserActivityMatch: RegExpMatchArray) =>
      adminHandlers.getUserActivity(env, request, decodeURIComponent(adminUserActivityMatch[1])),
  },

  // ---- 管理员权限系统：权限树 / 权限组 / 成员管理权限 ----
  {
    kind: "exact",
    path: "/admin/permissions/tree",
    method: "GET",
    handle: () => adminPermHandlers.getPermissionTree(env, request),
  },
  {
    kind: "exact",
    path: "/admin/permission-groups",
    method: "GET",
    handle: () => adminPermHandlers.listPermissionGroups(env, request),
  },
  {
    kind: "exact",
    path: "/admin/permission-groups",
    method: "POST",
    handle: () => adminPermHandlers.createPermissionGroup(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/permission-groups\/([^/]+)\/members$/),
    methods: ["POST"],
    handle: (m: RegExpMatchArray) =>
      adminPermHandlers.addGroupMembers(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/permission-groups\/([^/]+)$/),
    methods: ["PUT"],
    handle: (m: RegExpMatchArray) =>
      adminPermHandlers.updatePermissionGroup(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/permission-groups\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (m: RegExpMatchArray) =>
      adminPermHandlers.deletePermissionGroup(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)\/admin-permissions$/),
    methods: ["GET"],
    handle: (m: RegExpMatchArray) =>
      adminPermHandlers.getUserAdminPermissions(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)\/admin-permissions$/),
    methods: ["PUT"],
    handle: (m: RegExpMatchArray) =>
      adminPermHandlers.setUserAdminPermissions(env, request, decodeURIComponent(m[1])),
  },

  // ---- 账号监管：封禁申诉 + 风险账户 ----
  // 申诉提交是**公开**接口：被封禁用户登录会被 403，拿不到会话
  {
    kind: "exact",
    path: "/appeal",
    method: "POST",
    handle: () => moderationHandlers.submitAppeal(env, request),
  },
  // 用户端：申诉回复的已读确认（需登录态）
  {
    kind: "exact",
    path: "/appeal/pending-reply",
    method: "GET",
    handle: () => moderationHandlers.getPendingAppealReply(env, request),
  },
  {
    kind: "exact",
    path: "/appeal/acknowledge",
    method: "POST",
    handle: () => moderationHandlers.acknowledgeAppealNote(env, request),
  },
  {
    kind: "exact",
    path: "/notice/pending",
    method: "GET",
    handle: () => noticeHandlers.pendingNotices(env, request),
  },
  {
    kind: "exact",
    path: "/notice/ack",
    method: "POST",
    handle: () => noticeHandlers.ackNotice(env, request),
  },
  {
    kind: "exact",
    path: "/admin/notices",
    method: "GET",
    handle: () => noticeHandlers.listNotices(env, request),
  },
  {
    kind: "exact",
    path: "/admin/notices",
    method: "POST",
    handle: () => noticeHandlers.sendNotice(env, request),
  },
  {
    kind: "exact",
    path: "/admin/notices/revoke",
    method: "POST",
    handle: () => noticeHandlers.revokeNotice(env, request),
  },
  {
    kind: "exact",
    path: "/admin/appeals",
    method: "GET",
    handle: () => moderationHandlers.listAppeals(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/appeals\/([^/]+)\/review$/),
    methods: ["POST"],
    handle: (appealMatch: RegExpMatchArray) =>
      moderationHandlers.reviewAppeal(env, request, decodeURIComponent(appealMatch[1])),
  },
  {
    kind: "exact",
    path: "/admin/risk-accounts",
    method: "GET",
    handle: () => moderationHandlers.listRiskAccounts(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/risk-accounts\/([^/]+)\/status$/),
    methods: ["POST"],
    handle: (riskMatch: RegExpMatchArray) =>
      moderationHandlers.updateRiskStatus(env, request, decodeURIComponent(riskMatch[1])),
  },

  // 监管：白名单 / 自动条件 / 黑名单（2026-10-03）
  {
    kind: "exact",
    path: "/admin/moderation/lists",
    method: "GET",
    handle: () => moderationListHandlers.listModerationLists(env, request),
  },
  {
    kind: "exact",
    path: "/admin/moderation/whitelist",
    method: "POST",
    handle: () => moderationListHandlers.updateWhitelist(env, request),
  },
  {
    kind: "exact",
    path: "/admin/moderation/conditions",
    method: "POST",
    handle: () => moderationListHandlers.updateConditions(env, request),
  },
  {
    kind: "exact",
    path: "/admin/moderation/blacklist",
    method: "POST",
    handle: () => moderationListHandlers.updateBlacklist(env, request),
  },
  // IP 监管：查出被多个不同（未封禁）账号共用的登录 IP
  {
    kind: "exact",
    path: "/admin/moderation/ip-watch",
    method: "GET",
    handle: () => moderationListHandlers.getIpWatch(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)$/),
    methods: ["GET"],
    handle: (adminUserMatch: RegExpMatchArray) =>
      adminHandlers.getUser(env, request, decodeURIComponent(adminUserMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)$/),
    methods: ["PUT"],
    handle: (adminUserMatch: RegExpMatchArray) =>
      adminHandlers.updateUser(env, request, decodeURIComponent(adminUserMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (adminUserMatch: RegExpMatchArray) =>
      adminHandlers.deleteUser(env, request, decodeURIComponent(adminUserMatch[1])),
  },

  // 管理员为用户重置密码（rootOnly：users.password）
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)\/password$/),
    methods: ["POST"],
    handle: (adminUserPwMatch: RegExpMatchArray) =>
      adminHandlers.setUserPassword(env, request, decodeURIComponent(adminUserPwMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/users\/([^/]+)\/messages\/([^/]+)$/),
    methods: ["GET"],
    handle: (adminMessageMatch: RegExpMatchArray) =>
      adminHandlers.getUserMessage(
      env,
      request,
      decodeURIComponent(adminMessageMatch[1]),
      decodeURIComponent(adminMessageMatch[2])
      ),
  },

  {
    kind: "exact",
    path: "/admin/invites",
    method: "GET",
    handle: () =>
      adminHandlers.listInvites(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/invites\/([^/]+)\/trace$/),
    methods: ["GET"],
    handle: (adminInviteTraceMatch: RegExpMatchArray) =>
      adminHandlers.traceInvite(env, request, decodeURIComponent(adminInviteTraceMatch[1])),
  },

  {
    kind: "exact",
    path: "/admin/invites",
    method: "POST",
    handle: () =>
      adminHandlers.createInvite(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/invites\/([^/]+)$/),
    methods: ["PUT"],
    handle: (adminInviteMatch: RegExpMatchArray) =>
      adminHandlers.updateInvite(env, request, decodeURIComponent(adminInviteMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/invites\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (adminInviteMatch: RegExpMatchArray) =>
      
      
      adminHandlers.adminDeleteInviteWithRefund(
      env,
      request,
      decodeURIComponent(adminInviteMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/my-invites",
    method: "GET",
    handle: () =>
      myInviteHandlers.listMyInvites(env, request),
  },

  {
    kind: "exact",
    path: "/my-invites",
    method: "POST",
    handle: () =>
      myInviteHandlers.createMyInvite(env, request),
  },

  // 补填邀请码（用户反馈 3ed5d0b0）—— 必须排在 /my-invites/:id 之前
  {
    kind: "exact",
    path: "/my-invites/claim",
    method: "POST",
    handle: () =>
      myInviteHandlers.claimMyInvite(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/my-invites\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (myInviteMatch: RegExpMatchArray) =>
      myInviteHandlers.deleteMyInvite(
      env,
      request,
      decodeURIComponent(myInviteMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/admin/donations",
    method: "GET",
    handle: () =>
      donationHandlers.listAllDonations(env, request),
  },

  {
    kind: "exact",
    path: "/admin/donations/review",
    method: "POST",
    handle: () =>
      donationHandlers.reviewDonation(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/donations\/([^/]+)\/revoke$/),
    methods: ["POST"],
    handle: (donationMatch: RegExpMatchArray) =>
      donationHandlers.revokeDonation(env, request, decodeURIComponent(donationMatch[1])),
  },

  // 人工复核：重试把 AI 捐献的渠道接进中转站
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/donations\/([^/]+)\/provision$/),
    methods: ["POST"],
    handle: (donationMatch: RegExpMatchArray) =>
      donationHandlers.provisionDonation(env, request, decodeURIComponent(donationMatch[1])),
  },

  // 重试该单里「没通过测试」的模型（限流/超时的可能已恢复）
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/donations\/([^/]+)\/retry-models$/),
    methods: ["POST"],
    handle: (donationMatch: RegExpMatchArray) =>
      donationHandlers.retryDonationModelsNow(env, request, decodeURIComponent(donationMatch[1])),
  },

  // 重新拉上游模型列表并补全渠道（救重试表存在之前的历史单）
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/donations\/([^/]+)\/refetch-models$/),
    methods: ["POST"],
    handle: (donationMatch: RegExpMatchArray) =>
      donationHandlers.refetchDonationModelsNow(env, request, decodeURIComponent(donationMatch[1])),
  },

  // ---- 管理端：WorkBuddy 反代账号捐献 ----
  {
    kind: "exact",
    path: "/admin/wb2api/bindings",
    method: "GET",
    handle: () =>
      wb2apiHandlers.adminListBindings(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/admin\/wb2api\/bindings\/([^/]+)\/remove$/),
    methods: ["POST"],
    handle: (wb2apiRemoveMatch: RegExpMatchArray) =>
      wb2apiHandlers.adminRemoveBinding(
        env,
        request,
        decodeURIComponent(wb2apiRemoveMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/admin/wb2api/config",
    method: "GET",
    handle: () =>
      wb2apiHandlers.adminGetConfig(env, request),
  },

  {
    kind: "exact",
    path: "/admin/wb2api/config",
    method: "PUT",
    handle: () =>
      wb2apiHandlers.adminUpdateConfig(env, request),
  },

  {
    kind: "exact",
    path: "/admin/wb2api/pool",
    method: "GET",
    handle: () =>
      wb2apiHandlers.adminGetPool(env, request),
  },

  // ---- 管理端：Qoder2API 反代账号捐献 ----
  {
    kind: "exact",
    path: "/admin/qoder2api/bindings",
    method: "GET",
    handle: () =>
      qoder2apiHandlers.adminListBindings(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/admin\/qoder2api\/bindings\/([^/]+)\/remove$/),
    methods: ["POST"],
    handle: (qoder2apiRemoveMatch: RegExpMatchArray) =>
      qoder2apiHandlers.adminRemoveBinding(
        env,
        request,
        decodeURIComponent(qoder2apiRemoveMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/admin/qoder2api/config",
    method: "GET",
    handle: () =>
      qoder2apiHandlers.adminGetConfig(env, request),
  },

  {
    kind: "exact",
    path: "/admin/qoder2api/config",
    method: "PUT",
    handle: () =>
      qoder2apiHandlers.adminSaveConfig(env, request),
  },

  {
    kind: "exact",
    path: "/admin/qoder2api/pool",
    method: "GET",
    handle: () =>
      qoder2apiHandlers.adminGetPool(env, request),
  },

  {
    kind: "exact",
    path: "/admin/invite-quotas",
    method: "GET",
    handle: () =>
      adminHandlers.listInviteQuotas(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(
    /^\/admin\/users\/([^/]+)\/invite-quota$/
  ),
    methods: ["GET"],
    handle: (quotaUserMatch: RegExpMatchArray) =>
      adminHandlers.getUserInviteQuota(
      env,
      request,
      decodeURIComponent(quotaUserMatch[1])
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(
    /^\/admin\/users\/([^/]+)\/invite-quota$/
  ),
    methods: ["PUT"],
    handle: (quotaUserMatch: RegExpMatchArray) =>
      adminHandlers.updateUserInviteQuota(
      env,
      request,
      decodeURIComponent(quotaUserMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/admin/reserved-subdomains",
    method: "GET",
    handle: () =>
      adminHandlers.listReserved(env, request),
  },

  // ---- AI 中转站渠道巡检（管理面板 → 中转站）----
  {
    kind: "exact",
    path: "/admin/channels",
    method: "GET",
    handle: () => adminChannelHandlers.listChannelReport(env, request),
  },
  {
    kind: "exact",
    path: "/admin/channels/sweep",
    method: "POST",
    handle: () => adminChannelHandlers.sweepChannels(env, request),
  },
  {
    kind: "exact",
    path: "/admin/channels/enable",
    method: "POST",
    handle: () => adminChannelHandlers.enableChannels(env, request),
  },

  // ---- 子域名管理（管理面板 → 子域名板块，与 DNS 解析同页）----
  // 与用户侧 /api/subdomains 是两套：那套只能管自己的域名，这套按 dns
  // 管理scope鉴权，可代替任意用户增删改（含改名时同步 DNS/名片/网盘/CF）。
  // ⚠️ 固定路径必须排在 `/admin/subdomains/:id` 正则之前。
  {
    kind: "exact",
    path: "/admin/subdomains/owners",
    method: "GET",
    handle: () => adminSubdomainHandlers.searchSubdomainOwners(env, request),
  },
  {
    kind: "exact",
    path: "/admin/subdomains",
    method: "GET",
    handle: () => adminSubdomainHandlers.listAdminSubdomains(env, request),
  },
  {
    kind: "exact",
    path: "/admin/subdomains",
    method: "POST",
    handle: () => adminSubdomainHandlers.createAdminSubdomain(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/subdomains\/([^/]+)$/),
    methods: ["PUT"],
    handle: (adminSubdomainMatch: RegExpMatchArray) =>
      adminSubdomainHandlers.updateAdminSubdomain(
        env,
        request,
        decodeURIComponent(adminSubdomainMatch[1])
      ),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/subdomains\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (adminSubdomainMatch: RegExpMatchArray) =>
      adminSubdomainHandlers.deleteAdminSubdomain(
        env,
        request,
        decodeURIComponent(adminSubdomainMatch[1])
      ),
  },

  // ---- 邮箱管理（管理面板 → DNS → 「邮箱管理」tab）----
  // 与子域名管理同一把钥匙（dns scope）：都是「用户的域名资源」，
  // 可代替任意用户增删改邮箱、并查看邮箱里的邮件（只读，不改已读状态）。
  // ⚠️ 固定路径 `/admin/mailboxes/owners` 必须排在 `/admin/mailboxes/:id` 正则之前；
  //    邮件详情 `/admin/mailboxes/:id/messages/:mid` 也必须排在
  //    `/admin/mailboxes/:id/messages` 之前（虽然 arity 不同，仍按从具体到宽泛排）。
  {
    kind: "exact",
    path: "/admin/mailboxes/owners",
    method: "GET",
    handle: () => adminMailboxHandlers.searchMailboxOwners(env, request),
  },
  {
    kind: "exact",
    path: "/admin/mailboxes",
    method: "GET",
    handle: () => adminMailboxHandlers.listAdminMailboxes(env, request),
  },
  {
    kind: "exact",
    path: "/admin/mailboxes",
    method: "POST",
    handle: () => adminMailboxHandlers.createAdminMailbox(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/mailboxes\/([^/]+)\/messages\/([^/]+)$/),
    methods: ["GET"],
    handle: (adminMailboxMsgMatch: RegExpMatchArray) =>
      adminMailboxHandlers.getAdminMailboxMessage(
        env,
        request,
        decodeURIComponent(adminMailboxMsgMatch[1]),
        decodeURIComponent(adminMailboxMsgMatch[2])
      ),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/mailboxes\/([^/]+)\/messages$/),
    methods: ["GET"],
    handle: (adminMailboxListMatch: RegExpMatchArray) =>
      adminMailboxHandlers.listAdminMailboxMessages(
        env,
        request,
        decodeURIComponent(adminMailboxListMatch[1])
      ),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/mailboxes\/([^/]+)$/),
    methods: ["PUT"],
    handle: (adminMailboxPutMatch: RegExpMatchArray) =>
      adminMailboxHandlers.updateAdminMailbox(
        env,
        request,
        decodeURIComponent(adminMailboxPutMatch[1])
      ),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/mailboxes\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (adminMailboxDelMatch: RegExpMatchArray) =>
      adminMailboxHandlers.deleteAdminMailbox(
        env,
        request,
        decodeURIComponent(adminMailboxDelMatch[1])
      ),
  },

  // ---- DNS 解析管理（管理面板 → DNS）----
  // ⚠️ 声明顺序有意义（dispatch 按数组顺序命中）：
  //    固定路径必须排在 `/admin/dns/:id` 正则之前，否则 findings / audit / cf-diff
  //    会被当成记录 id 吃掉。
  {
    kind: "exact",
    path: "/admin/dns",
    method: "GET",
    handle: () => adminDnsHandlers.listAdminDns(env, request),
  },

  {
    kind: "exact",
    path: "/admin/dns/findings",
    method: "GET",
    handle: () => adminDnsHandlers.listDnsFindings(env, request),
  },

  {
    kind: "exact",
    path: "/admin/dns/audit",
    method: "POST",
    handle: () => adminDnsHandlers.runDnsAudit(env, request),
  },

  {
    kind: "exact",
    path: "/admin/dns/cf-diff",
    method: "GET",
    handle: () => adminDnsHandlers.compareCfDns(env, request),
  },

  // 「台账与 Cloudflare 对不上」的修复口：fqdn 换了归属域（如整体换到 tyu.me）后，
  // 老 cf_id 指向的是**另一个 zone** 的记录 —— 这里按当前 fqdn 重建并回填。
  {
    kind: "exact",
    path: "/admin/dns/recreate",
    method: "POST",
    handle: () => adminDnsHandlers.recreateDnsRecord(env, request),
  },

  // 绑定在子域名上的服务（名片/网盘直链）换域后，Worker Route 是 zone 级资源、
  // 不会自己搬家 —— 这里在新 domain 下重挂一套并拆掉旧的。
  {
    kind: "exact",
    path: "/admin/domains/rebind",
    method: "POST",
    handle: () => adminDnsHandlers.rebindCustomDomain(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/dns\/findings\/([^/]+)$/),
    methods: ["PUT"],
    handle: (findingMatch: RegExpMatchArray) =>
      adminDnsHandlers.reviewDnsFinding(env, request, decodeURIComponent(findingMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/dns\/cf-orphan\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (orphanMatch: RegExpMatchArray) =>
      adminDnsHandlers.deleteOrphanCfRecord(env, request, decodeURIComponent(orphanMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/dns\/([^/]+)$/),
    methods: ["PUT"],
    handle: (adminDnsMatch: RegExpMatchArray) =>
      adminDnsHandlers.updateAdminDns(env, request, decodeURIComponent(adminDnsMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/dns\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (adminDnsMatch: RegExpMatchArray) =>
      adminDnsHandlers.deleteAdminDns(env, request, decodeURIComponent(adminDnsMatch[1])),
  },

  // ---- 用户可分配根域（管理面板 → DNS 解析 → 根域管理）----
  // 用途：把「发给用户的域名」从 env.ROOT_DOMAIN 拆出来（默认 tyu.me），
  // 并提供 Cloudflare 侧的开通动作（解析 zone id / 开 Email Routing / 设 catch-all）。
  // ⚠️ 顺序：固定路径必须排在 `/admin/root-domains/:name` 之前。
  {
    kind: "exact",
    path: "/admin/root-domains",
    method: "GET",
    handle: () => adminRootDomainHandlers.listAdminRootDomains(env, request),
  },

  {
    kind: "exact",
    path: "/admin/root-domains",
    method: "POST",
    handle: () => adminRootDomainHandlers.upsertAdminRootDomain(env, request),
  },

  {
    kind: "exact",
    path: "/admin/root-domains/action",
    method: "POST",
    handle: () => adminRootDomainHandlers.rootDomainAction(env, request),
  },

  {
    kind: "exact",
    path: "/admin/reserved-subdomains",
    method: "POST",
    handle: () =>
      adminHandlers.addReserved(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/reserved-subdomains\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (reservedMatch: RegExpMatchArray) =>
      adminHandlers.removeReserved(
      env,
      request,
      decodeURIComponent(reservedMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/admin/mail-test",
    method: "POST",
    handle: () =>
      adminHandlers.testMail(env, request),
  },

  {
    kind: "exact",
    path: "/admin/newapi-test",
    method: "GET",
    handle: () =>
      adminHandlers.testNewApi(env, request),
  },

  // 手动触发一次中转站批量同步（排行榜数字过期时的「立即刷新」入口）
  {
    kind: "exact",
    path: "/admin/newapi/sync-all",
    method: "POST",
    handle: () =>
      newapiHandlers.adminSyncAllNewapiAccounts(env, request),
  },

  {
    kind: "exact",
    path: "/admin/newapi/config",
    method: "GET",
    handle: () =>
      adminHandlers.getNewApiAdminConfig(env, request),
  },

  {
    kind: "exact",
    path: "/admin/newapi/config",
    method: "PUT",
    handle: () =>
      adminHandlers.updateNewApiAdminConfig(env, request),
  },

  {
    kind: "exact",
    path: "/admin/newapi/models",
    method: "GET",
    handle: () =>
      adminHandlers.listNewApiModels(env, request),
  },
  {
    kind: "exact",
    path: "/admin/newapi/sync-permissions",
    method: "POST",
    handle: () =>
      newapiHandlers.adminSyncPermissions(env, request),
  },
  {
    kind: "exact",
    path: "/admin/sensenova/audit",
    method: "POST",
    // 手动跑一次商汤 Key 巡检；默认只预演，带 {"apply":true} 才真动手
    handle: () =>
      donationHandlers.adminAuditSenseNovaKeys(env, request),
  },

  {
    kind: "exact",
    path: "/analytics/track",
    method: "POST",
    handle: () =>
      analyticsHandlers.track(env, request),
  },
  {
    kind: "exact",
    path: "/admin/analytics",
    method: "GET",
    handle: () =>
      analyticsHandlers.overview(env, request),
  },

  {
    kind: "exact",
    path: "/admin/analytics/users",
    method: "GET",
    handle: () =>
      analyticsHandlers.userOverview(env, request),
  },

  {
    kind: "exact",
    path: "/admin/audit",
    method: "GET",
    handle: () =>
      auditHandlers.listAudit(env, request),
  },

  {
    kind: "exact",
    path: "/admin/mail-status",
    method: "GET",
    handle: () =>
      adminHandlers.mailStatus(env, request),
  },

  {
    kind: "exact",
    path: "/admin/mail/brevo-quota",
    method: "GET",
    handle: () =>
      adminHandlers.getBrevoQuota(env, request),
  },

  {
    kind: "exact",
    path: "/announcements",
    method: "GET",
    handle: () =>
      announcementHandlers.listAnnouncements(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/announcements\/([^/]+)\/dismiss$/),
    methods: ["POST"],
    handle: (announcementMatch: RegExpMatchArray) =>
      announcementHandlers.dismissAnnouncement(
        env,
        request,
        decodeURIComponent(announcementMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/achievements",
    method: "GET",
    handle: () =>
      achievementHandlers.getAchievements(env, request),
  },

  // 排行榜：?board=newapi|community|feedback|achievement（community 再带 ?metric=posts|likes|comments）
  {
    kind: "exact",
    path: "/leaderboard",
    method: "GET",
    handle: () =>
      leaderboardHandlers.getLeaderboard(env, request),
  },

  // ---- 个人空间（公开主页）----
  //
  // ⚠️ 顺序有意义：`/space/<用户名>/card` 必须排在 `/space/<用户名>` 之前，
  // 否则 `card` 会被当成用户名（路由表是按数组顺序匹配的）。
  //
  // 这两个读接口**无需登录**：空间页是给人分享的（社区里点头像就进得来）。
  // 访客能看什么由服务端裁切：帖子看「允许访客访问社区」开关，
  // 捐献详情一律打码（见 handlers/space.ts 的隐私说明）。
  {
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/space\/([^/]+)\/card$/),
    // branch 里必须自己判 method，未命中要返回 null（否则会把其它方法吞掉）
    handle: (spaceCardMatch: RegExpMatchArray, method: string) =>
      method === "GET"
        ? spaceHandlers.getSpaceCard(env, request, decodeURIComponent(spaceCardMatch[1]))
        : null,
  },
  {
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/space\/([^/]+)$/),
    handle: (spaceMatch: RegExpMatchArray, method: string) =>
      method === "GET"
        ? spaceHandlers.getSpace(env, request, decodeURIComponent(spaceMatch[1]))
        : null,
  },
  // 我自己的展示设置（要登录）
  {
    kind: "exact",
    path: "/my-space",
    method: "GET",
    handle: () => spaceHandlers.getMySpace(env, request),
  },
  {
    kind: "exact",
    path: "/my-space",
    method: "PUT",
    handle: () => spaceHandlers.updateMySpace(env, request),
  },

  {
    kind: "exact",
    path: "/admin/announcements",
    method: "GET",
    handle: () =>
      announcementHandlers.listAllAnnouncements(env, request),
  },

  {
    kind: "exact",
    path: "/admin/announcements",
    method: "POST",
    handle: () =>
      announcementHandlers.createAnnouncement(env, request, ctx),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/announcements\/([^/]+)\/resend$/),
    methods: ["POST"],
    handle: (announcementResendMatch: RegExpMatchArray) =>
      announcementHandlers.resendAnnouncementMails(
        env,
        request,
        decodeURIComponent(announcementResendMatch[1]),
        ctx
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/announcements\/([^/]+)$/),
    methods: ["PUT"],
    handle: (announcementMatch: RegExpMatchArray) =>
      announcementHandlers.updateAnnouncement(
      env,
      request,
      decodeURIComponent(announcementMatch[1]),
      ctx
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/announcements\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (announcementMatch: RegExpMatchArray) =>
      announcementHandlers.deleteAnnouncement(
      env,
      request,
      decodeURIComponent(announcementMatch[1])
      ),
  },

  // ---- 有趣的网页分享（工具箱里的精选外链，内容由管理面板维护）----
  {
    kind: "exact",
    path: "/fun-links",
    method: "GET",
    handle: () => funLinkHandlers.listFunLinks(env, request),
  },

  {
    kind: "exact",
    path: "/admin/fun-links",
    method: "GET",
    handle: () => funLinkHandlers.adminListFunLinks(env, request),
  },

  {
    kind: "exact",
    path: "/admin/fun-links",
    method: "POST",
    handle: () => funLinkHandlers.createFunLink(env, request),
  },

  // 自动识别：服务端去把对方的标题 / 描述 / 图标抓回来（管理面板「自动识别」按钮）
  {
    kind: "exact",
    path: "/admin/fun-links/probe",
    method: "POST",
    handle: () => funLinkProbeHandlers.probeFunLink(env, request),
  },

  // 图标代理：只认库里存过的图标地址，不是开放代理
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/fun-links\/icon\/([^/]+)$/),
    methods: ["GET"],
    handle: (iconMatch: RegExpMatchArray) =>
      funLinkProbeHandlers.getFunLinkIcon(env, request, decodeURIComponent(iconMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/fun-links\/([^/]+)$/),
    methods: ["PUT"],
    handle: (funLinkMatch: RegExpMatchArray) =>
      funLinkHandlers.updateFunLink(env, request, decodeURIComponent(funLinkMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/fun-links\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (funLinkMatch: RegExpMatchArray) =>
      funLinkHandlers.deleteFunLink(env, request, decodeURIComponent(funLinkMatch[1])),
  },

  // ---- 自定义称号（徽章式，管理面板维护 + 授予指定用户）----
  {
    kind: "exact",
    path: "/admin/titles",
    method: "GET",
    handle: () => titleHandlers.listTitles(env, request),
  },

  {
    kind: "exact",
    path: "/admin/titles",
    method: "POST",
    handle: () => titleHandlers.createTitle(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/titles\/([^/]+)$/),
    methods: ["PUT"],
    handle: (titleMatch: RegExpMatchArray) =>
      titleHandlers.updateTitle(env, request, decodeURIComponent(titleMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/titles\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (titleMatch: RegExpMatchArray) =>
      titleHandlers.deleteTitle(env, request, decodeURIComponent(titleMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/titles\/([^/]+)\/grant$/),
    methods: ["POST"],
    handle: (titleMatch: RegExpMatchArray) =>
      titleHandlers.grantTitle(env, request, decodeURIComponent(titleMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/titles\/([^/]+)\/revoke$/),
    methods: ["POST"],
    handle: (titleMatch: RegExpMatchArray) =>
      titleHandlers.revokeTitle(env, request, decodeURIComponent(titleMatch[1])),
  },

  // ---- 用户反馈（私有工单；管理端回复）----
  {
    kind: "exact",
    path: "/admin/feedback",
    method: "GET",
    handle: () =>
      feedbackHandlers.listAllFeedback(env, request),
  },

  {
    kind: "exact",
    path: "/admin/feedback/reply",
    method: "POST",
    handle: () =>
      feedbackHandlers.replyFeedback(env, request),
  },

  {
    kind: "exact",
    path: "/admin/feedback/status",
    method: "POST",
    handle: () =>
      feedbackHandlers.setFeedbackStatus(env, request),
  },

  {
    kind: "exact",
    path: "/admin/feedback/delete",
    method: "POST",
    handle: () =>
      feedbackHandlers.deleteFeedback(env, request),
  },

  {
    kind: "exact",
    path: "/admin/r2/buckets",
    method: "GET",
    handle: () =>
      r2AdminHandlers.listR2Buckets(env, request),
  },

  {
    kind: "exact",
    path: "/admin/r2/discover",
    method: "GET",
    handle: () =>
      r2AdminHandlers.discoverBuckets(env, request),
  },

  {
    kind: "exact",
    path: "/admin/r2/buckets",
    method: "POST",
    handle: () =>
      r2AdminHandlers.createR2Bucket(env, request),
  },

  {
    kind: "exact",
    path: "/admin/r2/assign",
    method: "PUT",
    handle: () =>
      r2AdminHandlers.assignUserBucket(env, request),
  },

  {
    kind: "exact",
    path: "/admin/r2/assign-all",
    method: "PUT",
    handle: () =>
      r2AdminHandlers.assignAllUnassigned(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/r2\/buckets\/([^/]+)$/),
    methods: ["PUT"],
    handle: (r2BucketMatch: RegExpMatchArray) =>
      r2AdminHandlers.updateR2Bucket(
      env,
      request,
      decodeURIComponent(r2BucketMatch[1])
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/r2\/buckets\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (r2BucketMatch: RegExpMatchArray) =>
      r2AdminHandlers.deleteR2Bucket(
      env,
      request,
      decodeURIComponent(r2BucketMatch[1])
      ),
  },

  {
    kind: "branch",
    match: (routePath: string) => routePath.match(
    /^\/admin\/r2\/buckets\/([^/]+)\/(test|write-test|operations)$/
  ),
    handle: (r2BucketActionMatch: RegExpMatchArray, method: string) => {
      const bucketId = decodeURIComponent(r2BucketActionMatch[1])
      const action = r2BucketActionMatch[2]
      if (action === "test" && method === "POST") {
        return r2AdminHandlers.testR2Bucket(env, request, bucketId)
      }
      else if (action === "write-test" && method === "POST") {
        return r2AdminHandlers.writeTestR2Bucket(env, request, bucketId)
      }
      else if (action === "operations" && method === "GET") {
        return r2AdminHandlers.getR2Operations(env, request, bucketId)
      }
      return null
    },
  },

  {
    kind: "exact",
    path: "/admin/settings",
    method: "GET",
    handle: () =>
      adminHandlers.getSettingsHandler(env, request),
  },

  {
    kind: "exact",
    path: "/admin/settings",
    method: "PUT",
    handle: () =>
      adminHandlers.updateSettingsHandler(env, request),
  },

  // ================= 管理端 · AI 实验室配置 =================
  // 单独一对接口（而不是走 /admin/settings）：这里要处理密钥加密、
  // 渠道增删合并这类有自己的规则，塞进通用设置接口只会让它更难读。

  {
    kind: "exact",
    path: "/admin/lab/config",
    method: "GET",
    handle: () => adminLabHandlers.getLabConfig(env, request),
  },

  {
    kind: "exact",
    path: "/admin/lab/config",
    method: "PUT",
    handle: () => adminLabHandlers.updateLabConfig(env, request),
  },

  // ---- 系统提示词模板（管理端 CRUD）----
  {
    kind: "exact",
    path: "/admin/lab/templates",
    method: "GET",
    handle: () => labPromptHandlers.listPromptTemplates(env, request),
  },

  // ---- 联网搜索：站点 key + 计费（管理端）----
  {
    kind: "exact",
    path: "/admin/lab/search",
    method: "GET",
    handle: () => labSearchHandlers.getSearchConfig(env, request),
  },

  {
    kind: "exact",
    path: "/admin/lab/search",
    method: "PUT",
    handle: () => labSearchHandlers.updateSearchConfig(env, request),
  },

  {
    kind: "exact",
    path: "/admin/lab/search/quota",
    method: "POST",
    handle: () => labSearchHandlers.checkSearchQuota(env, request),
  },

  // ---- 技能：站点默认（管理端 CRUD）----
  {
    kind: "exact",
    path: "/admin/lab/skills",
    method: "GET",
    handle: () => labSkillHandlers.listAdminSkills(env, request),
  },

  {
    kind: "exact",
    path: "/admin/lab/skills",
    method: "POST",
    handle: () => labSkillHandlers.createAdminSkill(env, request),
  },

  // 同 templates：一条路径接 PUT / DELETE 两种 method ⇒ 只能用 branch
  {
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/admin\/lab\/skills\/([^/]+)$/),
    handle: (skillMatch: RegExpMatchArray, method: string) => {
      const sid = decodeURIComponent(skillMatch[1])
      if (method === "DELETE") return labSkillHandlers.deleteAdminSkill(env, request, sid)
      if (method === "PUT") return labSkillHandlers.updateAdminSkill(env, request, sid)
      return null
    },
  },

  {
    kind: "exact",
    path: "/admin/lab/templates",
    method: "POST",
    handle: () => labPromptHandlers.createPromptTemplate(env, request),
  },

  // ⚠️ 与上面的 exact 不冲突：`[^/]+` 不含斜杠，`/admin/lab/templates/<id>` 走这条。
  //    一条路径要接两种 method ⇒ 必须用 branch（regex 那种只认 `methods` 数组、
  //    且 handle 拿不到具体是哪个 method，分不出 PUT / DELETE）。
  {
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/admin\/lab\/templates\/([^/]+)$/),
    handle: (promptMatch: RegExpMatchArray, method: string) => {
      const id = decodeURIComponent(promptMatch[1])
      if (method === "DELETE") return labPromptHandlers.deletePromptTemplate(env, request, id)
      if (method === "PUT") return labPromptHandlers.updatePromptTemplate(env, request, id)
      return null
    },
  },

  // ---- 造物集作品审核队列 ----
  {
    kind: "exact",
    path: "/admin/lab/reviews",
    method: "GET",
    handle: () => adminLabHandlers.listLabReviews(env, request),
  },

  // ⚠️ 必须排在 `/admin/lab/reviews` 之后也无妨（exact 与 regex 互不干扰），
  //    但 `[^/]+` 不含斜杠，所以 `/admin/lab/reviews/<id>` 不会被 exact 那条吃掉。
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/lab\/reviews\/([^/]+)$/),
    methods: ["POST"],
    handle: (labReviewMatch: RegExpMatchArray) =>
      adminLabHandlers.reviewLabProject(
        env,
        request,
        decodeURIComponent(labReviewMatch[1])
      ),
  },

  // ---- 待审作品预览（管理员看内容才能审）----
  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/admin\/lab\/reviews\/([^/]+)\/preview$/),
    methods: ["GET"],
    handle: (labPreviewMatch: RegExpMatchArray) =>
      adminLabHandlers.previewLabReview(
        env,
        request,
        decodeURIComponent(labPreviewMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/admin/community/posts",
    method: "GET",
    handle: () =>
      adminHandlers.adminListPosts(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/community\/posts\/([^/]+)\/restore$/),
    methods: ["POST"],
    handle: (adminCommunityRestoreMatch: RegExpMatchArray) =>
      adminHandlers.adminRestorePost(env, request, decodeURIComponent(adminCommunityRestoreMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/community\/posts\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (adminCommunityPostMatch: RegExpMatchArray) =>
      adminHandlers.adminDeletePost(env, request, decodeURIComponent(adminCommunityPostMatch[1])),
  },

  {
    kind: "exact",
    path: "/admin/storage/recalculate",
    method: "POST",
    handle: () =>
      adminHandlers.recalculateStorage(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/storage\/purge\/([^/]+)$/),
    methods: ["POST"],
    handle: (adminPurgeMatch: RegExpMatchArray) =>
      adminHandlers.purgeStorage(
      env,
      request,
      decodeURIComponent(adminPurgeMatch[1])
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/storage\/quota\/([^/]+)$/),
    methods: ["PUT"],
    handle: (adminStorageQuotaMatch: RegExpMatchArray) =>
      adminHandlers.updateStorageQuota(
        env,
        request,
        decodeURIComponent(adminStorageQuotaMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/admin/storage/sync-quota",
    method: "POST",
    handle: () => adminHandlers.syncStorageQuotas(env, request),
  },

  {
    kind: "exact",
    path: "/mailbox",
    method: "GET",
    handle: () =>
      emailHandlers.listMailboxes(env, request),
  },

  {
    kind: "exact",
    path: "/mailbox",
    method: "POST",
    handle: () =>
      emailHandlers.createMailbox(env, request),
  },

  // ⚠️ 这两条临时邮箱路由必须排在下面的 `/mailbox/:id` 正则之前。
  // 虽然 `/mailbox/temp` 用的是 POST、而那条正则可变方法只有 PUT/DELETE，
  // 眼下不会真的撞上，但把它写在前面才是「读一眼就知道不冲突」的顺序。
  {
    kind: "exact",
    path: "/mailbox/temp",
    method: "POST",
    handle: () =>
      emailHandlers.createTempMailbox(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/mailbox\/temp\/([^/]+)\/refresh$/),
    methods: ["POST"],
    handle: (tempRefreshMatch: RegExpMatchArray) =>
      emailHandlers.refreshTempMailbox(env, request, decodeURIComponent(tempRefreshMatch[1])),
  },

  // 转发目标验证：必须排在下面的 /mailbox/:id 正则之前（否则被 :id 吃掉）
  {
    kind: "exact",
    path: "/mailbox/forward-verify",
    method: "POST",
    handle: () =>
      emailHandlers.verifyForwardTarget(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/mailbox\/([^/]+)$/),
    methods: ["PUT"],
    handle: (mailboxMatch: RegExpMatchArray) =>
      emailHandlers.updateMailbox(env, request, decodeURIComponent(mailboxMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/mailbox\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (mailboxMatch: RegExpMatchArray) =>
      emailHandlers.deleteMailbox(env, request, decodeURIComponent(mailboxMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/mailbox\/([^/]+)\/messages$/),
    methods: ["GET"],
    handle: (mailboxMessagesMatch: RegExpMatchArray) =>
      emailHandlers.listMessages(env, request, decodeURIComponent(mailboxMessagesMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/mailbox\/([^/]+)\/messages\/([^/]+)$/),
    methods: ["GET"],
    handle: (messageMatch: RegExpMatchArray) =>
      emailHandlers.getMessage(
      env,
      request,
      decodeURIComponent(messageMatch[1]),
      decodeURIComponent(messageMatch[2])
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/mailbox\/([^/]+)\/messages\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (messageMatch: RegExpMatchArray) =>
      emailHandlers.deleteMessage(
      env,
      request,
      decodeURIComponent(messageMatch[1]),
      decodeURIComponent(messageMatch[2])
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/mailbox\/([^/]+)\/messages\/([^/]+)\/read$/),
    methods: ["POST"],
    handle: (messageReadMatch: RegExpMatchArray) =>
      emailHandlers.markMessage(
      env,
      request,
      decodeURIComponent(messageReadMatch[1]),
      decodeURIComponent(messageReadMatch[2])
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/mailbox\/([^/]+)\/messages\/batch-delete$/),
    methods: ["POST"],
    handle: (batchDeleteMatch: RegExpMatchArray) =>
      emailHandlers.batchDeleteMessages(env, request, decodeURIComponent(batchDeleteMatch[1])),
  },

  // 站内互发（只发给本站根域邮箱；直接落对方收件箱，不需付费 Email Sending）
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/mailbox\/([^/]+)\/send$/),
    methods: ["POST"],
    handle: (sendMatch: RegExpMatchArray) =>
      emailHandlers.sendInternalMessage(env, request, decodeURIComponent(sendMatch[1])),
  },

  {
    kind: "exact",
    path: "/mailbox/read-all",
    method: "POST",
    handle: () =>
      emailHandlers.markAllRead(env, request),
  },

  {
    kind: "exact",
    path: "/donations",
    method: "GET",
    handle: () =>
      donationHandlers.listDonations(env, request),
  },

  {
    kind: "exact",
    path: "/donations",
    method: "POST",
    handle: () =>
      donationHandlers.createDonation(env, request),
  },

  // 探测上游取模型列表（AI 渠道捐献：自动获取模型让用户勾选）
  // 必须排在下面的 /donations/:id 正则之前 —— 虽然 `[^/]+` 匹配不到两段路径，
  // 但保持「更具体的在前」这条约定，避免以后把正则放宽时被吃掉。
  {
    kind: "exact",
    path: "/donations/ai/probe",
    method: "POST",
    handle: () =>
      donationHandlers.probeAiUpstream(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/donations\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (donationMatch: RegExpMatchArray) =>
      donationHandlers.cancelDonation(env, request, decodeURIComponent(donationMatch[1])),
  },

  // ---- 用户反馈（私有工单）----
  // /feedback/read 必须排在下面 /feedback 的 POST 之前：两者路径不同（前者多一段），
  // 但保持「更具体的在前」这条约定，免得以后加 /feedback/:id 时顺序被搞混。
  {
    kind: "exact",
    path: "/feedback/read",
    method: "POST",
    handle: () =>
      feedbackHandlers.markFeedbackRead(env, request),
  },

  {
    kind: "exact",
    path: "/feedback/upload-image",
    method: "POST",
    handle: () =>
      feedbackHandlers.uploadFeedbackImage(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/feedback\/image\/([^/]+)\/([^/]+)$/),
    methods: ["GET"],
    handle: (m: RegExpMatchArray) =>
      feedbackHandlers.serveFeedbackImage(
        env,
        request,
        decodeURIComponent(m[1]),
        decodeURIComponent(m[2])
      ),
  },

  // ---- 聊天图片（私聊 / 聊天室 / 广场帖子与评论共用）----
  // 与反馈图片分开：反馈图是私有工单附件（只有本人+管理员能看），
  // 聊天图要能被会话双方看到，鉴权口径不同。详见 handlers/chat-upload.ts 头部说明。
  {
    kind: "exact",
    path: "/chat/upload-image",
    method: "POST",
    handle: () => chatUploadHandlers.uploadChatImage(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/chat\/image\/([^/]+)\/([^/]+)$/),
    methods: ["GET"],
    handle: (m: RegExpMatchArray) =>
      chatUploadHandlers.serveChatImage(
        env,
        request,
        decodeURIComponent(m[1]),
        decodeURIComponent(m[2])
      ),
  },

  {
    kind: "exact",
    path: "/feedback/reply",
    method: "POST",
    handle: () =>
      feedbackHandlers.replyMyFeedback(env, request),
  },

  {
    kind: "exact",
    path: "/feedback",
    method: "GET",
    handle: () =>
      feedbackHandlers.listMyFeedback(env, request),
  },

  {
    kind: "exact",
    path: "/feedback",
    method: "POST",
    handle: () =>
      feedbackHandlers.createFeedback(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/feedback\/([0-9a-f-]{36})$/),
    methods: ["PATCH"],
    handle: (m: RegExpMatchArray) =>
      feedbackHandlers.editMyFeedback(env, request, m[1]),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/feedback\/([0-9a-f-]{36})$/),
    methods: ["DELETE"],
    handle: (m: RegExpMatchArray) =>
      feedbackHandlers.withdrawMyFeedback(env, request, m[1]),
  },

  // ---- 权限兑换码（首捐奖励券 / 用邀请码补权限）----
  {
    kind: "exact",
    path: "/vouchers",
    method: "GET",
    handle: () =>
      voucherHandlers.listMyVouchers(env, request),
  },

  {
    kind: "exact",
    path: "/vouchers/redeem",
    method: "POST",
    handle: () =>
      voucherHandlers.redeem(env, request),
  },

  // ---- WorkBuddy 反代账号捐献（登录即解锁 AI 权限，免审核）----
  {
    kind: "exact",
    path: "/wb2api/status",
    method: "GET",
    handle: () =>
      wb2apiHandlers.getStatus(env, request),
  },

  {
    kind: "exact",
    path: "/wb2api/login/start",
    method: "POST",
    handle: () =>
      wb2apiHandlers.loginStart(env, request),
  },

  {
    kind: "exact",
    path: "/wb2api/login/poll",
    method: "GET",
    handle: () =>
      wb2apiHandlers.loginPoll(env, request),
  },

  // ---- Qoder2API 反代账号捐献（第二条，登录即解锁 AI 权限，免审核）----
  {
    kind: "exact",
    path: "/qoder2api/status",
    method: "GET",
    handle: () =>
      qoder2apiHandlers.getStatus(env, request),
  },

  {
    kind: "exact",
    path: "/qoder2api/login/start",
    method: "POST",
    handle: () =>
      qoder2apiHandlers.loginStart(env, request),
  },

  {
    kind: "exact",
    path: "/qoder2api/login/poll",
    method: "GET",
    handle: () =>
      qoder2apiHandlers.loginPoll(env, request),
  },

  {
    kind: "exact",
    path: "/profile",
    method: "GET",
    handle: () =>
      profileHandlers.getProfile(env, request),
  },

  {
    kind: "exact",
    path: "/profile/enable",
    method: "POST",
    handle: () =>
      profileHandlers.enableProfile(env, request),
  },

  {
    kind: "exact",
    path: "/profile",
    method: "PUT",
    handle: () =>
      profileHandlers.updateProfile(env, request),
  },

  {
    kind: "exact",
    path: "/profile/music/search",
    method: "GET",
    handle: () =>
      profileHandlers.searchMusicTracks(env, request),
  },

  {
    kind: "exact",
    path: "/profile/music/lyrics",
    method: "GET",
    handle: () =>
      profileHandlers.fetchMusicLyrics(env, request),
  },

  {
    kind: "exact",
    path: "/profile/preview",
    method: "POST",
    handle: () =>
      profileHandlers.previewProfile(env, request),
  },

  {
    kind: "exact",
    path: "/profile/publish",
    method: "POST",
    handle: () =>
      profileHandlers.setPublished(env, request),
  },

  {
    kind: "exact",
    path: "/profile/asset",
    method: "POST",
    handle: () =>
      profileHandlers.uploadAsset(env, request),
  },

  {
    kind: "exact",
    path: "/profile/asset",
    method: "DELETE",
    handle: () =>
      profileHandlers.deleteAsset(env, request),
  },

  {
    kind: "exact",
    path: "/profile/asset",
    method: "GET",
    handle: () =>
      profileHandlers.readOwnAsset(env, request),
  },

  {
    kind: "exact",
    path: "/profile/domain",
    method: "POST",
    handle: () =>
      profileHandlers.bindProfileDomain(env, request),
  },

  {
    kind: "exact",
    path: "/community/config",
    method: "GET",
    handle: () =>
      communityHandlers.communityConfig(env, request),
  },
  {
    kind: "exact",
    path: "/community/new-posts-count",
    method: "GET",
    handle: () =>
      communityHandlers.newPostsCount(env, request),
  },
  // 链接预览卡片（markdown.tsx 的 LinkCard 会调）。
  //
  // ⚠️ 2026-09-25 审计（F4）：handler 早就写好了、还带 M9 的限流，
  // 但**路由一直没接** —— 前端调用固定 404，被 `.catch` 吞掉后回退成普通链接，
  // 表现为「链接卡片功能做了但从来不出卡片」，且没有任何报错提示。
  // index.ts 之前被另一个 AI 占用，所以只记在 check-api-paths.mjs 的 KNOWN_GAPS 里。
  {
    kind: "exact",
    path: "/community/link-preview",
    method: "GET",
    handle: () =>
      communityHandlers.linkPreview(env, request),
  },
  // 标记「我刚打开过社区」，用于把新帖角标清零
  {
    kind: "exact",
    path: "/community/seen",
    method: "POST",
    handle: () =>
      communityHandlers.markCommunitySeen(env, request),
  },
  // 角标汇总：侧边栏（社区/聊天室/反馈/管理）与管理面板各栏目共用一次请求
  {
    kind: "exact",
    path: "/attention",
    method: "GET",
    handle: () => attentionHandlers.getAttention(env, request),
  },

  // ---- 公共聊天室 ----
  {
    kind: "exact",
    path: "/chat/messages",
    method: "GET",
    handle: () =>
      chatHandlers.listMessages(env, request),
  },
  {
    kind: "exact",
    path: "/chat/messages",
    method: "POST",
    handle: () =>
      chatHandlers.sendMessage(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/chat\/messages\/([^/]+)\/recall$/),
    methods: ["POST"],
    handle: (chatRecallMatch: RegExpMatchArray) =>
      chatHandlers.recallMessage(env, request, decodeURIComponent(chatRecallMatch[1])),
  },
  {
    // 表情回应开关（toggle）
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/chat\/messages\/([^/]+)\/reactions$/),
    methods: ["POST"],
    handle: (chatReactMatch: RegExpMatchArray) =>
      chatHandlers.toggleReaction(env, request, decodeURIComponent(chatReactMatch[1])),
  },
  {
    // 编辑自己的消息（10 分钟内）
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/chat\/messages\/([^/]+)\/edit$/),
    methods: ["POST"],
    handle: (chatEditMatch: RegExpMatchArray) =>
      chatHandlers.editMessage(env, request, decodeURIComponent(chatEditMatch[1])),
  },
  {
    kind: "exact",
    path: "/chat/heartbeat",
    method: "POST",
    handle: () =>
      chatHandlers.heartbeat(env, request),
  },
  {
    kind: "exact",
    path: "/chat/presence",
    method: "GET",
    handle: () =>
      chatHandlers.presence(env, request),
  },
  // 侧边栏「聊天室」角标：我看过之后的新消息数
  {
    kind: "exact",
    path: "/chat/unread",
    method: "GET",
    handle: () =>
      chatHandlers.unreadCount(env, request),
  },
  // 标记「我刚打开过聊天室」，用于把新消息角标清零
  {
    kind: "exact",
    path: "/chat/seen",
    method: "POST",
    handle: () =>
      chatHandlers.markChatSeen(env, request),
  },
  // 「正在输入」心跳（前端 5 秒节流上报，消息轮询顺带下发）
  {
    kind: "exact",
    path: "/chat/typing",
    method: "POST",
    handle: () =>
      chatHandlers.typing(env, request),
  },

  // ---- 一对一私信（2026-10-01）----
  {
    kind: "exact",
    path: "/dm/conversations",
    method: "GET",
    handle: () => dmHandlers.listConversations(env, request),
  },
  {
    kind: "exact",
    path: "/dm/unread",
    method: "GET",
    handle: () => dmHandlers.dmUnreadCount(env, request),
  },
  {
    // 我收到的待处理聊天申请（2026-10-01）
    kind: "exact",
    path: "/dm/requests",
    method: "GET",
    handle: () => dmHandlers.listDmRequests(env, request),
  },
  {
    // 同意 / 拒绝聊天申请
    kind: "exact",
    path: "/dm/requests",
    method: "POST",
    handle: () => dmHandlers.respondDmRequest(env, request),
  },
  {
    kind: "exact",
    path: "/dm/seen",
    method: "POST",
    handle: () => dmHandlers.markDmSeen(env, request),
  },
  {
    kind: "exact",
    path: "/dm",
    method: "GET",
    handle: () => dmHandlers.listDm(env, request),
  },
  {
    kind: "exact",
    path: "/dm",
    method: "POST",
    handle: () => dmHandlers.sendDm(env, request),
  },
  {
    // 撤回私信（与 /chat/messages/:id/recall 同构）
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/dm\/messages\/([^/]+)\/recall$/),
    methods: ["POST"],
    handle: (dmRecallMatch: RegExpMatchArray) =>
      dmHandlers.recallDm(env, request, decodeURIComponent(dmRecallMatch[1])),
  },
  {
    // 表情回应开关（toggle）
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/dm\/messages\/([^/]+)\/reactions$/),
    methods: ["POST"],
    handle: (dmReactMatch: RegExpMatchArray) =>
      dmHandlers.toggleReactionDm(env, request, decodeURIComponent(dmReactMatch[1])),
  },
  {
    // 编辑自己的私信（10 分钟内）
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/dm\/messages\/([^/]+)\/edit$/),
    methods: ["POST"],
    handle: (dmEditMatch: RegExpMatchArray) =>
      dmHandlers.editDm(env, request, decodeURIComponent(dmEditMatch[1])),
  },
  {
    // 「我正在给对端打字」心跳（5 秒节流上报，listDm 顺带下发 peerTyping）
    kind: "exact",
    path: "/dm/typing",
    method: "POST",
    handle: () => dmHandlers.typingDm(env, request),
  },

  // ---- 用户表情包（社区/私信编辑器里快捷发送）----
  {
    kind: "exact",
    path: "/stickers",
    method: "GET",
    handle: () => stickerHandlers.listStickers(env, request),
  },

  {
    kind: "exact",
    path: "/stickers",
    method: "POST",
    handle: () => stickerHandlers.uploadSticker(env, request),
  },

  {
    kind: "exact",
    path: "/stickers/save",
    method: "POST",
    handle: () => stickerHandlers.saveSticker(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/stickers\/([0-9a-f-]{36})\/image$/),
    methods: ["GET"],
    handle: (stickerImgMatch: RegExpMatchArray) =>
      stickerHandlers.serveSticker(env, request, stickerImgMatch[1]),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/stickers\/([0-9a-f-]{36})$/),
    methods: ["DELETE"],
    handle: (stickerMatch: RegExpMatchArray) =>
      stickerHandlers.deleteSticker(env, request, stickerMatch[1]),
  },

  {
    kind: "exact",
    path: "/community/posts",
    method: "GET",
    handle: () =>
      communityHandlers.listPosts(env, request),
  },

  {
    kind: "exact",
    path: "/community/stats",
    method: "GET",
    handle: () =>
      communityHandlers.communityStats(env, request, ctx),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/comments$/),
    methods: ["GET"],
    handle: (communityCommentsMatch: RegExpMatchArray) =>
      communityHandlers.listComments(env, request, decodeURIComponent(communityCommentsMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)$/),
    methods: ["GET"],
    handle: (communityPostMatch: RegExpMatchArray) =>
      communityHandlers.getPost(env, request, decodeURIComponent(communityPostMatch[1])),
  },

  {
    kind: "exact",
    path: "/community/posts",
    method: "POST",
    handle: () =>
      communityHandlers.createPost(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/like$/),
    methods: ["POST"],
    handle: (communityLikeMatch: RegExpMatchArray) =>
      communityHandlers.toggleLike(env, request, decodeURIComponent(communityLikeMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/comments\/([^/]+)\/like$/),
    methods: ["POST"],
    handle: (communityCommentLikeMatch: RegExpMatchArray) =>
      communityHandlers.toggleCommentLike(env, request, decodeURIComponent(communityCommentLikeMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/share$/),
    methods: ["POST"],
    handle: (communityShareMatch: RegExpMatchArray) =>
      communityHandlers.sharePost(env, request, decodeURIComponent(communityShareMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (communityPostMatch: RegExpMatchArray) =>
      communityHandlers.deletePost(env, request, decodeURIComponent(communityPostMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)$/),
    methods: ["PUT"],
    handle: (communityPostMatch: RegExpMatchArray) =>
      communityHandlers.updatePost(env, request, decodeURIComponent(communityPostMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/edits$/),
    methods: ["GET"],
    handle: (communityPostMatch: RegExpMatchArray) =>
      communityHandlers.listPostEdits(env, request, decodeURIComponent(communityPostMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/comments$/),
    methods: ["POST"],
    handle: (communityCommentsMatch: RegExpMatchArray) =>
      communityHandlers.createComment(env, request, decodeURIComponent(communityCommentsMatch[1])),
  },

  {
    kind: "regex",
    // 管理员 / 站长置顶帖子（2026-10-01）
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/pin$/),
    methods: ["POST"],
    handle: (postPinMatch: RegExpMatchArray) =>
      communityHandlers.setPostPinned(env, request, decodeURIComponent(postPinMatch[1])),
  },
  {
    // 我持有的全部称号（个人空间里自己选展示哪一个；2026-10-01）
    kind: "exact",
    path: "/titles/mine",
    method: "GET",
    handle: () => titleHandlers.listMyTitles(env, request),
  },
  {
    // 设置对外展示的称号；titleId = null 表示一个都不展示
    kind: "exact",
    path: "/titles/display",
    method: "POST",
    handle: () => titleHandlers.setDisplayedTitle(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/images$/),
    methods: ["POST"],
    handle: (communityImageMatch: RegExpMatchArray) =>
      communityHandlers.uploadPostImage(env, request, decodeURIComponent(communityImageMatch[1])),
  },

  {
    // 编辑帖子时删除单张图片（含 R2 对象）。必须排在上面 POST /images 之前无所谓，
    // 方法不同不会冲突，但要在 /community/posts/:id 兜底 GET 之前。
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/images\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (communityImageDelMatch: RegExpMatchArray) =>
      communityHandlers.deletePostImage(
        env,
        request,
        decodeURIComponent(communityImageDelMatch[1]),
        decodeURIComponent(communityImageDelMatch[2])
      ),
  },

  {
    kind: "exact",
    path: "/notifications",
    method: "GET",
    handle: () =>
      communityHandlers.listNotifications(env, request),
  },

  {
    kind: "exact",
    path: "/notifications/unread-count",
    method: "GET",
    handle: () =>
      communityHandlers.unreadCount(env, request),
  },

  // 网页侧「零配置通知」用：只取最新一条未读（比拉整个列表轻）
  {
    kind: "exact",
    path: "/notifications/latest",
    method: "GET",
    handle: () =>
      communityHandlers.latestNotification(env, request),
  },

  {
    kind: "exact",
    path: "/notifications/read",
    method: "POST",
    handle: () =>
      communityHandlers.markRead(env, request),
  },

  // ---- 活动系统（消息中心「活动推广」）----
  {
    kind: "exact",
    path: "/events",
    method: "GET",
    handle: () => eventHandlers.listEvents(env, request),
  },
  // 历史投票：已结束的投票活动 + 结果（推广页的「历史投票」入口用它）。
  // ⚠️ 必须排在下面的 /events/:id（regex）之前 —— dispatch 按声明顺序取第一个命中，
  //    顺序反了这条会被当成 id = "vote-history"，直接 404。
  {
    kind: "exact",
    path: "/events/vote-history",
    method: "GET",
    handle: () => eventHandlers.listVoteHistory(env, request),
  },
  // 单个活动（公开）：活动分享链接 /activity/:id 用它拉数据
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/events\/([^/]+)$/),
    methods: ["GET"],
    handle: (eventGetMatch: RegExpMatchArray) =>
      eventHandlers.getEvent(env, request, decodeURIComponent(eventGetMatch[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/events\/([^/]+)\/claim$/),
    methods: ["POST"],
    handle: (eventClaimMatch: RegExpMatchArray) =>
      eventHandlers.claimEvent(env, request, decodeURIComponent(eventClaimMatch[1])),
  },
  {
    kind: "exact",
    path: "/admin/events",
    method: "GET",
    handle: () => eventHandlers.listAllEvents(env, request),
  },
  {
    kind: "exact",
    path: "/admin/events",
    method: "POST",
    handle: () => eventHandlers.createEvent(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/events\/([^/]+)\/claims\/([^/]+)\/grant$/),
    methods: ["POST"],
    handle: (eventGrantMatch: RegExpMatchArray) =>
      eventHandlers.grantEventClaim(
        env,
        request,
        decodeURIComponent(eventGrantMatch[1]),
        decodeURIComponent(eventGrantMatch[2])
      ),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/events\/([^/]+)\/claims$/),
    methods: ["GET"],
    handle: (eventClaimsMatch: RegExpMatchArray) =>
      eventHandlers.listEventClaims(env, request, decodeURIComponent(eventClaimsMatch[1])),
  },
  // 抽奖开奖（手动）：从报名者里随机抽人发积分；已开过奖会返回 409
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/events\/([^/]+)\/draw$/),
    methods: ["POST"],
    handle: (eventDrawMatch: RegExpMatchArray) =>
      eventHandlers.adminDrawEvent(env, request, decodeURIComponent(eventDrawMatch[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/events\/([^/]+)$/),
    methods: ["PUT"],
    handle: (eventMatch: RegExpMatchArray) =>
      eventHandlers.updateEvent(env, request, decodeURIComponent(eventMatch[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/events\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (eventMatch: RegExpMatchArray) =>
      eventHandlers.deleteEvent(env, request, decodeURIComponent(eventMatch[1])),
  },
  {
    // 投票选项配图上传（管理员）：返回可直接填进选项 image 字段的同源 URL
    kind: "exact",
    path: "/admin/events/image",
    method: "POST",
    handle: () => eventHandlers.uploadEventImage(env, request),
  },
  {
    // 选项配图公开读取。⚠️ 与 /shop-img/* 同理，必须挂在 /api 前缀下才会进 API Worker。
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/event-img\/([^/]+)\/([^/]+)$/),
    methods: ["GET"],
    handle: (eventImgMatch: RegExpMatchArray) =>
      eventHandlers.serveEventImage(
        env,
        decodeURIComponent(eventImgMatch[1]),
        decodeURIComponent(eventImgMatch[2])
      ),
  },

  // ---- 积分系统（余额 / 流水 / 兑换中转站余额）----
  {
    kind: "exact",
    path: "/points",
    method: "GET",
    handle: () => pointHandlers.getPoints(env, request),
  },
  {
    kind: "exact",
    path: "/points/redeem",
    method: "POST",
    handle: () => pointHandlers.redeem(env, request),
  },

  // ---- 每日签到 ----
  {
    kind: "exact",
    path: "/checkin",
    method: "GET",
    handle: () => checkinHandlers.getCheckinStatus(env, request),
  },
  {
    kind: "exact",
    path: "/checkin",
    method: "POST",
    handle: () => checkinHandlers.doCheckin(env, request),
  },
  {
    kind: "exact",
    path: "/checkin/makeup",
    method: "POST",
    handle: () => checkinHandlers.makeupCheckin(env, request),
  },
  {
    kind: "exact",
    path: "/checkin/auto",
    method: "POST",
    handle: () => checkinHandlers.setAutoCheckin(env, request),
  },
  {
    kind: "exact",
    path: "/checkin/history",
    method: "GET",
    handle: () => checkinHandlers.getCheckinHistory(env, request),
  },

  // ---- 公开 API（API Key 认证 + 限额）----
  // DNS：列表 / 创建 / 编辑 / 删除
  {
    kind: "exact",
    path: "/v1/dns",
    method: "GET",
    handle: () => publicApiHandlers.apiListDns(env, request),
  },
  {
    kind: "exact",
    path: "/v1/dns",
    method: "POST",
    handle: () => publicApiHandlers.apiCreateDns(env, request),
  },
  {
    kind: "regex",
    match: (p: string) => p.match(/^\/v1\/dns\/([^/]+)$/),
    methods: ["PUT"],
    handle: (m: RegExpMatchArray) => publicApiHandlers.apiUpdateDns(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (p: string) => p.match(/^\/v1\/dns\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (m: RegExpMatchArray) => publicApiHandlers.apiDeleteDns(env, request, decodeURIComponent(m[1])),
  },
  // 子域名：列表 / 创建 / 删除（在站点根域名下开 xxx.doulor.cn）
  {
    kind: "exact",
    path: "/v1/subdomain",
    method: "GET",
    handle: () => publicApiHandlers.apiListSubdomain(env, request),
  },
  {
    kind: "exact",
    path: "/v1/subdomain",
    method: "POST",
    handle: () => publicApiHandlers.apiCreateSubdomain(env, request),
  },
  {
    kind: "regex",
    match: (p: string) => p.match(/^\/v1\/subdomain\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (m: RegExpMatchArray) => publicApiHandlers.apiDeleteSubdomain(env, request, decodeURIComponent(m[1])),
  },
  // 邮箱：列表 / 创建 / 删除 / 邮件列表 / 邮件内容 / 回复
  {
    kind: "exact",
    path: "/v1/mailbox",
    method: "GET",
    handle: () => publicApiHandlers.apiListMailbox(env, request),
  },
  {
    kind: "exact",
    path: "/v1/mailbox",
    method: "POST",
    handle: () => publicApiHandlers.apiCreateMailbox(env, request),
  },
  {
    kind: "regex",
    match: (p: string) => p.match(/^\/v1\/mailbox\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (m: RegExpMatchArray) => publicApiHandlers.apiDeleteMailbox(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (p: string) => p.match(/^\/v1\/mailbox\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (m: RegExpMatchArray) => publicApiHandlers.apiDeleteMailbox(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (p: string) => p.match(/^\/v1\/mailbox\/([^/]+)\/messages$/),
    methods: ["GET"],
    handle: (m: RegExpMatchArray) => publicApiHandlers.apiListMessages(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (p: string) => p.match(/^\/v1\/mailbox\/([^/]+)\/messages\/([^/]+)$/),
    methods: ["GET"],
    handle: (m: RegExpMatchArray) => publicApiHandlers.apiGetMessage(env, request, decodeURIComponent(m[1]), decodeURIComponent(m[2])),
  },
  // 临时邮箱：创建 / 刷新 / 读取收件内容
  {
    kind: "exact",
    path: "/v1/temp-mailbox",
    method: "POST",
    handle: () => publicApiHandlers.apiCreateTempMailbox(env, request),
  },
  {
    kind: "regex",
    match: (p: string) => p.match(/^\/v1\/temp-mailbox\/([^/]+)\/refresh$/),
    methods: ["POST"],
    handle: (m: RegExpMatchArray) => publicApiHandlers.apiRefreshTempMailbox(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (p: string) => p.match(/^\/v1\/temp-mailbox\/([^/]+)\/messages$/),
    methods: ["GET"],
    handle: (m: RegExpMatchArray) => publicApiHandlers.apiListTempMessages(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (p: string) => p.match(/^\/v1\/temp-mailbox\/([^/]+)\/messages\/([^/]+)$/),
    methods: ["GET"],
    handle: (m: RegExpMatchArray) => publicApiHandlers.apiGetTempMessage(env, request, decodeURIComponent(m[1]), decodeURIComponent(m[2])),
  },
  // Key 管理 + 文档（走 session，供设置页用）
  {
    kind: "exact",
    path: "/api-key",
    method: "GET",
    handle: () => publicApiHandlers.getApiKeyStatus(env, request),
  },
  {
    kind: "exact",
    path: "/api-key",
    method: "POST",
    handle: () => publicApiHandlers.generateApiKey(env, request),
  },
  {
    kind: "exact",
    path: "/api-key",
    method: "DELETE",
    handle: () => publicApiHandlers.deleteApiKey(env, request),
  },
  {
    kind: "exact",
    path: "/api-doc",
    method: "GET",
    handle: () => publicApiHandlers.getApiDoc(env, request),
  },
  // 管理面板「API」板块配置
  {
    kind: "exact",
    path: "/admin/api-config",
    method: "GET",
    handle: () => adminApiHandlers.getApiConfig(env, request),
  },
  {
    kind: "exact",
    path: "/admin/api-config",
    method: "POST",
    handle: () => adminApiHandlers.saveApiConfig(env, request),
  },
  // 用户间转账（只需转出方确认，凭用户名转给对方）
  {
    kind: "exact",
    path: "/points/transfer",
    method: "POST",
    handle: () => pointHandlers.transfer(env, request),
  },
  {
    kind: "exact",
    path: "/admin/points",
    method: "GET",
    handle: () => pointHandlers.listPointsOverview(env, request),
  },
  {
    kind: "exact",
    path: "/admin/points/adjust",
    method: "POST",
    handle: () => pointHandlers.adjustPoints(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/points\/([^/]+)\/history$/),
    methods: ["GET"],
    handle: (pointHistMatch: RegExpMatchArray) =>
      pointHandlers.userPointHistory(env, request, decodeURIComponent(pointHistMatch[1])),
  },

  // ---- 积分商城（商品 / 订单 / 兑换配置）----
  {
    kind: "exact",
    path: "/points/shop/buy",
    method: "POST",
    handle: () => pointHandlers.buyShopProduct(env, request),
  },

  // ---- 用户商城（用户自己上架 / 交付 / 确认收货）----
  {
    // 商品封面上传：返回可直接填进 imageUrl 的同源 URL（2026-10-01）
    kind: "exact",
    path: "/points/product/image",
    method: "POST",
    handle: () => pointHandlers.uploadProductImage(env, request),
  },
  {
    // 封面图公开读取。⚠️ 必须**挂在 /api 前缀下**：cloud.doulor.cn 只有 /api/*、
    // /c/*、/u/* 等 zone 路由会进 API Worker，自造新前缀（如 /shop-img/*）的请求
    // 根本到不了这里，会落到 SPA 的 index.html（2026-10-01 实测踩过）。
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/shop-img\/([^/]+)\/([^/]+)$/),
    methods: ["GET"],
    handle: (shopImgMatch: RegExpMatchArray) =>
      pointHandlers.serveShopImage(
        env,
        decodeURIComponent(shopImgMatch[1]),
        decodeURIComponent(shopImgMatch[2])
      ),
  },
  {
    kind: "exact",
    path: "/points/products",
    method: "POST",
    handle: () => pointHandlers.createMyProduct(env, request),
  },
  {
    // 带方法分流必须用 branch：regex kind 的 handle 只收 1 个参数，拿不到 method
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/points\/products\/([^/]+)$/),
    handle: (myProductMatch: RegExpMatchArray, method: string) => {
      const id = decodeURIComponent(myProductMatch[1])
      if (method === "PUT") return pointHandlers.updateMyProduct(env, request, id)
      if (method === "DELETE") return pointHandlers.deleteMyProduct(env, request, id)
      return null
    },
  },
  // 卖家自己的卡密池（用户商品 delivery='code'）：读概览 / 追加 / 清空未使用。
  // 所有权在 handler 里校验（只能动自己的商品）。
  {
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/points\/products\/([^/]+)\/codes$/),
    handle: (myCodesMatch: RegExpMatchArray, method: string) => {
      const id = decodeURIComponent(myCodesMatch[1])
      if (method === "GET") return pointHandlers.getMyProductCodes(env, request, id)
      if (method === "POST") return pointHandlers.addMyProductCodes(env, request, id)
      if (method === "DELETE") return pointHandlers.clearMyProductCodes(env, request, id)
      return null
    },
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/points\/products\/([^/]+)\/purchases$/),
    methods: ["GET"],
    handle: (shopPurchasesMatch: RegExpMatchArray) =>
      pointHandlers.getProductPurchases(env, request, decodeURIComponent(shopPurchasesMatch[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/points\/orders\/([^/]+)\/deliver$/),
    methods: ["POST"],
    handle: (myOrderDeliverMatch: RegExpMatchArray) =>
      pointHandlers.sellerDeliver(env, request, decodeURIComponent(myOrderDeliverMatch[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/points\/orders\/([^/]+)\/confirm$/),
    methods: ["POST"],
    handle: (myOrderConfirmMatch: RegExpMatchArray) =>
      pointHandlers.confirmReceipt(env, request, decodeURIComponent(myOrderConfirmMatch[1])),
  },
  // 售后（退款）：买家申请 / 撤销
  {
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/points\/orders\/([^/]+)\/after-sale$/),
    handle: (afterSaleMatch: RegExpMatchArray, method: string) => {
      const id = decodeURIComponent(afterSaleMatch[1])
      if (method === "POST") return pointHandlers.requestAfterSaleHandler(env, request, id)
      if (method === "DELETE") return pointHandlers.cancelAfterSaleHandler(env, request, id)
      return null
    },
  },
  // 售后：买家申请平台（管理员）介入
  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/points\/orders\/([^/]+)\/after-sale\/escalate$/),
    methods: ["POST"],
    handle: (afterSaleEscalateMatch: RegExpMatchArray) =>
      pointHandlers.escalateAfterSaleHandler(
        env,
        request,
        decodeURIComponent(afterSaleEscalateMatch[1])
      ),
  },
  // 拒收：买家没收到货 / 货不对板 → 直达平台介入（不用先向卖家申请退款）
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/points\/orders\/([^/]+)\/reject$/),
    methods: ["POST"],
    handle: (rejectMatch: RegExpMatchArray) =>
      pointHandlers.rejectDeliveryHandler(env, request, decodeURIComponent(rejectMatch[1])),
  },
  // 售后：卖家处理（同意退款 / 拒绝）
  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/points\/orders\/([^/]+)\/after-sale\/decide$/),
    methods: ["POST"],
    handle: (afterSaleDecideMatch: RegExpMatchArray) =>
      pointHandlers.sellerResolveAfterSaleHandler(
        env,
        request,
        decodeURIComponent(afterSaleDecideMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/admin/points/shop",
    method: "GET",
    handle: () => pointHandlers.getShopAdmin(env, request),
  },
  {
    kind: "exact",
    path: "/admin/points/config",
    method: "PUT",
    handle: () => pointHandlers.savePointsConfig(env, request),
  },
  {
    kind: "exact",
    path: "/admin/points/backfill-donations",
    method: "POST",
    handle: () => pointHandlers.backfillDonations(env, request),
  },
  {
    kind: "exact",
    path: "/admin/points/backfill-donations/topup",
    method: "POST",
    handle: () => pointHandlers.topUpDonations(env, request),
  },
  {
    kind: "exact",
    path: "/admin/points/products",
    method: "POST",
    handle: () => pointHandlers.createShopProduct(env, request),
  },
  {
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/admin\/points\/products\/([^/]+)$/),
    handle: (shopProductMatch: RegExpMatchArray, method: string) => {
      const id = decodeURIComponent(shopProductMatch[1])
      if (method === "PUT") return pointHandlers.updateShopProduct(env, request, id)
      if (method === "DELETE") return pointHandlers.deleteShopProduct(env, request, id)
      return null
    },
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/points\/products\/([^/]+)\/review$/),
    methods: ["POST"],
    handle: (shopReviewMatch: RegExpMatchArray) =>
      pointHandlers.reviewShopProduct(env, request, decodeURIComponent(shopReviewMatch[1])),
  },
  // 卡密池（delivery='code'）：读概览 / 追加 / 清空未使用
  {
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/admin\/points\/products\/([^/]+)\/codes$/),
    handle: (shopCodesMatch: RegExpMatchArray, method: string) => {
      const id = decodeURIComponent(shopCodesMatch[1])
      if (method === "GET") return pointHandlers.getShopProductCodes(env, request, id)
      if (method === "POST") return pointHandlers.addShopProductCodes(env, request, id)
      if (method === "DELETE") return pointHandlers.clearShopProductCodes(env, request, id)
      return null
    },
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/points\/orders\/([^/]+)\/deliver$/),
    methods: ["POST"],
    handle: (shopOrderMatch: RegExpMatchArray) =>
      pointHandlers.deliverShopOrder(env, request, decodeURIComponent(shopOrderMatch[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/points\/orders\/([^/]+)\/settle$/),
    methods: ["POST"],
    handle: (shopSettleMatch: RegExpMatchArray) =>
      pointHandlers.settleShopOrder(env, request, decodeURIComponent(shopSettleMatch[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/points\/orders\/([^/]+)\/cancel$/),
    methods: ["POST"],
    handle: (shopCancelMatch: RegExpMatchArray) =>
      pointHandlers.cancelShopOrder(env, request, decodeURIComponent(shopCancelMatch[1])),
  },
  // 售后（客服介入）：列表 + 判定
  {
    kind: "exact",
    path: "/admin/points/after-sales",
    method: "GET",
    handle: () => pointHandlers.listAfterSales(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/admin\/points\/orders\/([^/]+)\/after-sale$/),
    methods: ["POST"],
    handle: (adminAfterSaleMatch: RegExpMatchArray) =>
      pointHandlers.adminResolveAfterSaleHandler(
        env,
        request,
        decodeURIComponent(adminAfterSaleMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/storage",
    method: "GET",
    handle: () =>
      storageHandlers.getStorage(env, request),
  },

  {
    kind: "exact",
    path: "/storage/enable",
    method: "POST",
    handle: () =>
      storageHandlers.enableStorage(env, request),
  },

  {
    kind: "exact",
    path: "/storage/disable",
    method: "POST",
    handle: () =>
      storageHandlers.disableStorage(env, request),
  },

  {
    kind: "exact",
    path: "/storage/objects",
    method: "GET",
    handle: () =>
      storageHandlers.listStorageObjects(env, request),
  },

  {
    kind: "exact",
    path: "/storage/upload-url",
    method: "POST",
    handle: () =>
      storageHandlers.createUploadUrl(env, request),
  },

  // 数据库备份直传 R2（家里云每日 cron 用；X-Backup-Token 鉴权，见 handlers/db-backup.ts）
  {
    kind: "exact",
    path: "/internal/db-backup/url",
    method: "GET",
    handle: () => dbBackupHandlers.dbBackupUrlHandler(env, request),
  },

  {
    kind: "exact",
    path: "/internal/db-backup/chunk",
    method: "POST",
    handle: () => dbBackupHandlers.dbBackupChunkHandler(env, request),
  },

  {
    kind: "exact",
    path: "/internal/db-backup/delete",
    method: "POST",
    handle: () => dbBackupHandlers.dbBackupDeleteHandler(env, request),
  },

  {
    kind: "exact",
    path: "/internal/db-backup/prune",
    method: "POST",
    handle: () => dbBackupHandlers.dbBackupPruneHandler(env, request),
  },

  {
    kind: "exact",
    path: "/storage/proxy-upload",
    method: "PUT",
    handle: () =>
      storageHandlers.proxyUpload(env, request),
  },

  {
    kind: "exact",
    path: "/storage/commit",
    method: "POST",
    handle: () =>
      storageHandlers.commitUpload(env, request),
  },

  {
    kind: "exact",
    path: "/storage/object",
    method: "DELETE",
    handle: () =>
      storageHandlers.deleteStorageObject(env, request),
  },

  {
    kind: "exact",
    path: "/storage/objects/delete",
    method: "POST",
    handle: () =>
      storageHandlers.deleteStorageObjects(env, request),
  },

  {
    kind: "exact",
    path: "/storage/download",
    method: "GET",
    handle: () =>
      storageHandlers.downloadStorageObject(env, request),
  },

  {
    kind: "exact",
    path: "/storage/domain",
    method: "POST",
    handle: () =>
      storageHandlers.bindStorageDomain(env, request),
  },

  {
    kind: "exact",
    path: "/storage/default-prefix",
    method: "POST",
    handle: () =>
      storageHandlers.setDefaultPrefix(env, request),
  },

  // 目录：目录本身不落表，靠 R2 的 `<key>/` 占位对象表示
  {
    kind: "exact",
    path: "/storage/folder",
    method: "POST",
    handle: () =>
      storageHandlers.createFolder(env, request),
  },

  {
    kind: "exact",
    path: "/storage/folder/delete",
    method: "POST",
    handle: () =>
      storageHandlers.deleteFolder(env, request),
  },

  // 目录分享
  {
    kind: "exact",
    path: "/storage/shares",
    method: "GET",
    handle: () =>
      storageHandlers.listShares(env, request),
  },

  {
    kind: "exact",
    path: "/storage/shares",
    method: "POST",
    handle: () =>
      storageHandlers.createShare(env, request),
  },

  {
    kind: "exact",
    path: "/storage/shares/delete",
    method: "POST",
    handle: () =>
      storageHandlers.deleteShare(env, request),
  },

  {
    kind: "exact",
    path: "/storage/shares/toggle",
    method: "POST",
    handle: () =>
      storageHandlers.toggleShare(env, request),
  },

  {
    kind: "exact",
    path: "/dev/status",
    method: "GET",
    handle: () =>
      newapiHandlers.getStatus(env, request),
  },

  // 「全部可用模型」清单（懒加载）：单独成接口是因为拉全量模型很慢
  // （无缓存 + 一趟上游往返），原先内联在 /dev/status 里拖慢整个首屏。
  // 前端只在用户展开「全部模型」折叠卡片时才请求它。
  {
    kind: "exact",
    path: "/dev/models",
    method: "GET",
    handle: () =>
      newapiHandlers.getModels(env, request),
  },

  {
    kind: "exact",
    path: "/dev/sync",
    method: "POST",
    handle: () =>
      newapiHandlers.syncAccount(env, request),
  },

  {
    kind: "exact",
    path: "/dev/preflight",
    method: "GET",
    handle: () =>
      newapiHandlers.preflight(env, request),
  },

  {
    kind: "exact",
    path: "/dev/bind",
    method: "POST",
    handle: () =>
      newapiHandlers.bindAccount(env, request),
  },

  {
    kind: "exact",
    path: "/dev/keys",
    method: "GET",
    handle: () =>
      newapiHandlers.listKeys(env, request),
  },

  {
    kind: "exact",
    path: "/dev/keys/sync",
    method: "POST",
    handle: () =>
      newapiHandlers.syncKeys(env, request),
  },

  {
    kind: "exact",
    path: "/dev/key",
    method: "POST",
    handle: () =>
      newapiHandlers.createKey(env, request),
  },

  {
    kind: "exact",
    path: "/dev/redeem",
    method: "POST",
    handle: () =>
      newapiHandlers.redeem(env, request),
  },

  {
    kind: "exact",
    path: "/dev/subscribe",
    method: "POST",
    handle: () =>
      newapiHandlers.grantSubscription(env, request),
  },

  {
    kind: "exact",
    path: "/dev/password",
    method: "POST",
    handle: () =>
      newapiHandlers.changePassword(env, request),
  },

  {
    kind: "exact",
    path: "/frp",
    method: "GET",
    handle: () =>
      frpHandlers.getFrpOverview(env, request),
  },

  {
    kind: "exact",
    path: "/frp/enable",
    method: "POST",
    handle: () =>
      frpHandlers.enableFrp(env, request),
  },

  {
    kind: "exact",
    path: "/frp/disable",
    method: "POST",
    handle: () =>
      frpHandlers.disableFrp(env, request),
  },

  {
    kind: "exact",
    path: "/frp/apply",
    method: "POST",
    handle: () =>
      frpHandlers.applyFrp(env, request),
  },

  {
    kind: "exact",
    path: "/frp/cancel",
    method: "POST",
    handle: () =>
      frpHandlers.cancelFrp(env, request),
  },

  {
    kind: "exact",
    path: "/admin/frp/applications",
    method: "GET",
    handle: () =>
      frpHandlers.listFrpApplications(env, request),
  },

  {
    kind: "exact",
    path: "/admin/frp/review",
    method: "POST",
    handle: () =>
      frpHandlers.reviewFrpApplication(env, request),
  },

  // 编辑一条待审核的申请（账号名/密码/端口/通知邮箱/备注）
  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/admin\/frp\/applications\/([^/]+)$/),
    methods: ["PUT"],
    handle: (adminFrpAppMatch: RegExpMatchArray) =>
      frpHandlers.updateFrpApplication(
        env,
        request,
        decodeURIComponent(adminFrpAppMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/admin/frp/review-revoke",
    method: "POST",
    handle: () =>
      frpHandlers.revokeFrpApplication(env, request),
  },

  {
    kind: "exact",
    path: "/admin/frp/nodes",
    method: "GET",
    handle: () =>
      frpHandlers.listFrpNodes(env, request),
  },

  {
    kind: "exact",
    path: "/admin/frp/nodes",
    method: "POST",
    handle: () =>
      frpHandlers.upsertFrpNode(env, request),
  },

  {
    kind: "exact",
    path: "/admin/frp/ports/release",
    method: "POST",
    handle: () =>
      frpHandlers.releaseFrpPorts(env, request),
  },

  // 某节点已占用的端口（带来源）
  {
    kind: "exact",
    path: "/admin/frp/ports",
    method: "GET",
    handle: () =>
      frpHandlers.listFrpPorts(env, request),
  },

  // 手动标记 / 解除 一批端口的占用
  {
    kind: "exact",
    path: "/admin/frp/ports/occupy",
    method: "POST",
    handle: () =>
      frpHandlers.occupyFrpPorts(env, request),
  },
  {
    kind: "exact",
    path: "/admin/frp/ports/free",
    method: "POST",
    handle: () =>
      frpHandlers.freeFrpPorts(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/frp\/nodes\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (adminFrpNodeMatch: RegExpMatchArray) =>
      frpHandlers.deleteFrpNode(
      env,
      request,
      decodeURIComponent(adminFrpNodeMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/proxy",
    method: "GET",
    handle: () =>
      proxyHandlers.getProxyOverview(env, request),
  },

  {
    kind: "exact",
    path: "/proxy/enable",
    method: "POST",
    handle: () =>
      proxyHandlers.enableProxy(env, request),
  },

  {
    kind: "exact",
    path: "/proxy/disable",
    method: "POST",
    handle: () =>
      proxyHandlers.disableProxy(env, request),
  },

  {
    kind: "exact",
    path: "/proxy/check",
    method: "POST",
    handle: () =>
      proxyHandlers.checkProxySubscription(env, request),
  },

  {
    kind: "exact",
    path: "/proxy/latency",
    method: "POST",
    handle: () =>
      proxyHandlers.testProxyNodeLatency(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/proxy\/subscriptions\/([^/]+)\/reveal$/),
    methods: ["POST"],
    handle: (proxyRevealMatch: RegExpMatchArray) =>
      proxyHandlers.revealProxySubscriptionUrl(
        env,
        request,
        decodeURIComponent(proxyRevealMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/admin/cloudflare/quota",
    method: "GET",
    handle: () =>
      cfQuotaHandlers.getCloudflareQuota(env, request),
  },

  {
    kind: "exact",
    path: "/admin/proxy/subscriptions",
    method: "GET",
    handle: () =>
      proxyHandlers.listProxySubscriptions(env, request),
  },

  {
    kind: "exact",
    path: "/admin/proxy/subscriptions",
    method: "POST",
    handle: () =>
      proxyHandlers.upsertProxySubscription(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/proxy\/subscriptions\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (adminProxyMatch: RegExpMatchArray) =>
      proxyHandlers.deleteProxySubscription(
      env,
      request,
      decodeURIComponent(adminProxyMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/tempbox/config",
    method: "GET",
    handle: () =>
      tempboxHandlers.getTempboxConfig(env, request),
  },

  {
    kind: "exact",
    path: "/tempbox/create",
    method: "POST",
    handle: () =>
      tempboxHandlers.createTempbox(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/tempbox\/([^/]+)\/upload-url$/),
    methods: ["POST"],
    handle: (tempboxUploadMatch: RegExpMatchArray) =>
      tempboxHandlers.createTempboxUploadUrl(env, request, decodeURIComponent(tempboxUploadMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/tempbox\/([^/]+)\/commit$/),
    methods: ["POST"],
    handle: (tempboxCommitMatch: RegExpMatchArray) =>
      tempboxHandlers.commitTempboxUpload(env, request, decodeURIComponent(tempboxCommitMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/tempbox\/([^/]+)\/proxy-upload$/),
    methods: ["PUT"],
    handle: (tempboxProxyMatch: RegExpMatchArray) =>
      tempboxHandlers.proxyTempboxUpload(env, request, decodeURIComponent(tempboxProxyMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/tempbox\/([^/]+)$/),
    methods: ["GET"],
    handle: (tempboxBatchMatch: RegExpMatchArray) =>
      tempboxHandlers.getTempbox(env, request, decodeURIComponent(tempboxBatchMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/tempbox\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (tempboxBatchMatch: RegExpMatchArray) =>
      tempboxHandlers.deleteTempbox(env, request, decodeURIComponent(tempboxBatchMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/tempbox\/([^/]+)\/([^/]+)$/),
    methods: ["GET", "HEAD"],
    handle: (tempboxFileMatch: RegExpMatchArray) =>
      tempboxHandlers.downloadTempboxFile(
      env,
      request,
      decodeURIComponent(tempboxFileMatch[1]),
      decodeURIComponent(tempboxFileMatch[2])
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/tempbox\/([^/]+)\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (tempboxFileDelMatch: RegExpMatchArray) =>
      tempboxHandlers.deleteTempboxFile(
      env,
      request,
      decodeURIComponent(tempboxFileDelMatch[1]),
      decodeURIComponent(tempboxFileDelMatch[2])
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/dev\/key\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (devKeyMatch: RegExpMatchArray) =>
      newapiHandlers.removeKey(
      env,
      request,
      decodeURIComponent(devKeyMatch[1])
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/dev\/key\/([^/]+)\/reveal$/),
    methods: ["POST"],
    handle: (devKeyRevealMatch: RegExpMatchArray) =>
      newapiHandlers.revealKey(
      env,
      request,
      decodeURIComponent(devKeyRevealMatch[1])
      ),
  },

  // ================= 网页实验室（AI 聊天生成小网页 → 保存作品）=================

  {
    kind: "exact",
    path: "/lab/chat",
    method: "POST",
    handle: () => labHandlers.chat(env, request),
  },

  {
    kind: "exact",
    path: "/lab/models",
    method: "GET",
    handle: () => labHandlers.listModels(env, request),
  },

  {
    kind: "exact",
    path: "/lab/settings",
    method: "GET",
    handle: () => labHandlers.getLabSettings(env, request),
  },

  // ---- 联网搜索（Tavily）----
  {
    kind: "exact",
    path: "/lab/web-search",
    method: "POST",
    handle: () => labSearchHandlers.webSearch(env, request),
  },

  // 代拉自定义渠道的模型列表（浏览器直连第三方会被 CORS 拦，必须服务端代拉）
  {
    kind: "exact",
    path: "/lab/probe-models",
    method: "POST",
    handle: () => labSearchHandlers.probeModels(env, request),
  },

  {
    kind: "exact",
    path: "/lab/search-key",
    method: "GET",
    handle: () => labSearchHandlers.getMySearchKey(env, request),
  },

  {
    kind: "exact",
    path: "/lab/search-key",
    method: "PUT",
    handle: () => labSearchHandlers.setMySearchKey(env, request),
  },

  // ---- 技能（用户端：列表 / 导入自己的技能）----
  {
    kind: "exact",
    path: "/lab/skills",
    method: "GET",
    handle: () => labSkillHandlers.listSkills(env, request),
  },

  {
    kind: "exact",
    path: "/lab/skills",
    method: "POST",
    handle: () => labSkillHandlers.importSkill(env, request),
  },

  // 取技能正文（渐进式披露第二步）。⚠️ 用独立路径而不是 /lab/skills/:id，
  //    否则会和下面那条 branch 抢匹配（branch 只处理 DELETE，GET 会落空）。
  {
    kind: "exact",
    path: "/lab/skill-content",
    method: "GET",
    handle: () => labSkillHandlers.getSkillContent(env, request),
  },

  {
    kind: "branch",
    match: (routePath: string) => routePath.match(/^\/lab\/skills\/([^/]+)$/),
    handle: (skillMatch: RegExpMatchArray, method: string) => {
      const sid = decodeURIComponent(skillMatch[1])
      if (method === "DELETE") return labSkillHandlers.deleteSkill(env, request, sid)
      return null
    },
  },

  {
    kind: "exact",
    path: "/lab/channels",
    method: "GET",
    handle: () => labHandlers.listLabChannels(env, request),
  },

  {
    kind: "exact",
    path: "/lab/projects",
    method: "GET",
    handle: () => labHandlers.listProjects(env, request),
  },

  {
    kind: "exact",
    path: "/lab/projects",
    method: "POST",
    handle: () => labHandlers.saveProject(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/lab\/projects\/([^/]+)$/),
    methods: ["GET"],
    handle: (labProjectMatch: RegExpMatchArray) =>
      labHandlers.getProject(env, request, decodeURIComponent(labProjectMatch[1])),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/lab\/projects\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (labProjectMatch: RegExpMatchArray) =>
      labHandlers.deleteProject(env, request, decodeURIComponent(labProjectMatch[1])),
  },

  // ---- 造物集：公开 / 取消公开单个作品，以及展示大厅 ----
  // ⚠️ 这条必须比上面的 `/lab/projects/:id` 更具体：`[^/]+` 不含斜杠，
  //    所以 `/lab/projects/<id>/publish` 不会被上面那条吃掉，两条互不干扰。
  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/lab\/projects\/([^/]+)\/publish$/),
    methods: ["POST"],
    handle: (labPublishMatch: RegExpMatchArray) =>
      labHandlers.publishProject(
        env,
        request,
        decodeURIComponent(labPublishMatch[1])
      ),
  },

  // ---- 作品封面上传 / 移除（走平台桶，key = lab-cover/<uid>/<pid>.<ext>）----
  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/lab\/projects\/([^/]+)\/cover$/),
    methods: ["POST"],
    handle: (labCoverMatch: RegExpMatchArray) =>
      labHandlers.uploadProjectCover(
        env,
        request,
        decodeURIComponent(labCoverMatch[1])
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) =>
      routePath.match(/^\/lab\/projects\/([^/]+)\/cover$/),
    methods: ["DELETE"],
    handle: (labCoverMatch: RegExpMatchArray) =>
      labHandlers.deleteProjectCover(
        env,
        request,
        decodeURIComponent(labCoverMatch[1])
      ),
  },

  {
    kind: "exact",
    path: "/gallery",
    method: "GET",
    handle: () => labHandlers.listGallery(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/gallery\/([^/]+)$/),
    methods: ["GET"],
    handle: (galleryMatch: RegExpMatchArray) =>
      labHandlers.getGalleryItem(env, request, decodeURIComponent(galleryMatch[1])),
  },

  // ---- 点赞（切换语义）与封面读取 ----
  // ⚠️ 两条都带一个额外路径段，所以上面的 `/gallery/:id`（`[^/]+`）不会误吞它们。
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/gallery\/([^/]+)\/like$/),
    methods: ["POST"],
    handle: (galleryLikeMatch: RegExpMatchArray) =>
      labHandlers.likeGalleryItem(
        env,
        request,
        decodeURIComponent(galleryLikeMatch[1])
      ),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/gallery\/([^/]+)\/cover$/),
    methods: ["GET"],
    handle: (galleryCoverMatch: RegExpMatchArray) =>
      labHandlers.serveGalleryCover(
        env,
        request,
        decodeURIComponent(galleryCoverMatch[1])
      ),
  },

  // 分享页：公开作品的可直接打开版本（`tyu.me/p/<id>` 的 iframe 直接拿它当 src）。
  // ⚠️ **不鉴权**（要能分享给没登录的人），安全性靠响应头里那条 CSP `sandbox` 兜底。
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/gallery\/([^/]+)\/raw$/),
    methods: ["GET"],
    handle: (galleryRawMatch: RegExpMatchArray) =>
      labHandlers.serveGalleryRaw(env, request, decodeURIComponent(galleryRawMatch[1])),
  },

  // ================= OAuth 2.0 授权服务器（Doulor Cloud 作为身份提供方）=================
  //
  // ⚠️ 为什么全部挂在 /api 下、而不是根级的 /oauth/authorize：
  //   本站在 Cloudflare 上跑两个 Worker。API Worker 只被挂了
  //   api/* dl/* p/* u/* c/* profile/* 这几条 Route（见 worker/wrangler.toml 注释，
  //   路由由 dashboard 管理，不写进配置文件以免部署时清掉动态自定义域名路由）。
  //   实测：/oauth/* 与 /.well-known/* 都会落到**静态 Worker**，被 SPA 兜底成 index.html。
  //   OIDC 规范允许 issuer 带路径，故 issuer 取 https://cloud.doulor.cn/api
  //   ⇒ 走已有的 api/* Route，**不需要改动任何线上路由**，风险最低。
  //
  // ⚠️ 二期若想在根级提供漂亮 URL（/oauth/authorize），需在 dashboard 加
  //   cloud.doulor.cn/oauth/* 与 /.well-known/* 两条 Route 指向本 Worker，
  //   但必须把 SPA 的同意页路径从 /oauth/* 里排除掉，否则同意页会被这里截走。

  {
    kind: "exact",
    path: "/.well-known/openid-configuration",
    method: "GET",
    handle: () => oauthHandlers.openidConfiguration(env, request),
  },
  {
    kind: "exact",
    path: "/oauth/authorize",
    method: "GET",
    handle: () => oauthHandlers.authorize(env, request),
  },
  {
    kind: "exact",
    path: "/oauth/token",
    method: "POST",
    handle: () => oauthHandlers.token(env, request),
  },
  {
    kind: "exact",
    path: "/oauth/userinfo",
    method: "GET",
    handle: () => oauthHandlers.userinfo(env, request),
  },
  // 同意页展示与决策（需登录，给本站 SPA 用）
  {
    kind: "exact",
    path: "/oauth/authorize/context",
    method: "GET",
    handle: () => oauthHandlers.authorizeContext(env, request),
  },
  {
    kind: "exact",
    path: "/oauth/authorize/decision",
    method: "POST",
    handle: () => oauthHandlers.authorizeDecision(env, request),
  },
  // 用户自助：查看/撤销已授权应用
  {
    kind: "exact",
    path: "/oauth/grants",
    method: "GET",
    handle: () => oauthHandlers.listMyGrants(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/oauth\/grants\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (oauthGrantMatch: RegExpMatchArray) =>
      oauthHandlers.revokeMyGrant(
      env,
      request,
      decodeURIComponent(oauthGrantMatch[1])
      ),
  },
  // 用户自助：我创建的应用（2026-10-06 放开用户自建）
  {
    kind: "exact",
    path: "/oauth/my-clients",
    method: "GET",
    handle: () => oauthHandlers.listMyClients(env, request),
  },
  {
    kind: "exact",
    path: "/oauth/my-clients",
    method: "POST",
    handle: () => oauthHandlers.createMyClient(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/oauth\/my-clients\/([^/]+)$/),
    methods: ["PUT"],
    handle: (m: RegExpMatchArray) =>
      oauthHandlers.updateMyClient(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/oauth\/my-clients\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (m: RegExpMatchArray) =>
      oauthHandlers.deleteMyClient(env, request, decodeURIComponent(m[1])),
  },
  // 管理端：OAuth 应用管理
  {
    kind: "exact",
    path: "/admin/oauth/clients",
    method: "GET",
    handle: () => oauthHandlers.adminListClients(env, request),
  },
  {
    kind: "exact",
    path: "/admin/oauth/clients",
    method: "POST",
    handle: () => oauthHandlers.adminCreateClient(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/oauth\/clients\/([^/]+)\/secret$/),
    methods: ["POST"],
    handle: (oauthSecretMatch: RegExpMatchArray) =>
      oauthHandlers.adminResetClientSecret(
      env,
      request,
      decodeURIComponent(oauthSecretMatch[1])
      ),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/oauth\/clients\/([^/]+)\/review$/),
    methods: ["POST"],
    handle: (m: RegExpMatchArray) =>
      oauthHandlers.adminReviewClient(env, request, decodeURIComponent(m[1])),
  },
  {
    kind: "exact",
    path: "/admin/oauth/settings",
    method: "POST",
    handle: () => oauthHandlers.adminSetUserClientPolicy(env, request),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/oauth\/clients\/([^/]+)$/),
    methods: ["PUT"],
    handle: (oauthClientMatch: RegExpMatchArray) =>
      oauthHandlers.adminUpdateClient(
      env,
      request,
      decodeURIComponent(oauthClientMatch[1])
      ),
  },
  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/oauth\/clients\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (oauthClientMatch: RegExpMatchArray) =>
      oauthHandlers.adminDeleteClient(
      env,
      request,
      decodeURIComponent(oauthClientMatch[1])
      ),
  },
  ]
}

/** 按声明顺序查找并执行匹配的接口；无匹配返回 null（由调用方抛 404）。 */
async function dispatch(
  env: Env,
  request: Request,
  routePath: string,
  method: string,
  ctx?: ExecutionContext
): Promise<Response | null> {
  for (const r of buildRoutes(env, request, ctx)) {
    if (r.kind === "exact") {
      if (routePath === r.path && method === r.method) return r.handle()
      continue
    }
    if (r.kind === "regex") {
      if (!r.methods.includes(method)) continue
      const m = r.match(routePath)
      if (!m) continue
      return r.handle(m)
    }
    // branch：一个正则覆盖多个动作，内部自行判断命中哪个（未命中返回 null）
    const mb = r.match(routePath)
    if (!mb) continue
    const res = r.handle(mb, method)
    if (res) return res
  }
  return null
}

async function route(
  env: Env,
  request: Request,
  ctx?: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, "") || "/"
  const method = request.method.toUpperCase()

  const routePath = path.startsWith("/api") ? path.slice(4) : path

  const res = await dispatch(env, request, routePath, method, ctx)
  if (res) return res

  throw new ApiError(404, "接口不存在", "NOT_FOUND")
}


/**
 * 自定义直链域名的入口。
 * 这些域名通过 Worker Route（<fqdn>/*）指到本 Worker，不属于 /api 命名空间；
 * 命中 storage_prefixes 时直接反代 R2，否则交回静态资源。
 */
async function hostedDirectLink(
  env: Env,
  request: Request
): Promise<Response | null> {
  const url = new URL(request.url)
  const host = url.hostname.toLowerCase()

  // 只接管**本站根域名**的子域名（doulor.cn + root_domains 表里的 tyu.me 等），
  // 避免影响自定义域等其它入口。
  //
  // ⚠️ 不能只看 env.ROOT_DOMAIN（那是站点自己的域名 doulor.cn）：发给用户的域名由
  // root_domains 表决定（默认 tyu.me），网盘自定义直链绑在 tyu.me 子域名上时，
  // 若只看 doulor.cn 会直接 return null → 落回静态资源 → NOT_FOUND
  // （2026-10-03 反馈「example.tyu.me/xxx.jpg 返回接口不存在」）。
  if (!(await rootDomainFor(env, host))) return null
  if (!(await storageHandlers.isHostedDirectLinkHost(env, host))) return null

  return storageHandlers.serveHostedDirectLink(env, request, host)
}

/**
 * 给每个请求包一层 D1 读复制会话。
 *
 * 背景（2026-10-01）：线上 D1 已开启 read replication，读可被就近副本服务，
 * 但必须保证「先主库、后副本」的顺序语义，否则会出现「刚登录的下一个请求
 * 读不到会话行 → 被踢回登录页」这类问题：
 *   · `first-primary` —— 本请求的**第一条**查询走主库，之后同一请求内的查询
 *     带着 bookmark，可落到就近副本（跨境用户单次往返 ~150ms → ~10ms）；
 *   · 写语句在会话内始终走主库；同一请求里「写后读」也保证读到自己的写。
 * 绑定不支持 withSession（老 runtime / 本地 miniflare 之外的实现）时原样返回。
 */
function withD1ReadReplication(env: Env): Env {
  const db = env.DB as unknown as { withSession?: (mode?: string) => unknown }
  if (!db || typeof db.withSession !== "function") return env
  try {
    const session = db.withSession("first-primary")
    return new Proxy(env, {
      get: (target, prop) =>
        prop === "DB" ? session : (target as unknown as Record<string | symbol, unknown>)[prop],
    }) as Env
  } catch {
    return env
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    env = withD1ReadReplication(env)
    // ⚠️ 入口必做的安全动作：剥掉客户端传来的内部标记头。
    // `X-Doulor-Api-Source` / `X-Doulor-Api-Admin` 只允许 Worker 内部
    // （public-api 的 runAs）注入；不剥的话，任何人自己加一个
    // `X-Doulor-Api-Admin: 1` 就能冒充「管理员 Key」，绕过全部限额。
    request = stripInternalHeaders(request)
    try {
      const url = new URL(request.url)

      // 强制 HTTPS：会话 cookie 带 Secure 标志，HTTP 下浏览器会拒绝保存，
      // 表现为「登录接口 200 却立刻被踢回登录页」，且清缓存/换域名都无效。
      // 静态站点侧由根目录的 site-worker.js 做同样的事。
      //
      // 例外：本机回环地址（本地 wrangler dev / miniflare 联调）没有 TLS，
      // 跳过去就是 301 指向自身的死循环，所有本地请求全挂。线上不可能有
      // 用户从 localhost 打进来，这个豁免不影响生产行为。
      if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
        url.protocol = "https:"
        return Response.redirect(url.toString(), 301)
      }

      // 公开直链：/dl/<用户名>/<文件名>（无需鉴权）
      if (url.pathname.startsWith("/dl/")) {
        return await storageHandlers.serveDirectLink(
          env,
          request,
          url.pathname.slice(4)
        )
      }

      // 公开目录分享：/s/<token>（目录页）与 /s/<token>/f/<路径>（文件，无需鉴权）
      if (url.pathname.startsWith("/s/")) {
        return await storageHandlers.serveStorageShare(
          env,
          request,
          url.pathname.slice(3)
        )
      }

      // 公开头像：/u/<username>/avatar（无需鉴权，走平台桶）
      const avatarMatch = url.pathname.match(/^\/u\/([^/]+)\/avatar$/)
      if (avatarMatch) {
        return identityHandlers.serveAvatar(env, decodeURIComponent(avatarMatch[1]))
      }

      // 社区帖子图片：/c/<postId>/<filename>（公开，走平台桶）
      const communityImgMatch = url.pathname.match(/^\/c\/([^/]+)\/([^/]+)$/)
      if (communityImgMatch) {
        return communityHandlers.serveCommunityImage(
          env,
          decodeURIComponent(communityImgMatch[1]),
          decodeURIComponent(communityImgMatch[2])
        )
      }



      // 图片墙资源：/p/<用户名>/gallery/<id>（公开，无需鉴权）；必须排在下面
      // 的两段式 assetMatch 之前，否则 /gallery/<id> 不匹配、会被漏掉。
      const galleryMatch = url.pathname.match(/^\/p\/([^/]+)\/gallery\/([a-z0-9-]+)$/)
      if (galleryMatch && request.method === "GET") {
        return await profileHandlers.serveGalleryImage(
          env,
          decodeURIComponent(galleryMatch[1]),
          galleryMatch[2]
        )
      }

      // 名片资源：/p/<用户名>/<avatar|background|music|music-cover>（公开，无需鉴权）
      const assetMatch = url.pathname.match(/^\/p\/([^/]+)\/([a-z-]+)$/)
      if (assetMatch && request.method === "GET") {
        return await profileHandlers.serveAssetByUsername(
          env,
          decodeURIComponent(assetMatch[1]),
          assetMatch[2]
        )
      }

      // 公开名片页：/profile/<slug>
      const pubMatch = url.pathname.match(/^\/profile\/([^/]+)\/?$/)
      if (pubMatch && request.method === "GET") {
        const slug = decodeURIComponent(pubMatch[1])
        const profile = await profileHandlers.loadPublicProfile(env, { slug })
        if (profile) {
          // 访客量 +1。必须 waitUntil：Worker 返回响应后会取消游离的 Promise，
          // 「void fn()」不会真正执行（这正是访客量一直是 0 的原因）。
          ctx.waitUntil(profileHandlers.bumpProfileView(env, slug))
          return new Response(renderProfileHtml(profile), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "public, max-age=60",
            },
          })
        }
        return new Response(renderNotFoundHtml(), {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        })
      }

      // 自定义名片域名：Host 命中 profiles.fqdn 时，该域名下所有路径都渲染名片。
      // 仅对本站已知入口之外的 Host 查询，避免给 /api/* 等请求白加一次 DB 查询。
      const host = url.hostname.toLowerCase()
      const isAppHost =
        host === env.ROOT_DOMAIN.toLowerCase() ||
        host === "cloud." + env.ROOT_DOMAIN.toLowerCase() ||
        host.endsWith(".workers.dev")
      if (!isAppHost) {
        const hostProfile = await profileHandlers.loadPublicProfile(env, {
          fqdn: host,
        })
        if (hostProfile) {
          ctx.waitUntil(profileHandlers.bumpProfileView(env, hostProfile.slug))
          return new Response(renderProfileHtml(hostProfile), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "public, max-age=60",
            },
          })
        }
      }

      // 自定义直链域名（Host 命中 storage_prefixes）
      const hosted = await hostedDirectLink(env, request)
      if (hosted) return hosted

      return await route(env, request, ctx)
    } catch (err) {
      if (err instanceof ApiError) {
        // extra：报错之外还要带回信息时用（如登录时账号被封禁 → 一并给出原因与申诉结果）
        const res = json(
          { error: err.message, code: err.code, ...(err.extra ?? {}) },
          err.status
        )
        // 仅在「会话本身失效」时清除 cookie。
        // 注意不能用 status===401 一刀切：登录密码错误、修改密码时当前密码错误
        // 也是 401（INVALID_CREDENTIALS），清 cookie 会把正常用户踢下线。
        if (
          err.status === 401 &&
          (err.code === "UNAUTHORIZED" || err.code === "SESSION_EXPIRED")
        ) {
          const tokens = getSessionTokens(request)
          // 浏览器可能同时持有多个同名 cookie，逐个下发清除指令
          const count = Math.max(tokens.length, 1)
          for (let i = 0; i < count; i++) {
            res.headers.append("Set-Cookie", clearedSessionCookie())
          }
        }
        return res
      }
      // ⚠️ 必须带上「哪个方法 + 哪条路径」：这个兜底只回一句「服务器内部错误」给用户，
      // 日志是唯一能定位的线索。2026-09-30 排查「自定义 AI 渠道捐献报服务器内部错误」时，
      // 就是缺了这条信息 —— 只能靠对比业务表的入库空档去反推是哪个接口。
      // ⚠️ 路径里可能带 ID，但**不能记 query string**（捐献/兑换类接口会把密钥放进去）。
      // 解析路径要包一层 try：这里已经在处理未捕获异常了，
      // 若 request.url 本身畸形再抛一次，就绕过了这个兜底（变成 CF 的 1101）。
      let pathForLog = "?"
      try {
        pathForLog = new URL(request.url).pathname
      } catch {
        /* 保持 "?" */
      }
      console.error(`Unhandled error [${request.method} ${pathForLog}]:`, err)
      return json({ error: "服务器内部错误", code: "INTERNAL" }, 500)
    }
  },
  // Email Workers 入站路由：Cloudflare Email Routing 转发到此
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await incomingEmail(message, env)
  },
  /**
   * 定时任务：由 Cloudflare Cron Triggers 触发（配置见 wrangler.toml 的 [triggers]）。
   *
   * 有**两条** cron，靠 controller.cron 区分：
   *   - `* * * * *`（每分钟）→ 只跑「到点发布」：定时公告 / 定时活动到点后上线。
   *     任务本身极轻（无任务时就是两条 SELECT），所以给到分钟级精度；
   *     若混进每小时那套运维（含 COUNT(*) 全表扫），成本会被放大 60 倍。
   *   - `17 * * * *`（每小时）→ 完整运维（runMaintenance，内部也会兜底跑一次到点发布）。
   *
   * 用 ctx.waitUntil 而不是直接 await：scheduled 处理器同样有墙钟限制，
   * 交给 waitUntil 让调用方尽早返回、任务在后台跑完（与 fetch 里的做法一致）。
   *
   * 每天 UTC 03:xx 的那一次运维升级为「深度模式」（额外清理 90 天前的审计日志）。
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    if (controller.cron === SCHEDULED_PUBLISH_CRON) {
      ctx.waitUntil(
        processScheduledPublishes(env, ctx).then((r) => {
          if (r.errors > 0) console.warn("到点发布有失败项:", JSON.stringify(r))
        })
      )
      // 风险账户扫描：每 10 分钟一次（窗口也是 10 分钟，首尾正好相接）。
      // 搭在每分钟的 tick 上而不是新增一条 cron —— 它本身很轻（几条 SELECT +
      // 一两次 NewAPI 请求），不值得为它多开一条触发器。
      if (new Date(controller.scheduledTime).getUTCMinutes() % 10 === 0) {
        ctx.waitUntil(
          scanRiskAccounts(env).then((r) => {
            if (r.flagged > 0) console.warn("风险扫描命中:", JSON.stringify(r))
          })
        )
      }
      return
    }

    const deep = new Date(controller.scheduledTime).getUTCHours() === 3
    ctx.waitUntil(
      runMaintenance(env, { deep }).then((report) => {
        if (report.warnings.length > 0) {
          console.warn("运维自检告警:", report.warnings.join(" | "))
        }
      })
    )
    // 用户商城自动确认收货：卖家交付满 N 天自动结算给卖家（避免买家一直不点收货，
    // 积分永远卡在托管里）。N 由设置项 shop_auto_confirm_days 控制，0 = 关闭。
    ctx.waitUntil(
      pointHandlers.runAutoConfirmDeliveries(env).then((n) => {
        if (n > 0) console.log("自动确认收货:", n, "笔")
      })
    )
    // 批量刷新中转站调用次数/额度：排行榜读的是 newapi_accounts.request_count
    // 的本地缓存，只在用户打开中转站页时刷新 —— 不打开就一直是旧的（排行榜
    // 于是「数据不对」）。这里每小时刷一批（从最旧开始，限量防上游限流）。
    ctx.waitUntil(
      newapiHandlers.syncAllNewapiAccounts(env).then((r) => {
        if (r.failed > 0) console.warn("中转站批量同步有失败项:", JSON.stringify(r))
      })
    )
  },
}
