/** sanitizeModules / parseModules 行为冒烟（不连 D1）。 */
import { sanitizeModules, parseModules } from "../src/handlers/profile"
import type { GalleryItem } from "../src/handlers/profile"

let failures = 0
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++
    console.error(`✗ ${name}`)
  } else {
    console.log(`✓ ${name}`)
  }
}

// 1. 白名单 + 去重 + 保序
const m1 = sanitizeModules([
  { id: "tags", enabled: true, items: ["摄影", "  ", "骑行", 123] },
  { id: "hacker", enabled: true },
  { id: "tags", enabled: false, items: ["重复id"] },
  { id: "quote", enabled: true, text: "  慢慢来，比较快。 ", author: "佚名" },
])
check("未知 id 被剔除", !m1.some((m) => m.id === "hacker"))
check("重复 id 只保留第一个", m1.filter((m) => m.id === "tags").length === 1)
check("tags 清洗：去空白/非字符串", JSON.stringify(m1[0].items) === JSON.stringify(["摄影", "骑行"]))
check("quote 去首尾空格", m1[1].text === "慢慢来，比较快。")

// 2. gallery 只收 https 或本站在线上传的相对地址，javascript: 被挡
const m2 = sanitizeModules([
  {
    id: "gallery",
    enabled: true,
    items: [
      { url: "https://example.com/a.jpg", caption: "好" },
      { url: "http://example.com/b.jpg", caption: "http 不要" },
      { url: "javascript:alert(1)", caption: "xss" },
      { url: "/p/Doulor/gallery/ab12cd34ef56", caption: "本站在线上传" },
      { url: "/p/Doulor/gallery/../../etc/passwd", caption: "路径穿越" },
      "not-an-object",
    ],
  },
])
check("gallery 保留 https 与本站相对地址", m2[0].items?.length === 2)
check(
  "gallery 拒绝路径穿越",
  !(m2[0].items ?? []).some((i) => String((i as GalleryItem).url).includes(".."))
)

// 3. timeline 必须有 title，上限 8
const m3 = sanitizeModules([
  {
    id: "timeline",
    enabled: true,
    items: [
      { date: "2024", title: "", desc: "无标题丢弃" },
      { date: "2024", title: "有标题", desc: "保留" },
    ],
  },
])
check("timeline 丢弃无标题条目", m3[0].items?.length === 1)

// 4. status：空文本 → 模块数据为空（渲染层自动隐藏）
const m4 = sanitizeModules([{ id: "status", enabled: true, emoji: "🎧", text: "   " }])
check("status 空文本不存 text", m4[0].text === undefined)

// 5. parseModules 容错：坏 JSON / null / 非数组
check("parseModules 坏 JSON → []", parseModules("{oops").length === 0)
check("parseModules null → []", parseModules(null).length === 0)
check("parseModules 非数组 → []", parseModules('"str"').length === 0)

// 6. 超长截断
const m6 = sanitizeModules([{ id: "tags", enabled: true, items: ["x".repeat(50)] }])
check("tag 截断到 12 字", (m6[0].items?.[0] as string).length === 12)

// 7. quote 允许换行：保留 \n，最多 5 行，长度上限 200
const m7 = sanitizeModules([
  { id: "quote", enabled: true, text: "第一行\n第二行\n第三行", author: "我" },
])
check("quote 保留换行", m7[0].text === "第一行\n第二行\n第三行")
check("quote 作者保留", m7[0].author === "我")

const m8 = sanitizeModules([
  { id: "quote", enabled: true, text: Array.from({ length: 10 }, (_, i) => `行${i}`).join("\n") },
])
check("quote 最多 5 行", (m8[0].text ?? "").split("\n").length === 5)

const m9 = sanitizeModules([{ id: "quote", enabled: true, text: "长".repeat(500) }])
check("quote 截断到 200 字", (m9[0].text ?? "").length === 200)

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log("\n全部通过")
