// HarmonyOS NEXT shell: every native capability arrives on one declarative
// javaScriptProxy object (harmony/.../bridge/NativeBridge.ets). That attribute is
// the injection form verified to work on the first page load, while
// registerJavaScriptProxy documents that its objects "在页面下一次（重新）加载前
// 不会出现在 JavaScript 中". The single window.harmonyBridge is expanded here into
// the per-feature namespaces the rest of the frontend feature-detects, so no
// other module knows about the facade.
//
// Must run before anything detects a bridge: it is the first import of
// entry-index.js and entry-landing.js. Idempotent, and a no-op off HarmonyOS.
export function installHarmonyBridges(host) {
  const bridge = host && host.harmonyBridge;
  if (!bridge || typeof bridge.download !== 'function' || host.harmonyDownloadBridge) return false;
  host.harmonyScanBridge = { scan: () => bridge.scan() };
  host.harmonyDownloadBridge = { download: args => bridge.download(args) };
  host.harmonyOpenBridge = { open: args => bridge.openExternal(args) };
  host.harmonyPreviewBridge = {
    start: args => bridge.previewStart(args),
    stop: args => bridge.previewStop(args),
    reset: args => bridge.previewReset(args),
    write: args => bridge.previewWrite(args),
    shutdownWrite: args => bridge.previewShutdownWrite(args),
    credit: args => bridge.previewCredit(args),
    closeSocket: args => bridge.previewCloseSocket(args),
  };
  return true;
}

if (typeof window !== 'undefined') installHarmonyBridges(window);
