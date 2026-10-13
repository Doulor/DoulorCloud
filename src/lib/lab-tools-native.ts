/**
 * **原生工具调用**（native function calling）的工具声明 —— 2026-10-10 新增。
 *
 * 背景：本站 AI 实验室原本用「文本标签协议」（模型在正文里写 `<lab_read path="…"/>`，
 * 前端正则解析）。那套协议带来了一整类问题：标签被套进 `<tool_call>` 壳、
 * 模型只输出思考不输出正文、重复读文件、需要 CLOSING_NUDGE 之类的补丁。
 *
 * 2026-10-10 实测确认 **上游全量支持原生 function calling**（8/8 模型，流式也支持，
 * `tool_calls` 分片能正确拼回、`finish_reason: tool_calls`）⇒ 迁移可行。
 *
 * ⚠️ 这里只声明**工具的名字与参数**。执行逻辑一律复用现有的 Segment 应用链 ——
 *    见 `nativeToolCallToSegments()`：把结构化调用**翻译成和标签协议完全一样的
 *    `Segment`**，这样循环下游（执行、工具卡片、回喂、UI）**一行都不用改**。
 *
 * ⚠️ 工具名刻意与内部 `ToolName` 完全一致（read / write / …），
 *    这样翻译层是一张直接的映射表。**改名要两边一起改。**
 */

/** 单个工具的声明形状（OpenAI 兼容） */
export interface NativeToolDecl {
  type: "function"
  function: {
    name: string
    description: string
    parameters: {
      type: "object"
      properties: Record<string, unknown>
      required?: string[]
      additionalProperties?: boolean
    }
  }
}

const str = (description: string) => ({ type: "string", description })

/**
 * 全部工具声明。
 *
 * ⚠️ description 是**模型唯一的说明书** —— 原生模式下不再有提示词里的标签教学，
 *    写得含糊模型就会用错。改的时候按「给一个没看过本项目的人看」的标准写。
 */
export const NATIVE_TOOLS: NativeToolDecl[] = [
  {
    type: "function",
    function: {
      name: "read",
      description:
        "读取项目里的一个文件，返回完整内容。**不要重复读同一个文件** —— 你读过的内容已经在对话里了；" +
        "只有「刚改过要看结果」或「只要一小段（用 grep 定位）」才需要再读。" +
        "文件很大时会截断（上限约 2 万字符）。",
      parameters: {
        type: "object",
        properties: { path: str("文件路径，例如 index.html 或 css/style.css") },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description:
        "把内容写入（或覆盖）一个文件。路径不存在会自动创建。**写完不要再读一遍回来确认**。" +
        "⚠️ 只在**新建文件**或**整段重做**时用它；只改一小段请用 replace —— " +
        "整文件重写又慢又贵，还容易把没打算改的地方改坏。",
      parameters: {
        type: "object",
        properties: {
          path: str("文件路径"),
          content: str("这个文件要写入的完整内容"),
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace",
      description:
        "改文件**首选这个**：把 old 那段原文换成 new。old 要与文件里**逐字一致**（含缩进）。" +
        "⚠️ 失败时返回里会给出「最像的那一段 + 行号」，照它修正 old **再试一次**；" +
        "不要因为一次没匹配上就改用 write 整文件重写。",
      parameters: {
        type: "object",
        properties: {
          path: str("文件路径"),
          old: str("要被替换掉的原文（与文件里逐字一致，含缩进）"),
          new: str("替换成的新内容"),
        },
        required: ["path", "old", "new"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list",
      description: "列出项目里的所有文件路径。想了解项目结构先调它。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "delete",
      description: "删除项目里的一个文件。",
      parameters: {
        type: "object",
        properties: { path: str("要删除的文件路径") },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "在项目里搜索（相当于 grep），按行返回并带行号。**找某段代码 / 样式在哪，先用它而不是一个个文件读**。",
      parameters: {
        type: "object",
        properties: {
          pattern: str("搜索模式，支持正则，例如 id=\"app\"|class=\"btn\""),
          in: str("限定范围，可省略；可写 *.css 或 src/**/*.js"),
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "need_vm",
      description:
        "申请启用「浏览器终端」（跑在用户浏览器里的一台真 Linux）。**必须先申请并等用户同意**，" +
        "之后才能用 run 执行命令。被拒绝后就别再申请，改用文件工具把活干完。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run",
      description:
        "在浏览器终端里执行一条 shell 命令（**需要先成功调用 need_vm**）。项目文件在 /root/project 下，" +
        "每次执行前会自动同步。调用前先用 desc 写一句人话说明你在做什么。",
      parameters: {
        type: "object",
        properties: {
          command: str("要执行的 shell 命令"),
          desc: str("给用户看的一行人话说明，例如「下载环境依赖」——不要抄命令本身"),
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "site_manual",
      description: "取回「站内操作」的完整手册（能做哪些操作、每个操作的参数）。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "site",
      description:
        "执行一次站内数据操作（子域名 / DNS / 邮箱 / 网盘 / 作品公开等）。" +
        "**先用 site_manual 取手册**，按手册里的 op 名与参数来。写操作会让用户确认。",
      parameters: {
        type: "object",
        properties: {
          op: str("操作 id，见 site_manual 返回的手册"),
          payload: {
            type: "object",
            description: "该操作的参数对象，键名见手册；没有参数就传空对象",
          },
        },
        required: ["op"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill",
      description:
        "读取一份「技能」说明书（例如做某类页面的做法）。什么时候用哪份，看系统提示里的技能清单。",
      parameters: {
        type: "object",
        properties: { name: str("技能的名字，见系统提示里的清单") },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "联网搜索最新资料（需要用户在界面里开启联网搜索才可用）。",
      parameters: {
        type: "object",
        properties: { query: str("搜索关键词") },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect",
      description:
        "用真浏览器把页面跑一遍，返回**文字体检报告**：横向溢出了多少像素、哪些元素溢出、" +
        "图片有没有加载失败、console 有没有报错（含 JS 异常）。" +
        "⚠️ 样式改了不确定对不对、或页面「点了没反应」时用它 —— 比截图更适合定位问题，" +
        "因为你拿到的是一行行具体结论。",
      parameters: {
        type: "object",
        properties: {
          width: { type: "number", description: "视口宽度，默认 1280" },
          height: { type: "number", description: "视口高度，默认 800" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "screenshot",
      description:
        "把当前项目渲染成真实页面并**截图**，然后你就能「看见」自己做的网页。" +
        "⚠️ 做完页面或改了样式之后用它自检：布局错位、元素重叠、文字被裁、颜色难看，" +
        "这些只读代码是发现不了的。截图会作为图片发给你。参数都可不填。",
      parameters: {
        type: "object",
        properties: {
          fullPage: { type: "boolean", description: "是否截整页（默认 true）" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http",
      description:
        "抓一个网址（由服务端代你请求；返回状态码 + 正文）。用户说「参考这个网址」「照这个风格做一版」" +
        "「看看这个页面」时，就用它把页面抓回来看；也可以用它调公开接口取数据。" +
        "⚠️ 只支持 GET / POST / HEAD；网页默认转成纯文本，要看 HTML 结构 / 类名就加 raw。",
      parameters: {
        type: "object",
        properties: {
          url: str("目标网址，含 http:// 或 https://"),
          method: { type: "string", enum: ["GET", "POST", "HEAD"], description: "默认 GET" },
          raw: { type: "boolean", description: "true = 原样返回 HTML（看结构/类名时用）" },
          body: str("POST 的请求体（JSON 字符串）"),
        },
        required: ["url"],
      },
    },
  },
]

/** 只要名字和描述（系统提示里列一份极简清单用，不占多少 token） */
export function nativeToolNames(): string[] {
  return NATIVE_TOOLS.map((t) => t.function.name)
}
