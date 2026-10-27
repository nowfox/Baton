// HarmonyOS shell only (harmony/.../bridge/WebUpdater.ets): report that this
// page booted, so the shell keeps a freshly applied web bundle instead of
// rolling it back, then let it check the signed-in server before the next cold start.
// Call at the end of an entry module, after every import has evaluated.
export function startHarmonyWebUpdate(host) {
  const bridge = host?.harmonyBridge;
  if (!bridge || typeof bridge.webReady !== 'function') return false;
  bridge.webReady();
  let server = '';
  try { server = host.localStorage.getItem('_as') || ''; } catch {}
  if (server) bridge.webUpdateCheck(JSON.stringify({ server }));
  return true;
}
