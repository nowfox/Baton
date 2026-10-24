// HarmonyOS shell only (harmony/.../bridge/WebUpdater.ets): report that this
// page booted, so the shell keeps a freshly applied web bundle instead of
// rolling it back, then ask it to fetch a newer bundle from the signed-in server.
// Call at the end of an entry module, after every import has evaluated.
const PROMPT_ID = 'harmony-web-update';
const STYLE = `
#${PROMPT_ID}{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:10000;
display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid #30363d;border-radius:10px;
background:#161b22;color:#e6edf3;font:14px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4)}
#${PROMPT_ID} span{flex:1}
#${PROMPT_ID} button{min-height:36px;padding:0 14px;border:0;border-radius:8px;font:inherit;color:#e6edf3;background:transparent}
#${PROMPT_ID} .reload{background:#238636;color:#fff}`;

function showPrompt(doc, updater) {
  if (!doc?.body || doc.getElementById(PROMPT_ID)) return;
  const style = doc.createElement('style');
  style.textContent = STYLE;
  const bar = doc.createElement('div');
  bar.id = PROMPT_ID;
  bar.setAttribute('role', 'status');
  bar.innerHTML = '<span>A new version is ready.</span>'
    + '<button type="button" class="later">Later</button>'
    + '<button type="button" class="reload">Reload</button>';
  bar.querySelector('.later').addEventListener('click', () => { bar.remove(); style.remove(); });
  bar.querySelector('.reload').addEventListener('click', () => updater.apply());
  doc.head.appendChild(style);
  doc.body.appendChild(bar);
}

export function startHarmonyWebUpdate(host) {
  const updater = host?.harmonyWebUpdate;
  if (!updater) return false;
  host.__onHarmonyWebUpdate = () => showPrompt(host.document, updater);
  updater.ready();
  let server = '';
  try { server = host.localStorage.getItem('_as') || ''; } catch {}
  if (server) updater.check(JSON.stringify({ server }));
  return true;
}
