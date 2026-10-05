/**
 * 浏览器侧的空模块占位。
 *
 * 目前只有一个用途：`react-native-fs`（见 vite.config.ts 的 alias）。
 * jsmediatags 3.9.7 的 build2/NodeFileReader 是 Node 入口才用的文件读取器，
 * 它 `require('react-native-fs')` —— 浏览器项目当然没有这个包，而它的
 * package.json 里 browser 字段指向的 dist/ 在 npm 包中又不存在，
 * 于是 Rolldown（Vite 8 内核）解析到 react-native-fs 时直接构建失败。
 * 真正跑在浏览器里的读取器是 BlobFileReader，这条 RN 分支永远不会执行，
 * 钉一个空模块让它过打包即可。
 */
export default {}
