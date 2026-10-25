// HarmonyOS shell only (harmony/.../bridge/WebUpdater.ets): report that this
// page booted, so the shell keeps a freshly applied web bundle instead of
// rolling it back, then let it look for a newer bundle on the signed-in server.
// The shell checks once per cold start and serves what it finds from the next one.
// Call at the end of an entry module, after every import has evaluated.
export function startHarmonyWebUpdate(host) {
  const updater = host?.harmonyWebUpdate;
  if (!updater) return false;
  updater.ready();
  let server = '';
  try { server = host.localStorage.getItem('_as') || ''; } catch {}
  if (server) updater.check(JSON.stringify({ server }));
  return true;
}
