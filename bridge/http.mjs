let _config;

export function initHttp(config) {
  _config = config;
}

export async function get(endpoint) {
  try {
    const res = await fetch(`${_config.server}${endpoint}`, { headers: { 'x-api-key': _config.apiKey } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

let _decorateSession = null;

// Fields only this process knows (e.g. pool background tasks) ride on every sync-sessions row.
export function setSessionDecorator(fn) {
  _decorateSession = fn;
}

export async function post(endpoint, data, options = {}) {
  if (_decorateSession && endpoint === '/api/bridge/sync-sessions' && Array.isArray(data?.sessions)) {
    data = { ...data, sessions: data.sessions.map(_decorateSession) };
  }
  try {
    const res = await fetch(`${_config.server}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': _config.apiKey },
      body: JSON.stringify(data),
      signal: options.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`POST ${endpoint} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return res;
  } catch (err) {
    console.error(`POST ${endpoint} failed: ${err.message}`);
    return null;
  }
}

export async function postRequired(endpoint, data, options) {
  const response = await post(endpoint, data, options);
  if (!response?.ok) throw new Error(`POST ${endpoint} failed`);
  return response;
}
