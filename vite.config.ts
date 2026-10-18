import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
//
// 注意：**不要**加回 @cloudflare/vite-plugin。
// 该插件会把构建产物输出到 dist/client/，并在 dist/ 下生成自己的 Worker 配置；
// 而本项目的部署方式是 wrangler.jsonc + site-worker.js + assets.directory=./dist，
// 期望产物直接在 dist/。加了插件会导致 wrangler 部署到旧的 dist 内容，
// 表现为「代码改了、也部署了，但线上没变化」。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // 用数组形式：需要精确匹配（正则）的条目必须写成 find/replacement ——
    // 对象 key 是前缀匹配，会把子路径一起误替换掉。
    alias: [
      { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
      // jsmediatags 3.9.7 的 main 是 build2/（含 Node / ReactNative 读取器），
      // 它 require('react-native-fs') —— 浏览器项目没有这个包；而它的
      // package.json「字符串形式的 browser 字段」指向 dist/jsmediatags.js，
      // 这个文件在 npm 包里压根不存在（只有 bower 包带 dist）。
      // Rolldown（Vite 8 内核）不认这套老配置，裸 `import jsmediatags`
      // 干净依赖下必现 UNRESOLVED 构建失败。ReactNative 读取器在浏览器里
      // 永远不会被执行（真正用的是 BlobFileReader），钉个空模块过打包即可。
      {
        find: /^react-native-fs$/,
        replacement: path.resolve(import.meta.dirname, "./src/lib/empty-module.ts"),
      },
    ],
  },
  server: {
    // 本地开发时将 /api 代理到 wrangler dev 启动的 Worker。
    //
    // ⚠️ target 必须写 127.0.0.1，**不要**写 localhost：Windows 上 Node 会把
    // localhost 先解析成 IPv6 的 ::1，而 wrangler dev 只监听 IPv4 的
    // 127.0.0.1:8787 —— 于是代理时不时 ECONNREFUSED，浏览器侧表现为
    // `TypeError: Failed to fetch`（同一秒里另一个请求却可能成功，极难排查）。
    // 显式钉住 IPv4 回环后请求稳定。
    proxy: {
      "/api": {
        target: "https://127.0.0.1:8787",
        // ⚠️ 必须保留浏览器侧的 Host（localhost:5173）：worker 的 CSRF 兜底
        // （assertNotCrossSite，2026-10-14 上游加入）会比较 Origin 与 request.url
        // 的 host。changeOrigin: true 会把 Host 改写成 127.0.0.1:8787 ⇒ 本地
        // 所有写请求 403 CSRF_BLOCKED（登录都进不去）。
        changeOrigin: false,
        // wrangler dev 本地强制 https（worker 代码 http→https 301，且只监听 TLS），
        // 自签证书必须关校验，否则代理报 SELF_SIGNED_CERT_IN_CHAIN
        secure: false,
      },
      // 社区帖子图片（/c/<postId>/<filename>）也由 worker 服务，本地同样要代理
      "/c": {
        target: "https://127.0.0.1:8787",
        changeOrigin: false,
        secure: false,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 把不常变的第三方库单独拆包：用户重新访问时命中浏览器缓存，
        // 只有业务代码变化的那部分需要重新下载。
        //
        // 注意：本项目用 Vite 8（Rolldown 内核），manualChunks **只接受函数**，
        // 传对象会报 "manualChunks is not a function"。别改回对象写法。
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom)[\\/]/.test(id)) {
            return "vendor-react"
          }
          // ⚠️ lucide-react **故意不放进 vendor-ui**：它里面是几百个「一图标一文件」的
          // 模块，装箱后不管某个图标只被管理后台用到，也会跟着首屏一起下载
          // （实测这样多拖了 ~100KB、二十多个图标）。不装箱的话，入口用到的那几个
          // 自然留在入口/共享静态 chunk，只给懒加载页用的图标留在那些页面自己的 chunk 里。
          if (
            /[\\/]node_modules[\\/](sonner|class-variance-authority|clsx|tailwind-merge)[\\/]/.test(id)
          ) {
            return "vendor-ui"
          }
          // ⚠️ 其它依赖**不要**再兜底装箱（原来 `return "vendor"`）。
          //
          // 为什么（2026-10 首屏瘦身）：manualChunks 是「按模块打成一箱」，
          // 只要箱子里**有一个**模块被入口静态 import，整箱就必须随首屏下载。
          // 原来所有 node_modules 都被兜进同一个 `vendor`，于是只在懒加载页里
          // 用到的 xlsx（~325KB）/ pdfjs-dist（~312KB）/ pdf-lib（~281KB）/
          // framer-motion（~180KB）/ react-markdown 全家（~215KB）……全被拖进首屏，
          // 那个 chunk 因此长到 1.8MB，而首屏真正需要的只有几十 KB 的 radix。
          //
          // 返回 undefined 表示「交回打包器按 import 关系自然切分」：谁静态 import
          // 它，它就跟谁进同一个（或共享的静态）chunk；只有懒加载页 import 的，
          // 就只会待在那些页面自己的动态 chunk 里，首屏根本看不见。
          //
          // 代价（有意接受）：被「入口 + 某个懒加载页」同时用到的小模块
          // （radix 的几十个工具包、单个 lucide 图标）会各自独立成 0.2～3KB 的
          // 小 chunk，首屏请求数从 11 个变成 33 个。换来的是首屏少下 2.3MB。
          // 这些请求都由 index.html 里的 modulepreload 一次并行发出（HTTP/2 多路复用），
          // 不增加往返；若哪天更在意请求数而不是体积，把 lucide-react 加回上面
          // vendor-ui 那一组即可（代价：首屏多 ~55KB）。
          return
        },
      },
    },
  },
})