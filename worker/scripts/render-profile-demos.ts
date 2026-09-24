/**
 * 生成名片主题样例页：用 mock 数据调用 renderProfileHtml，输出静态 HTML 文件。
 *
 * 用途：审美走查——不启动 Worker、不连 D1，直接看 11 套皮肤 × 多种骨架的真实渲染。
 *
 * 用法（在 worker/ 目录下）：
 *   npx tsx scripts/render-profile-demos.ts [输出目录]
 * 默认输出到 ../.workbuddy/profile-demos/
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { renderProfileHtml } from "../src/profile-page"
import type { PublicProfile } from "../src/handlers/profile"

/** 样例数据：同一个人、同一批模块，只换皮肤/骨架，直观对比差异 */
const base: PublicProfile = {
  slug: "demo",
  username: "demo",
  displayName: "林小满",
  bio: "在山里写代码的人。\n喜欢胶片摄影、手冲咖啡和一切慢的东西。",
  theme: "void",
  accent: null,
  effects: [],
  intro: "none",
  font: "system",
  cjkFont: "system",
  layout: "center",
  avatar: "https://picsum.photos/seed/avatar-demo/200/200",
  background: null,
  music: null,
  musicCover: null,
  musicTitle: null,
  musicAutoplay: false,
  contacts: [
    { type: "github", value: "linxiaoman", visible: true },
    { type: "bilibili", value: "1307574205", visible: true },
    { type: "telegram", value: "xiaoman", visible: true },
    { type: "email", value: "hi@example.com", visible: true },
  ],
  modules: [
    { id: "identity", enabled: true },
    { id: "status", enabled: true, emoji: "🎧", text: "在听雨声写代码" },
    { id: "tags", enabled: true, items: ["摄影", "手冲咖啡", "开源", "骑行", "科幻"] },
    { id: "quote", enabled: true, text: "慢慢来，比较快。\n——写给三年前的自己", author: "佚名" },
    { id: "links", enabled: true },
    {
      id: "timeline",
      enabled: true,
      items: [
        { date: "2021", title: "开始写第一个开源项目", desc: "从此掉进了坑里" },
        { date: "2023", title: "搬到山里住", desc: "网速和心率都降了下来" },
        { date: "2025", title: "拍了第一卷胶片", desc: "等待冲洗的日子很迷人" },
      ],
    },
    {
      id: "gallery",
      enabled: true,
      items: [
        { url: "https://picsum.photos/seed/g1/400/400", caption: "山间晨雾" },
        { url: "https://picsum.photos/seed/g2/400/400", caption: "工作台" },
        { url: "https://picsum.photos/seed/g3/400/400", caption: "第一卷胶片" },
        { url: "https://picsum.photos/seed/g4/400/400", caption: "雨后" },
        { url: "https://picsum.photos/seed/g5/400/400", caption: "路边小猫" },
        { url: "https://picsum.photos/seed/g6/400/400", caption: "夜骑" },
      ],
    },
    { id: "music", enabled: false },
    { id: "stats", enabled: true },
  ],
  registeredAt: "2024-03-15T08:00:00.000Z",
  viewCount: 128,
}

/** 每个样例：文件名 + 覆盖字段 */
const demos: [string, Partial<PublicProfile>][] = [
  ["01-void-center", { theme: "void" }],
  ["02-neon-bento", { theme: "neon", layout: "bento" }],
  ["03-glass-banner", { theme: "glass", layout: "banner", background: "https://picsum.photos/seed/bg-demo/1600/900" }],
  ["04-aurora-side", { theme: "aurora", layout: "side" }],
  ["05-cyber-center", { theme: "cyber", effects: ["rain"] }],
  ["06-blossom-bento", { theme: "blossom", layout: "bento", effects: ["sakura"] }],
  ["07-paper-plain", { theme: "paper", layout: "plain", font: "playfair" }],
  ["08-ink-banner", { theme: "ink", layout: "banner", background: "https://picsum.photos/seed/bg-ink/1600/900", font: "cinzel" }],
  ["09-terminal-center", { theme: "terminal", intro: "typewriter" }],
  ["10-solar-center", { theme: "solar", effects: ["float"] }],
  ["11-royal-center", { theme: "royal", font: "cinzel", effects: ["sparkle"] }],
]

const outDir = resolve(process.argv[2] ?? "../.workbuddy/profile-demos")
mkdirSync(outDir, { recursive: true })

const links: string[] = []
for (const [name, patch] of demos) {
  const profile: PublicProfile = { ...base, ...patch }
  const html = renderProfileHtml(profile)
  writeFileSync(join(outDir, `${name}.html`), html, "utf8")
  links.push(`<li><a href="${name}.html">${name}</a></li>`)
  console.log(`✓ ${name}.html`)
}

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>名片主题样例</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 24px;line-height:2}
a{color:#4f46e5}h1{font-size:20px}</style></head>
<body><h1>名片主题样例（同一数据 × 不同皮肤/骨架）</h1><ul>${links.join("")}</ul></body></html>`,
  "utf8"
)
console.log(`\n共 ${demos.length} 个样例 + index.html → ${outDir}`)
