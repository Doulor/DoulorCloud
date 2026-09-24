import { ApiError, json } from "./http"
import { getSessionTokens, clearedSessionCookie } from "./auth"
import type { Env } from "./env"
import * as authHandlers from "./handlers/auth"
import * as dnsHandlers from "./handlers/dns"
import * as emailHandlers from "./handlers/email"
import * as subdomainHandlers from "./handlers/subdomains"
import * as adminHandlers from "./handlers/admin"
import * as storageHandlers from "./handlers/storage"
import * as newapiHandlers from "./handlers/newapi"
import * as settingsHandlers from "./handlers/settings"
import * as donationHandlers from "./handlers/donations"
import * as voucherHandlers from "./handlers/vouchers"
import * as wb2apiHandlers from "./handlers/wb2api"
import * as myInviteHandlers from "./handlers/my-invites"
import * as frpHandlers from "./handlers/frp"
import * as profileHandlers from "./handlers/profile"
import * as identityHandlers from "./handlers/identity"
import * as proxyHandlers from "./handlers/proxy"
import * as tempboxHandlers from "./handlers/tempbox"
import * as announcementHandlers from "./handlers/announcements"
import * as r2AdminHandlers from "./handlers/r2-admin"
import * as achievementHandlers from "./handlers/achievements"
import * as communityHandlers from "./handlers/community"
import * as analyticsHandlers from "./handlers/analytics"
import * as chatHandlers from "./handlers/chat"
import * as oauthHandlers from "./handlers/oauth"
import { renderProfileHtml, renderNotFoundHtml } from "./profile-page"
import { incomingEmail } from "./email-delivery"
import { runMaintenance } from "./maintenance"

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
    path: "/login",
    method: "POST",
    handle: () =>
      authHandlers.login(env, request),
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
    path: "/settings/email",
    method: "GET",
    handle: () =>
      settingsHandlers.getEmailSettings(env, request),
  },

  {
    kind: "exact",
    path: "/settings/email/verify",
    method: "POST",
    handle: () =>
      settingsHandlers.verifyRealEmail(env, request),
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
    path: "/admin/mail-status",
    method: "GET",
    handle: () =>
      adminHandlers.mailStatus(env, request),
  },

  {
    kind: "exact",
    path: "/announcements",
    method: "GET",
    handle: () =>
      announcementHandlers.listAnnouncements(env, request),
  },

  {
    kind: "exact",
    path: "/achievements",
    method: "GET",
    handle: () =>
      achievementHandlers.getAchievements(env, request),
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
      announcementHandlers.createAnnouncement(env, request),
  },

  {
    kind: "regex",
    match: (routePath: string) => routePath.match(/^\/admin\/announcements\/([^/]+)$/),
    methods: ["PUT"],
    handle: (announcementMatch: RegExpMatchArray) =>
      announcementHandlers.updateAnnouncement(
      env,
      request,
      decodeURIComponent(announcementMatch[1])
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
    match: (routePath: string) => routePath.match(/^\/mailbox\/([^/]+)\/messages\/([^/]+)\/reply$/),
    methods: ["POST"],
    handle: (messageReplyMatch: RegExpMatchArray) =>
      emailHandlers.replyMessage(
      env,
      request,
      decodeURIComponent(messageReplyMatch[1]),
      decodeURIComponent(messageReplyMatch[2])
      ),
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
  // 标记「我刚打开过社区」，用于把新帖角标清零
  {
    kind: "exact",
    path: "/community/seen",
    method: "POST",
    handle: () =>
      communityHandlers.markCommunitySeen(env, request),
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
    match: (routePath: string) => routePath.match(/^\/community\/posts\/([^/]+)\/images$/),
    methods: ["POST"],
    handle: (communityImageMatch: RegExpMatchArray) =>
      communityHandlers.uploadPostImage(env, request, decodeURIComponent(communityImageMatch[1])),
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

  {
    kind: "exact",
    path: "/notifications/read",
    method: "POST",
    handle: () =>
      communityHandlers.markRead(env, request),
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

  {
    kind: "exact",
    path: "/dev/status",
    method: "GET",
    handle: () =>
      newapiHandlers.getStatus(env, request),
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
    match: (routePath: string) => routePath.match(/^\/dev\/key\/([^/]+)$/),
    methods: ["DELETE"],
    handle: (devKeyMatch: RegExpMatchArray) =>
      newapiHandlers.removeKey(
      env,
      request,
      decodeURIComponent(devKeyMatch[1])
      ),
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
  const rootDomain = (env.ROOT_DOMAIN ?? "").toLowerCase()

  // 只接管 doulor.cn 的子域名，避免影响自定义域等其它入口
  if (!rootDomain || !host.endsWith(`.${rootDomain}`)) return null
  if (!(await storageHandlers.isHostedDirectLinkHost(env, host))) return null

  return storageHandlers.serveHostedDirectLink(env, request, host)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url)

      // 强制 HTTPS：会话 cookie 带 Secure 标志，HTTP 下浏览器会拒绝保存，
      // 表现为「登录接口 200 却立刻被踢回登录页」，且清缓存/换域名都无效。
      // 静态站点侧由根目录的 site-worker.js 做同样的事。
      if (url.protocol === "http:") {
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
        const res = json({ error: err.message, code: err.code }, err.status)
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
      console.error("Unhandled error:", err)
      return json({ error: "服务器内部错误", code: "INTERNAL" }, 500)
    }
  },
  // Email Workers 入站路由：Cloudflare Email Routing 转发到此
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await incomingEmail(message, env)
  },
  /**
   * 定时运维：由 Cloudflare Cron Triggers 触发（配置见 wrangler.toml 的 [triggers]）。
   *
   * 用 ctx.waitUntil 而不是直接 await：scheduled 处理器同样有墙钟限制，
   * 交给 waitUntil 让调用方尽早返回、任务在后台跑完（与 fetch 里的做法一致）。
   *
   * 每天 UTC 03:xx 的那一次升级为「深度模式」（额外清理 90 天前的审计日志），
   * 其余每小时只做常规清理，保持每次运行的 D1 写入量很小。
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const deep = new Date(controller.scheduledTime).getUTCHours() === 3
    ctx.waitUntil(
      runMaintenance(env, { deep }).then((report) => {
        if (report.warnings.length > 0) {
          console.warn("运维自检告警:", report.warnings.join(" | "))
        }
      })
    )
  },
}
