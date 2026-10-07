/**
 * 空 shim：给「浏览器构建里用不到的 React Native / Node 专属依赖」兜底。
 *
 * jsmediatags 的 ReactNativeFileReader.js 顶部 `import RNFS from "react-native-fs"`，
 * 浏览器环境永远不会走到那个 reader，但 Rolldown 打包时会去解析这个 import 而报错。
 * 把它 alias 到这个空模块即可（导出空对象，永远不会被真正调用）。
 */
export default {}
