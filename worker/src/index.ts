import { ApiError, json } from "./http"
import type { Env } from "./env"
import * as authHandlers from "./handlers/auth"
import * as dnsHandlers from "./handlers/dns"
import * as emailHandlers from "./handlers/email"
import * as subdomainHandlers from "./handlers/subdomains"
import * as adminHandlers from "./handlers/admin"
import * as storageHandlers from "./handlers/storage"
import * as newapiHandlers from "./handlers/newapi"
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
  if (adminInviteMatch && method === "DELETE") {
    return adminHandlers.deleteInvite(env, request, decodeURIComponent(adminInviteMatch[1]))
  }

  // Admin: 全局设置 / 网盘运维
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

  // ---- AI 中转站（NewAPI）----
  if (routePath === "/dev/status" && method === "GET") {
    return newapiHandlers.getStatus(env, request)
  }
  if (routePath === "/dev/sync" && method === "POST") {
    return newapiHandlers.syncAccount(env, request)
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

      // 公开直链：/dl/<用户名>/<文件名>（无需鉴权）
      if (url.pathname.startsWith("/dl/")) {
        return await storageHandlers.serveDirectLink(
          env,
          request,
          url.pathname.slice(4)
        )
      }

      // 自定义直链域名（Host 命中 storage_prefixes）
      const hosted = await hostedDirectLink(env, request)
      if (hosted) return hosted

      return await route(env, request)
    } catch (err) {
      if (err instanceof ApiError) {
        return json({ error: err.message, code: err.code }, err.status)
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
