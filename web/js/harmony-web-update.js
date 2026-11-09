// Shells that update their bundled frontend (HarmonyOS: harmony/.../bridge/WebUpdater.ets,
// Windows: src-tauri/src/web_update.rs): report that this page booted, so the shell
// keeps a freshly applied web bundle instead of rolling it back, then let it check the
// signed-in server before the next cold start.
// Call at the end of an entry module, after every import has evaluated.
export function startHarmonyWebUpdate(host) {
  const bridge = host?.harmonyBridge;
  const tauri = host?.__TAURI_INTERNALS__;
  const harmony = typeof bridge?.webReady === 'function';
  if (harmony) {
    bridge.webReady();
  } else if (tauri && typeof tauri.invoke === 'function') {
    // Only Windows release builds act on these; other Tauri shells treat them as no-ops.
    tauri.invoke('web_update_ready').catch(() => {});
  } else {
    return false;
  }
  let server = '';
  try { server = host.localStorage.getItem('_as') || ''; } catch {}
  if (!server) return true;
  if (harmony) bridge.webUpdateCheck(JSON.stringify({ server }));
  else tauri.invoke('web_update_check', { server }).catch(() => {});
  return true;
}
