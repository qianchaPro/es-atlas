module.exports = function beforeBuild(context) {
  // Windows 在 macOS 上交叉打包，ssh2 的可选原生模块无法跨平台重建并会自动回退到纯 JavaScript。
  return context.platform.nodeName !== 'win32'
}
