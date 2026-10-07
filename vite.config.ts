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
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      // jsmediatags 的 ReactNativeFileReader.js 顶部 import RNFS from "react-native-fs"，
      // 浏览器永远不走到那个 reader，但 Rolldown 打包时会解析这个 import 而报错。
      // alias 到空 shim 兜底（详见 src/shims/react-native-fs.ts）。
      "react-native-fs": path.resolve(import.meta.dirname, "./src/shims/react-native-fs.ts"),
    },
  },
  server: {
    // 本地开发时将 /api 代理到 wrangler dev 启动的 Worker
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
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
          if (
            /[\\/]node_modules[\\/](lucide-react|sonner|class-variance-authority|clsx|tailwind-merge)[\\/]/.test(
              id
            )
          ) {
            return "vendor-ui"
          }
          return "vendor"
        },
      },
    },
  },
})