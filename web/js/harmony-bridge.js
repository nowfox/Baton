// HarmonyOS NEXT shell: ArkWeb injects exactly one declarative javaScriptProxy
// object into the first page load (harmony/.../bridge/NativeBridge.ets), because
// registerJavaScriptProxy objects "在页面下一次（重新）加载前不会出现在
// JavaScript 中" — on device they never showed up at all. That single
// window.harmonyBridge is expanded here into the per-feature namespaces the rest
// of the frontend feature-detects, so no other module knows about the facade.
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
