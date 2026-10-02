/**
 * 模型名 → 厂商归类：给「全部可用模型」里模型多的分组再切一层小节用。
 *
 * 为什么不能只看名字开头：这些名字的构成很杂 ——
 *   qwen3.8-27b                      纯模型名
 *   senseNova-kimi-k3                渠道前缀 + 真模型名
 *   workbuddy-hy4-preview-f          渠道前缀 + 系列代号
 *   donation-[OR号池]google/gemma-4-26b-a4b-it
 *                                    捐献前缀 + 渠道标注 + HF 路径
 * 所以做法是拿**整串**去搜关键词，并且规则**按优先级**排：
 *
 *   1. 会被别家名字借用的厂商先认领：`llama-3.1-nemotron` 是 NVIDIA 的、
 *      `Hermes-Llama` 是 Nous 微调的、`Muse Spark` 是 Meta 的不是讯飞星火。
 *   2. 各家的系列词（deepseek / qwen / glm / gemini …）—— 真模型名因此压过
 *      渠道前缀，`senseNova-kimi-k3` 才不会被认成商汤。
 *   3. 剩下的通用名垫底（本表里是 sensenova 一类），只兜住 `sensenova-u1-fast`
 *      这种没有系列词的名字。
 *
 * 厂商名直接用官方英文品牌名，不进 i18n 词典 —— 品牌名译成中文没有意义，
 * 而且模型名本身就是英文。只有认不出来的 OTHER_VENDOR 由前端翻成「其他/Other」。
 *
 * 判定分两层（见文件末尾 sectionOf）：
 *
 *   1. **先看模态**：名字里有 image / video / audio / tts 这类「产物词」的，
 *      按声音 / 图片 / 视频分节，不再看厂商 —— 找生图和视频模型的人想的是
 *      「我要画张图」，不是「我要用谁家的」。
 *      只认产物词，不认 vision / vl / multimodal 这类「理解词」，否则
 *      `qwen3-vl-235b`（看图说话，输出仍是文本）会被误判成图片模型。
 *   2. **再看厂商**：剩下的按上表归类，认不出的进「其他」。
 *
 * 维护：站点里出现认不出的新模型时，会落进「其他」小节；把它的系列词补进下表
 * 即可（脚本 scripts/check-model-vendors.mjs 里有真实名字的回归用例）。
 */

/** 兜底小节；不是厂商，显示名走 i18n（ai.group.other） */
export const OTHER_VENDOR = "__other__"

/**
 * 非文本模型按「处理的是什么媒体」分节，不分厂商。
 * 三个标识不需要翻译成中文节名以外的语义，但也要走 i18n（ai.group.*）。
 */
export const MODALITY_AUDIO = "__audio__"
export const MODALITY_IMAGE = "__image__"
export const MODALITY_VIDEO = "__video__"

/** 模型数超过这个阈值才按厂商分小节。十几个模型平铺更好扫，几百个才需要结构 */
export const VENDOR_SPLIT_THRESHOLD = 30

/**
 * 模态关键词表，排在厂商表之前生效（谁先命中算谁的）。
 *
 * 顺序是 **图片 → 视频 → 声音**，不是随便排的：商汤的 SenseAudio 虽然是语音
 * 品牌，旗下也有 `senseaudio-image-2.0`、`senseaudio-video` 这种非语音模型，
 * 而它的名字里永远带着「audio」。先判图片/视频，这些才不会被那个品牌词拽进声音节。
 * 反过来 `senseaudio-tts`、`senseaudio-music` 里没有图/视频产物词，落到声音，对。
 *
 * 只认「产物词」：生图、视频、语音合成/识别、音乐音效。
 * **不要**把 vision / vl / multimodal / omni 加进来 —— 那些是「能看懂」而不是
 * 「能生成」，`qwen3-vl-235b`、`gemini-3-pro` 输出仍是文本，应该按厂商归。
 */
const MODALITY_RULES: { modality: string; pattern: RegExp }[] = [
  {
    modality: MODALITY_IMAGE,
    pattern:
      /image|img[-_.]?[0-9]|dall-?e|\bimagen|seedream|kolors|wanx|\bflux|banana|stable-?diffusion|\bsd[-_.]?[0-9]|sensenova-u[0-9]/i,
  },
  {
    modality: MODALITY_VIDEO,
    pattern: /video|\bveo|\bsora|\bkling|seedance|hailuo|dreamactor|omni-?human/i,
  },
  {
    modality: MODALITY_AUDIO,
    pattern:
      /audio|voice|tts|asr|speech|music|sfx|sound|song|whisper|smart-turn|realtime[-_ ]?voice/i,
  },
]

/**
 * 关键词表，顺序 = 匹配优先级，越靠前越优先。
 *
 * 正则一律**不带 g 标志** —— 带 g 的 test() 会记 lastIndex，跨次调用串味。
 * 判断的是「整串里有没有」，所以不锚定开头，天然兼容各种渠道前缀。
 */
const VENDOR_RULES: { vendor: string; pattern: RegExp }[] = [
  // ── 名字会被别家借用的，先认领 ────────────────────────────────
  // llama-nemotron 是英伟达的、Hermes-Llama 是 Nous 微调的、Muse Spark 是
  // Meta 的而不是讯飞「星火」—— 这三条不排在前面就会被认错东家。
  { vendor: "NVIDIA", pattern: /nemotron|nvidia|\bising/i },
  { vendor: "Nous Research", pattern: /hermes|\bnous[-_]/i },
  { vendor: "Meta", pattern: /llama|meta-llama|\bmuse\b/i },

  // ── 海外前沿 ─────────────────────────────────────────────────
  { vendor: "OpenAI", pattern: /gpt|\bchatgpt|\bcodex\b|dall-?e|\bwhisper\b|\bsora\b|\bo[1-9][-_]/i },
  { vendor: "Anthropic", pattern: /claude/i },
  { vendor: "Google", pattern: /gemini|gemma|\bpalm\b|learnlm|imagen|\bveo|banana/i },
  { vendor: "xAI", pattern: /\bgrok/i },

  // ── 海外开源与云厂商 ─────────────────────────────────────────
  { vendor: "Mistral", pattern: /mistral|mixtral|codestral|devstral|magistral|pixtral|voxtral|ministral/i },
  { vendor: "Poolside", pattern: /poolside|laguna[-_. ]?[a-z]{1,2}[-_.]?[0-9]/i },
  { vendor: "Thinking Machines", pattern: /thinking[-_.]?machines|\binkling/i },
  { vendor: "Agnes AI", pattern: /\bagnes/i },
  { vendor: "TypeSafe AI", pattern: /typesafe|\bjev\b/i },
  { vendor: "OpenCode", pattern: /opencode|big-pickle/i },
  { vendor: "Pipecat AI", pattern: /pipecat|pipelcat|smart-turn/i },
  { vendor: "Microsoft", pattern: /\bphi[-_.]?[0-9]|\bmai[-_](1|voice|image|speech)/i },
  { vendor: "Amazon", pattern: /amazon[-_.]|\bnova[-_.]?(pro|lite|micro|premier|canvas|reel|sonic|[0-9])|\btitan[-_.]/i },
  { vendor: "Cohere", pattern: /command[-_ ]?[ra]|c4ai|\bcohere|aya[-_ ]?(expanse|vision|[0-9])/i },
  { vendor: "AI21", pattern: /\bjamba/i },
  { vendor: "IBM", pattern: /\bgranite/i },
  { vendor: "Allen AI", pattern: /\bolmo|\bmolmo|\btulu/i },
  { vendor: "TII", pattern: /\bfalcon/i },
  { vendor: "Databricks", pattern: /\bdbrx/i },
  { vendor: "Perplexity", pattern: /\bsonar/i },
  { vendor: "Liquid AI", pattern: /\blfm[-_.]?[0-9]/i },
  { vendor: "Reka", pattern: /\breka[-_ ]?(core|flash|edge|think)/i },
  { vendor: "Hugging Face", pattern: /\bsmollm|huggingface/i },
  { vendor: "Writer", pattern: /\bpalmyra/i },
  { vendor: "Stability AI", pattern: /stable-?lm|stable-?code/i },
  { vendor: "BigCode", pattern: /starcoder/i },
  { vendor: "EleutherAI", pattern: /\bpythia/i },
  { vendor: "RWKV", pattern: /\brwkv/i },
  { vendor: "Zyphra", pattern: /\bzamba/i },
  { vendor: "Snowflake", pattern: /\barctic/i },
  { vendor: "Salesforce", pattern: /\bxgen/i },
  { vendor: "Upstage", pattern: /\bsolar[-_ ]?(pro|mini|10)/i },
  { vendor: "Inception Labs", pattern: /\bmercury[-_ ]?(coder|small|2)/i },
  { vendor: "Bouquet", pattern: /\bbouquet/i },

  // ── 国内 ─────────────────────────────────────────────────────
  { vendor: "DeepSeek", pattern: /deepseek/i },
  { vendor: "Alibaba", pattern: /qwen|qwq|qvq|tongyi|alibaba|wanx|wan[-_./]?[0-9]/i },
  { vendor: "Zhipu AI", pattern: /glm|chatglm|cogvlm|cogview|zhipu|z\.ai|zai-org/i },
  { vendor: "Moonshot", pattern: /kimi|moonshot/i },
  { vendor: "MiniMax", pattern: /minimax|abab|hailuo/i },
  { vendor: "ByteDance", pattern: /doubao|seedream|seedance|skylark|ui-?tars|bytedance|seed[-_./]?(oss|[0-9])/i },
  { vendor: "Tencent", pattern: /hunyuan|\bhy[-_.]?[0-9]/i },
  { vendor: "Baidu", pattern: /ernie|wenxin/i },
  { vendor: "iFlytek", pattern: /xinghuo|iflytek|\bspark[-_ ]?(lite|max|pro|v[0-9]|[0-9])/i },
  // 商汤排在最后：渠道名 senseNova 会挂在别人的模型前面（senseNova-kimi-k3）
  { vendor: "SenseTime", pattern: /sensenova|sense[-_.]?nova|sensechat|sensetime|senseaudio|sense[-_.]?(text|asr|tts|voice|image|video|music|sfx)/i },
  { vendor: "StepFun", pattern: /\bstepfun|\bstep[-_.]?(audio|router|[0-9])/i },
  { vendor: "Baichuan", pattern: /baichuan/i },
  { vendor: "01.AI", pattern: /01-ai|\byi[-_.]?(large|lightning|vision|vl|[0-9])/i },
  { vendor: "Shanghai AI Lab", pattern: /internlm|internvl|intern[-_.]?s[0-9]|atria|opengvlab/i },
  { vendor: "RedNote", pattern: /rednote|dots[-_.]?(studio|llm|[0-9])/i },
  { vendor: "Meituan", pattern: /longcat/i },
  { vendor: "Xiaomi", pattern: /\bmimo/i },
  { vendor: "Huawei", pattern: /pangu/i },
  { vendor: "Ant Group", pattern: /bailing|inclusionai|\bling[-_.]?[0-9]|\bring[-_.]?[0-9]/i },
  { vendor: "Kuaishou", pattern: /\bkling|\bkwai|kolors/i },
  { vendor: "JD Cloud", pattern: /joyai|\bjoy[-_.]?(ai|coder)/i },
  { vendor: "Kunlun Tech", pattern: /skywork|skyreels/i },
  { vendor: "OpenBMB", pattern: /minicpm|\bcpm[-_.]?[0-9]/i },
  { vendor: "BAAI", pattern: /\baquila|\bbge[-_]/i },
  { vendor: "360", pattern: /360[-_.]?(gpt|zhinao|brain)|zhinao/i },
  { vendor: "vivo", pattern: /bluelm/i },
  { vendor: "China Telecom", pattern: /telechat|teleai/i },
  { vendor: "Yuanxiang", pattern: /xverse/i },
  { vendor: "Langboat", pattern: /mengzi/i },

  // ── 平台兜底 ────────────────────────────────────────────────
  // `@cf/…` 是 Cloudflare Workers AI 的命名空间（smart-turn-v2 挂在那里）。
  // 必须排在所有厂商之后：`@cf/meta/llama-3-8b` 要先归 Meta 才算对。
  { vendor: "Cloudflare", pattern: /@cf\/|cloudflare|workers[-_. ]?ai/i },

]

/** 单个模型名归到哪个模态（声音/图片/视频）；不是非文本模型返回 null */
export function modalityOf(model: string): string | null {
  for (const { modality, pattern } of MODALITY_RULES) {
    if (pattern.test(model)) return modality
  }
  return null
}

/**
 * 模型归到哪一节：先看模态（声音 / 图片 / 视频），再看厂商，都认不出才是「其他」。
 * 返回值可能是厂商名，也可能是 MODALITY_* / OTHER_VENDOR 这类标识。
 */
export function sectionOf(model: string): string {
  const modality = modalityOf(model)
  if (modality) return modality

  for (const { vendor, pattern } of VENDOR_RULES) {
    if (pattern.test(model)) return vendor
  }
  return OTHER_VENDOR
}

/**
 * 把模型分节。排序规则：模型多的节在前（用户最常找的就是那几家），
 * 「其他」永远垫底，同数量按节名排，保证顺序稳定不跳。
 *
 * 模态节和厂商节一起按数量排，不另分区块 —— 声音模型多的时候它就该在前面。
 */
export function groupModelsBySection(
  models: string[]
): { section: string; models: string[] }[] {
  const buckets = new Map<string, string[]>()
  for (const model of models) {
    const section = sectionOf(model)
    const list = buckets.get(section)
    if (list) list.push(model)
    else buckets.set(section, [model])
  }
  return [...buckets]
    .map(([section, list]) => ({ section, models: list }))
    .sort((a, b) => {
      if (a.section === OTHER_VENDOR) return 1
      if (b.section === OTHER_VENDOR) return -1
      return b.models.length - a.models.length || a.section.localeCompare(b.section)
    })
}
