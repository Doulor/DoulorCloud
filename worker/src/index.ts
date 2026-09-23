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
import * as myInviteHandlers from "./handlers/my-invites"
import * as frpHandlers from "./handlers/frp"
import * as profileHandlers from "./handlers/profile"
import * as proxyHandlers from "./handlers/proxy"
import * as tempboxHandlers from "./handlers/tempbox"
import * as announcementHandlers from "./handlers/announcements"
import * as achievementHandlers from "./handlers/achievements"
import { renderProfileHtml, renderNotFoundHtml } from "./profile-page"
import { incomingEmail } from "./email-delivery"

export interface WorkerContext {
  env: Env
  request: Request
}

async function route(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, "") || "/"
  const method = request.method.toUpperCase()

  const routePath = path.startsWith("/api") ? path.slice(4) : path

  // Auth
  if (routePath === "/register" && method === "POST") {
    return authHandlers.register(env, request)
  }
  if (routePath === "/login" && method === "POST") {
    return authHandlers.login(env, request)
  }
  if (routePath === "/logout" && method === "POST") {
    return authHandlers.logout(env, request)
  }
  if (routePath === "/me" && method === "GET") {
    return authHandlers.me(env, request)
  }
  if (routePath === "/password" && method === "PUT") {
    return authHandlers.changePassword(env, request)
  }

  // 账户设置：真实邮箱验证 / 通知开关 / 改名 / 改邮箱
  if (routePath === "/settings/email" && method === "GET") {
    return settingsHandlers.getEmailSettings(env, request)
  }
  if (routePath === "/settings/email/verify" && method === "POST") {
    return settingsHandlers.verifyRealEmail(env, request)
  }
  if (routePath === "/settings/email" && method === "PUT") {
    return settingsHandlers.changeRealEmail(env, request)
  }
  if (routePath === "/settings/notify" && method === "PUT") {
    return settingsHandlers.updateNotifySetting(env, request)
  }
  if (routePath === "/settings/username" && method === "PUT") {
    return settingsHandlers.changeUsername(env, request)
  }

  // DNS
  if (routePath === "/dns" && method === "GET") {
    return dnsHandlers.listDns(env, request)
  }
  if (routePath === "/dns" && method === "POST") {
    return dnsHandlers.createDns(env, request)
  }

  const dnsMatch = routePath.match(/^\/dns\/([^/]+)$/)
  if (dnsMatch && method === "PUT") {
    return dnsHandlers.updateDns(env, request, decodeURIComponent(dnsMatch[1]))
  }
  if (dnsMatch && method === "DELETE") {
    return dnsHandlers.deleteDns(env, request, decodeURIComponent(dnsMatch[1]))
  }

  // Subdomains
  if (routePath === "/subdomains" && method === "GET") {
    return subdomainHandlers.listSubdomains(env, request)
  }
  if (routePath === "/subdomains" && method === "POST") {
    return subdomainHandlers.createSubdomain(env, request)
  }

  const subdomainMatch = routePath.match(/^\/subdomains\/([^/]+)$/)
  if (subdomainMatch && method === "DELETE") {
    return subdomainHandlers.deleteSubdomain(env, request, decodeURIComponent(subdomainMatch[1]))
  }

  // Admin
  if (routePath === "/admin/users" && method === "GET") {
    return adminHandlers.listUsers(env, request)
  }

  const adminUserMatch = routePath.match(/^\/admin\/users\/([^/]+)$/)
  if (adminUserMatch && method === "GET") {
    return adminHandlers.getUser(env, request, decodeURIComponent(adminUserMatch[1]))
  }
  if (adminUserMatch && method === "PUT") {
    return adminHandlers.updateUser(env, request, decodeURIComponent(adminUserMatch[1]))
  }
  if (adminUserMatch && method === "DELETE") {
    return adminHandlers.deleteUser(env, request, decodeURIComponent(adminUserMatch[1]))
  }

  const adminMessageMatch = routePath.match(/^\/admin\/users\/([^/]+)\/messages\/([^/]+)$/)
  if (adminMessageMatch && method === "GET") {
    return adminHandlers.getUserMessage(
      env,
      request,
      decodeURIComponent(adminMessageMatch[1]),
      decodeURIComponent(adminMessageMatch[2])
    )
  }

  // Admin: 邀请码
  if (routePath === "/admin/invites" && method === "GET") {
    return adminHandlers.listInvites(env, request)
  }
  if (routePath === "/admin/invites" && method === "POST") {
    return adminHandlers.createInvite(env, request)
  }

  const adminInviteMatch = routePath.match(/^\/admin\/invites\/([^/]+)$/)
  if (adminInviteMatch && method === "PUT") {
    return adminHandlers.updateInvite(env, request, decodeURIComponent(adminInviteMatch[1]))
  }
  if (adminInviteMatch && method === "DELETE") {
    // 走「带额度退还」版本：删掉用户自助创建且未使用的码时，
    // 把额度还给创建者，避免用户白掉额度
    return adminHandlers.adminDeleteInviteWithRefund(
      env,
      request,
      decodeURIComponent(adminInviteMatch[1])
    )
  }

  // ---- 我的邀请码（用户自助）----
  if (routePath === "/my-invites" && method === "GET") {
    return myInviteHandlers.listMyInvites(env, request)
  }
  if (routePath === "/my-invites" && method === "POST") {
    return myInviteHandlers.createMyInvite(env, request)
  }

  const myInviteMatch = routePath.match(/^\/my-invites\/([^/]+)$/)
  if (myInviteMatch && method === "DELETE") {
    return myInviteHandlers.deleteMyInvite(
      env,
      request,
      decodeURIComponent(myInviteMatch[1])
    )
  }

  // Admin: 捐献审核
  if (routePath === "/admin/donations" && method === "GET") {
    return donationHandlers.listAllDonations(env, request)
  }
  if (routePath === "/admin/donations/review" && method === "POST") {
    return donationHandlers.reviewDonation(env, request)
  }

  // Admin: 用户邀请码额度
  if (routePath === "/admin/invite-quotas" && method === "GET") {
    return adminHandlers.listInviteQuotas(env, request)
  }

  const quotaUserMatch = routePath.match(
    /^\/admin\/users\/([^/]+)\/invite-quota$/
  )
  if (quotaUserMatch && method === "GET") {
    return adminHandlers.getUserInviteQuota(
      env,
      request,
      decodeURIComponent(quotaUserMatch[1])
    )
  }
  if (quotaUserMatch && method === "PUT") {
    return adminHandlers.updateUserInviteQuota(
      env,
      request,
      decodeURIComponent(quotaUserMatch[1])
    )
  }

  // Admin: 保留子域名
  if (routePath === "/admin/reserved-subdomains" && method === "GET") {
    return adminHandlers.listReserved(env, request)
  }
  if (routePath === "/admin/reserved-subdomains" && method === "POST") {
    return adminHandlers.addReserved(env, request)
  }

  const reservedMatch = routePath.match(/^\/admin\/reserved-subdomains\/([^/]+)$/)
  if (reservedMatch && method === "DELETE") {
    return adminHandlers.removeReserved(
      env,
      request,
      decodeURIComponent(reservedMatch[1])
    )
  }

  // Admin: 全局设置 / 网盘运维
  // 出站邮件连通性自检（管理员）：验证 send_email 绑定与发送域名 Onboard 状态
  if (routePath === "/admin/mail-test" && method === "POST") {
    return adminHandlers.testMail(env, request)
  }
  if (routePath === "/admin/newapi-test" && method === "GET") {
    return adminHandlers.testNewApi(env, request)
  }
  if (routePath === "/admin/mail-status" && method === "GET") {
    return adminHandlers.mailStatus(env, request)
  }

  // 公告 / 网站动态（管理员 CRUD，普通用户只读最近几条）
  if (routePath === "/announcements" && method === "GET") {
    return announcementHandlers.listAnnouncements(env, request)
  }

  // 成就系统
  if (routePath === "/achievements" && method === "GET") {
    return achievementHandlers.getAchievements(env, request)
  }
  if (routePath === "/admin/announcements" && method === "GET") {
    return announcementHandlers.listAllAnnouncements(env, request)
  }
  if (routePath === "/admin/announcements" && method === "POST") {
    return announcementHandlers.createAnnouncement(env, request)
  }
  const announcementMatch = routePath.match(/^\/admin\/announcements\/([^/]+)$/)
  if (announcementMatch && method === "PUT") {
    return announcementHandlers.updateAnnouncement(
      env,
      request,
      decodeURIComponent(announcementMatch[1])
    )
  }
  if (announcementMatch && method === "DELETE") {
    return announcementHandlers.deleteAnnouncement(
      env,
      request,
      decodeURIComponent(announcementMatch[1])
    )
  }

  if (routePath === "/admin/settings" && method === "GET") {
    return adminHandlers.getSettingsHandler(env, request)
  }
  if (routePath === "/admin/settings" && method === "PUT") {
    return adminHandlers.updateSettingsHandler(env, request)
  }
  if (routePath === "/admin/storage/recalculate" && method === "POST") {
    return adminHandlers.recalculateStorage(env, request)
  }

  const adminPurgeMatch = routePath.match(/^\/admin\/storage\/purge\/([^/]+)$/)
  if (adminPurgeMatch && method === "POST") {
    return adminHandlers.purgeStorage(
      env,
      request,
      decodeURIComponent(adminPurgeMatch[1])
    )
  }

  // Email（收件箱 + 消息）
  if (routePath === "/mailbox" && method === "GET") {
    return emailHandlers.listMailboxes(env, request)
  }
  if (routePath === "/mailbox" && method === "POST") {
    return emailHandlers.createMailbox(env, request)
  }

  const mailboxMatch = routePath.match(/^\/mailbox\/([^/]+)$/)
  if (mailboxMatch && method === "PUT") {
    return emailHandlers.updateMailbox(env, request, decodeURIComponent(mailboxMatch[1]))
  }
  if (mailboxMatch && method === "DELETE") {
    return emailHandlers.deleteMailbox(env, request, decodeURIComponent(mailboxMatch[1]))
  }

  const mailboxMessagesMatch = routePath.match(/^\/mailbox\/([^/]+)\/messages$/)
  if (mailboxMessagesMatch && method === "GET") {
    return emailHandlers.listMessages(env, request, decodeURIComponent(mailboxMessagesMatch[1]))
  }

  const messageMatch = routePath.match(/^\/mailbox\/([^/]+)\/messages\/([^/]+)$/)
  if (messageMatch && method === "GET") {
    return emailHandlers.getMessage(
      env,
      request,
      decodeURIComponent(messageMatch[1]),
      decodeURIComponent(messageMatch[2])
    )
  }
  if (messageMatch && method === "DELETE") {
    return emailHandlers.deleteMessage(
      env,
      request,
      decodeURIComponent(messageMatch[1]),
      decodeURIComponent(messageMatch[2])
    )
  }

  const messageReadMatch = routePath.match(/^\/mailbox\/([^/]+)\/messages\/([^/]+)\/read$/)
  if (messageReadMatch && method === "POST") {
    return emailHandlers.markMessage(
      env,
      request,
      decodeURIComponent(messageReadMatch[1]),
      decodeURIComponent(messageReadMatch[2])
    )
  }

  // 一键全部已读：把该用户所有 mailbox 的未读标已读
  if (routePath === "/mailbox/read-all" && method === "POST") {
    return emailHandlers.markAllRead(env, request)
  }

  // ---- 捐献 ----
  if (routePath === "/donations" && method === "GET") {
    return donationHandlers.listDonations(env, request)
  }
  if (routePath === "/donations" && method === "POST") {
    return donationHandlers.createDonation(env, request)
  }
  const donationMatch = routePath.match(/^\/donations\/([^/]+)$/)
  if (donationMatch && method === "DELETE") {
    return donationHandlers.cancelDonation(env, request, decodeURIComponent(donationMatch[1]))
  }

  // ---- 个人名片 ----
  if (routePath === "/profile" && method === "GET") {
    return profileHandlers.getProfile(env, request)
  }
  if (routePath === "/profile/enable" && method === "POST") {
    return profileHandlers.enableProfile(env, request)
  }
  if (routePath === "/profile" && method === "PUT") {
    return profileHandlers.updateProfile(env, request)
  }
  if (routePath === "/profile/publish" && method === "POST") {
    return profileHandlers.setPublished(env, request)
  }
  if (routePath === "/profile/asset" && method === "POST") {
    return profileHandlers.uploadAsset(env, request)
  }
  if (routePath === "/profile/asset" && method === "DELETE") {
    return profileHandlers.deleteAsset(env, request)
  }
  if (routePath === "/profile/asset" && method === "GET") {
    return profileHandlers.readOwnAsset(env, request)
  }
  if (routePath === "/profile/domain" && method === "POST") {
    return profileHandlers.bindProfileDomain(env, request)
  }

  // ---- R2 直链网盘 ----
  if (routePath === "/storage" && method === "GET") {
    return storageHandlers.getStorage(env, request)
  }
  if (routePath === "/storage/enable" && method === "POST") {
    return storageHandlers.enableStorage(env, request)
  }
  if (routePath === "/storage/disable" && method === "POST") {
    return storageHandlers.disableStorage(env, request)
  }
  if (routePath === "/storage/objects" && method === "GET") {
    return storageHandlers.listStorageObjects(env, request)
  }
  if (routePath === "/storage/upload-url" && method === "POST") {
    return storageHandlers.createUploadUrl(env, request)
  }
  if (routePath === "/storage/commit" && method === "POST") {
    return storageHandlers.commitUpload(env, request)
  }
  if (routePath === "/storage/object" && method === "DELETE") {
    return storageHandlers.deleteStorageObject(env, request)
  }
  if (routePath === "/storage/download" && method === "GET") {
    return storageHandlers.downloadStorageObject(env, request)
  }
  if (routePath === "/storage/domain" && method === "POST") {
    return storageHandlers.bindStorageDomain(env, request)
  }
  if (routePath === "/storage/default-prefix" && method === "POST") {
    return storageHandlers.setDefaultPrefix(env, request)
  }

  // ---- AI 中转站（NewAPI）----
  if (routePath === "/dev/status" && method === "GET") {
    return newapiHandlers.getStatus(env, request)
  }
  if (routePath === "/dev/sync" && method === "POST") {
    return newapiHandlers.syncAccount(env, request)
  }
  if (routePath === "/dev/preflight" && method === "GET") {
    return newapiHandlers.preflight(env, request)
  }
  if (routePath === "/dev/bind" && method === "POST") {
    return newapiHandlers.bindAccount(env, request)
  }
  if (routePath === "/dev/keys" && method === "GET") {
    return newapiHandlers.listKeys(env, request)
  }
  if (routePath === "/dev/keys/sync" && method === "POST") {
    return newapiHandlers.syncKeys(env, request)
  }
  if (routePath === "/dev/key" && method === "POST") {
    return newapiHandlers.createKey(env, request)
  }
  if (routePath === "/dev/redeem" && method === "POST") {
    return newapiHandlers.redeem(env, request)
  }
  if (routePath === "/dev/password" && method === "POST") {
    return newapiHandlers.changePassword(env, request)
  }

  // ---- frp 内网穿透 ----
  if (routePath === "/frp" && method === "GET") {
    return frpHandlers.getFrpOverview(env, request)
  }
  if (routePath === "/frp/enable" && method === "POST") {
    return frpHandlers.enableFrp(env, request)
  }
  if (routePath === "/frp/disable" && method === "POST") {
    return frpHandlers.disableFrp(env, request)
  }
  if (routePath === "/frp/apply" && method === "POST") {
    return frpHandlers.applyFrp(env, request)
  }
  if (routePath === "/frp/cancel" && method === "POST") {
    return frpHandlers.cancelFrp(env, request)
  }

  // ---- 管理端：frp ----
  if (routePath === "/admin/frp/applications" && method === "GET") {
    return frpHandlers.listFrpApplications(env, request)
  }
  if (routePath === "/admin/frp/review" && method === "POST") {
    return frpHandlers.reviewFrpApplication(env, request)
  }
  if (routePath === "/admin/frp/nodes" && method === "GET") {
    return frpHandlers.listFrpNodes(env, request)
  }
  if (routePath === "/admin/frp/nodes" && method === "POST") {
    return frpHandlers.upsertFrpNode(env, request)
  }
  if (routePath === "/admin/frp/ports/release" && method === "POST") {
    return frpHandlers.releaseFrpPorts(env, request)
  }

  const adminFrpNodeMatch = routePath.match(/^\/admin\/frp\/nodes\/([^/]+)$/)
  if (adminFrpNodeMatch && method === "DELETE") {
    return frpHandlers.deleteFrpNode(
      env,
      request,
      decodeURIComponent(adminFrpNodeMatch[1])
    )
  }

  // ---- 代理节点 ----
  if (routePath === "/proxy" && method === "GET") {
    return proxyHandlers.getProxyOverview(env, request)
  }
  if (routePath === "/proxy/enable" && method === "POST") {
    return proxyHandlers.enableProxy(env, request)
  }
  if (routePath === "/proxy/disable" && method === "POST") {
    return proxyHandlers.disableProxy(env, request)
  }
  if (routePath === "/proxy/check" && method === "POST") {
    return proxyHandlers.checkProxySubscription(env, request)
  }

  // ---- 管理端：代理节点 ----
  if (routePath === "/admin/proxy/subscriptions" && method === "GET") {
    return proxyHandlers.listProxySubscriptions(env, request)
  }
  if (routePath === "/admin/proxy/subscriptions" && method === "POST") {
    return proxyHandlers.upsertProxySubscription(env, request)
  }

  const adminProxyMatch = routePath.match(/^\/admin\/proxy\/subscriptions\/([^/]+)$/)
  if (adminProxyMatch && method === "DELETE") {
    return proxyHandlers.deleteProxySubscription(
      env,
      request,
      decodeURIComponent(adminProxyMatch[1])
    )
  }

  // ---- 临时分享箱（tempbox）----
  // 公开：config / 查看 / 下载 不需要登录
  if (routePath === "/tempbox/config" && method === "GET") {
    return tempboxHandlers.getTempboxConfig(env, request)
  }
  if (routePath === "/tempbox/create" && method === "POST") {
    return tempboxHandlers.createTempbox(env, request)
  }
  // 需登录 / 管理员：上传与删除
  const tempboxUploadMatch = routePath.match(/^\/tempbox\/([^/]+)\/upload-url$/)
  if (tempboxUploadMatch && method === "POST") {
    return tempboxHandlers.createTempboxUploadUrl(env, request, decodeURIComponent(tempboxUploadMatch[1]))
  }
  const tempboxCommitMatch = routePath.match(/^\/tempbox\/([^/]+)\/commit$/)
  if (tempboxCommitMatch && method === "POST") {
    return tempboxHandlers.commitTempboxUpload(env, request, decodeURIComponent(tempboxCommitMatch[1]))
  }
  const tempboxBatchMatch = routePath.match(/^\/tempbox\/([^/]+)$/)
  if (tempboxBatchMatch && method === "GET") {
    return tempboxHandlers.getTempbox(env, request, decodeURIComponent(tempboxBatchMatch[1]))
  }
  if (tempboxBatchMatch && method === "DELETE") {
    return tempboxHandlers.deleteTempbox(env, request, decodeURIComponent(tempboxBatchMatch[1]))
  }
  const tempboxFileMatch = routePath.match(/^\/tempbox\/([^/]+)\/([^/]+)$/)
  if (tempboxFileMatch && (method === "GET" || method === "HEAD")) {
    return tempboxHandlers.downloadTempboxFile(
      env,
      request,
      decodeURIComponent(tempboxFileMatch[1]),
      decodeURIComponent(tempboxFileMatch[2])
    )
  }

  const devKeyMatch = routePath.match(/^\/dev\/key\/([^/]+)$/)
  if (devKeyMatch && method === "DELETE") {
    return newapiHandlers.removeKey(
      env,
      request,
      decodeURIComponent(devKeyMatch[1])
    )
  }

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
  async fetch(request: Request, env: Env): Promise<Response> {
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
          // 访客量 +1（失败静默，不影响渲染）
          void profileHandlers.bumpProfileView(env, slug)
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
          void profileHandlers.bumpProfileView(env, hostProfile.slug)
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

      return await route(env, request)
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
}
