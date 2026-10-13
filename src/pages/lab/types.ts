/**
 * AI 实验室的共享类型。
 *
 * 为什么单独成文件：这些类型被「页面（lab.tsx）」和「时间线 / 工具卡片 / 各对话框
 * （lab/parts.tsx）」同时使用。留在 lab.tsx 里再让 parts.tsx 反向 import，
 * 就会形成 lab → parts → lab 的模块环（值导入在环里可能撞 TDZ）。
 */
import type { ToolName } from "@/lib/lab-agent"

export type Entry =
  | {
      key: string
      kind: "user"
      text: string
      /**
       * 这一轮带上来的附件**文件名**（内容不进气泡，见 send 的注释）。
       * 只用于在气泡里显示「附件：xxx.txt」这种标记。
       */
      files?: string[]
      /**
       * 这条消息在 `convoRef` 里的下标。
       * 「编辑重发」时从这里把对话历史截断（见 editMessage）。
       * ⚠️ convoRef 只追加、不重排，所以当时记下的下标永远不会失效。
       */
      convoAt?: number
      /** 发出时刻（毫秒）。工具栏里鼠标悬停时才显示 */
      at?: number
    }
  | {
      key: string
      kind: "text"
      text: string
      /** 还在流式输出中（用于「逐渐显示 + 思考走马灯」） */
      live: boolean
      /** 后面跟着工具调用 → 这是「思考/计划」，折叠展示；否则是给用户的答复 */
      collapsible: boolean
      /** 产出这条的模型名（工具栏里显示 + 小图标）。老草稿没有就不显示 */
      model?: string
      /** 产出时刻（毫秒）。工具栏里鼠标悬停时才显示 */
      at?: number
    }
  | {
      key: string
      kind: "tool"
      tool: ToolName
      path?: string
      /** grep 用：搜索的正则 / 范围，展示在卡片上 */
      pattern?: string
      scope?: string
      /** run 用：完整命令（卡片标题上显示） */
      command?: string
      /** site 用：站内操作的 op id（卡片标题上显示） */
      op?: string
      /** skill 用：读的是哪个技能（卡片标题上显示） */
      skill?: string
      /**
       * `run` 用：模型自己写的一行人话说明（例如「下载环境依赖」）。
       * 有它就**优先显示它**，而不是把命令行直接摆给用户看。
       */
      desc?: string
      /** `http` 用：目标地址（卡片上显示） */
      url?: string
      /** `http` 用：请求方法 */
      httpMethod?: string
      /** screenshot 用：截图 dataUrl（卡片里直接显示成图） */
      image?: string
      /** `web_search` 用：搜索词（卡片上显示） */
      query?: string
      status: "running" | "done"
      content: string
    }

/** 自定义渠道配置（只存浏览器本地） */
export interface CustomChannel {
  baseUrl: string
  apiKey: string
  /** 当前使用的模型（= models[0]；保留它是为了老配置能直接读） */
  model: string
  /**
   * 这个渠道下**可选的多个**模型（2026-10-10 站长要求「支持多选」）。
   * 用户配一次就能在模型菜单里直接切换，不用来回改配置。
   */
  models?: string[]
}

/**
 * 站内三个渠道来源。
 *   · station —— 站内模型（扣自己的中转站额度；管理员开了统一 Key 时是免费试用）
 *   · site    —— 管理员提供的免费渠道（**密钥不下发浏览器**，调用走服务端代理）
 *   · custom  —— 用户自己的自定义渠道（只存本地，浏览器直连）
 */
export type LabChannel = "station" | "site" | "custom"

/** 管理员提供的一条免费渠道（前端只拿得到 id / 名字 / 模型） */
export interface SiteChannel {
  id: string
  name: string
  model: string
  free: boolean
}

/** `GET /api/lab/channels` 的返回 */
export interface SiteChannelsInfo {
  source: "user" | "admin"
  quotaLimit: number
  quotaPeriod: "day" | "month" | "total"
  quotaUsed: number
  /** 原生工具调用开关（站点设置 lab_native_tools；默认关 = 走文本标签协议） */
  nativeTools: boolean
  channels: SiteChannel[]
}
