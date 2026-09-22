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
})