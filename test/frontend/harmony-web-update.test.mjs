import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { startHarmonyWebUpdate } from '../../web/js/harmony-web-update.js';

const updaterSource = readFileSync(new URL('../../harmony/entry/src/main/ets/bridge/WebUpdater.ets', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../../vite.config.js', import.meta.url), 'utf8');
const windowsUpdaterSource = readFileSync(new URL('../../src-tauri/src/web_update.rs', import.meta.url), 'utf8');

function facade(calls) {
  const record = name => args => calls.push(args === undefined ? [name] : [name, args]);
  return {
    scan: record('scan'), download: record('download'), openExternal: record('openExternal'),
    previewStart() {}, previewStop() {}, previewReset() {}, previewWrite() {},
    previewShutdownWrite() {}, previewCredit() {}, previewCloseSocket() {},
    webReady: record('webReady'), webUpdateCheck: record('webUpdateCheck'),
  };
}

function shell({ server } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://local.test/index.html' });
  const calls = [];
  const host = dom.window;
  host.harmonyBridge = facade(calls);
  if (server) host.localStorage.setItem('_as', server);
  return { host, calls };
}

test('a booted page reports ready, then asks the shell to check the signed-in server', () => {
  const { host, calls } = shell({ server: 'https://example.cloudfront.net' });

  assert.equal(startHarmonyWebUpdate(host), true);
  assert.deepEqual(calls[0], ['webReady']);
  assert.deepEqual(calls[1][0], 'webUpdateCheck');
  assert.deepEqual(JSON.parse(calls[1][1]), { server: 'https://example.cloudfront.net' });
});

test('before sign-in the page still reports ready but has no server to check', () => {
  const { host, calls } = shell();

  startHarmonyWebUpdate(host);
  assert.deepEqual(calls, [['webReady']]);
});

function tauriShell({ server, reject = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://tauri.localhost/index.html' });
  const calls = [];
  const host = dom.window;
  host.__TAURI_INTERNALS__ = {
    invoke(cmd, args) {
      calls.push(args === undefined ? [cmd] : [cmd, args]);
      return reject ? Promise.reject(new Error(`unknown command ${cmd}`)) : Promise.resolve(null);
    },
  };
  if (server) host.localStorage.setItem('_as', server);
  return { host, calls };
}

test('in Tauri a booted page reports ready, then hands the signed-in server to the shell', () => {
  const { host, calls } = tauriShell({ server: 'https://example.cloudfront.net' });

  assert.equal(startHarmonyWebUpdate(host), true);
  assert.deepEqual(calls, [
    ['web_update_ready'],
    ['web_update_check', { server: 'https://example.cloudfront.net' }],
  ]);
});

test('in Tauri before sign-in the page only reports ready', () => {
  const { host, calls } = tauriShell();

  startHarmonyWebUpdate(host);
  assert.deepEqual(calls, [['web_update_ready']]);
});

test('a Tauri shell that rejects the commands does not surface errors', async () => {
  const { host } = tauriShell({ server: 'https://example.cloudfront.net', reject: true });
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.equal(startHarmonyWebUpdate(host), true);
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('browsers and shells without the updater are untouched', () => {
  assert.equal(startHarmonyWebUpdate({}), false);

  const host = { harmonyBridge: { ...facade([]), webReady: undefined } };
  assert.equal(startHarmonyWebUpdate(host), false);
});

test('the shell and the build agree on the native API level', () => {
  const shellLevel = updaterSource.match(/export const NATIVE_API: number = (\d+);/)[1];
  const buildLevel = viteConfig.match(/const HARMONY_NATIVE_API = (\d+);/)[1];
  assert.equal(shellLevel, buildLevel);

  const windowsLevel = windowsUpdaterSource.match(/pub const NATIVE_API: u32 = (\d+);/)[1];
  const windowsBuildLevel = viteConfig.match(/const WINDOWS_NATIVE_API = (\d+);/)[1];
  assert.equal(windowsLevel, windowsBuildLevel);
});

test('the build publishes a manifest whose hashes and version match the output', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'baton-web-manifest-'));
  try {
    await build({ configFile: new URL('../../vite.config.js', import.meta.url).pathname, logLevel: 'silent', build: { outDir } });
    const manifest = JSON.parse(readFileSync(join(outDir, 'web-manifest.json'), 'utf8'));
    const paths = manifest.files.map(file => file.path);

    assert.match(manifest.version, /^[0-9a-f]{16}$/);
    assert.equal(manifest.nativeApi, Number(viteConfig.match(/const HARMONY_NATIVE_API = (\d+);/)[1]));
    assert.equal(manifest.windowsNativeApi, Number(viteConfig.match(/const WINDOWS_NATIVE_API = (\d+);/)[1]));
    assert.ok(paths.includes('landing.html') && paths.includes('index.html'));
    assert.ok(!paths.includes('web-manifest.json'));
    assert.deepEqual(paths, paths.slice().sort());
    for (const file of manifest.files) {
      // WebUpdater.ets rejects any path outside this alphabet.
      assert.match(file.path, /^[A-Za-z0-9._@~+-]+(\/[A-Za-z0-9._@~+-]+)*$/);
      const data = readFileSync(join(outDir, file.path));
      assert.equal(file.size, data.length);
      assert.equal(file.sha256, createHash('sha256').update(data).digest('hex'));
    }
    const version = createHash('sha256')
      .update(manifest.files.map(file => `${file.path}\0${file.sha256}\n`).join(''))
      .digest('hex').slice(0, 16);
    assert.equal(manifest.version, version);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('the shell serves only verified, atomically installed bundles', () => {
  const index = readFileSync(new URL('../../harmony/entry/src/main/ets/pages/Index.ets', import.meta.url), 'utf8');

  assert.match(index, /this\.nativeBridge\.web\.read\(path\)/);
  assert.doesNotMatch(index, /getRawFileContentSync/);
  // Every downloaded file is checked against its manifest hash.
  assert.match(updaterSource, /sha256Hex\(data\) !== file\.sha256\) \{\s*throw/);
  // A version is assembled in a temp dir and renamed into place.
  assert.match(updaterSource, /fs\.renameSync\(temp, target\)/);
  // Paths from the manifest or the request never escape the bundle directory.
  assert.match(updaterSource, /segment === '\.\.'/);
  assert.match(updaterSource, /if \(!safePath\(path\)\)/);
  // A newer native requirement keeps the current bundle.
  assert.match(updaterSource, /manifest\.nativeApi > NATIVE_API/);
  // A found version waits for the next cold start; nothing reloads a running page.
  assert.doesNotMatch(updaterSource, /\n  apply\(\)/);
  // The first page load waits for a bounded update check on the saved server.
  assert.match(index, /if \(this\.updateChecked\) \{\s*Web\(/);
  assert.match(index, /this\.nativeBridge\.web\.prepare\(\)\.finally/);
  assert.match(updaterSource, /Promise\.race\(\[this\.runUpdate\(this\.state\.server\), timeout\]\)/);
  // A download that misses the wait only becomes ready; it is never activated under a running page.
  assert.match(updaterSource, /if \(this\.checked \|\| this\.state\.ready\.length > 0\)/);
  // A new app package resets the downloads so its own rawfile is served.
  assert.match(updaterSource, /this\.state\.builtin !== builtinVersion/);
});

test('the Windows shell serves only verified, atomically installed bundles', () => {
  const lib = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8');

  // Release builds wrap the embedded assets before the first window exists.
  assert.match(lib, /let context = web_update::wrap\(tauri::generate_context!\(\)\);/);
  assert.match(lib, /\.run\(context\)/);
  assert.match(windowsUpdaterSource, /#\[cfg\(all\(windows, not\(debug_assertions\)\)\)\]\nmod imp/);
  // Every downloaded file is checked against its manifest hash.
  assert.match(windowsUpdaterSource, /if sha256_hex\(&downloaded\) != file\.sha256 \{\s*return Err/);
  // A version is assembled in a temp dir and renamed into place.
  assert.match(windowsUpdaterSource, /fs::rename\(&temp, &target\)/);
  assert.match(windowsUpdaterSource, /segment != "\.\."/);
  assert.match(windowsUpdaterSource, /if !safe_path\(path\) \{\s*return None;/);
  // A frontend without a compatible windowsNativeApi is never applied.
  assert.match(windowsUpdaterSource, /\(1\.\.=NATIVE_API\)\.contains\(&level\)/);
  // The first window waits for a bounded check; a slower download only becomes ready.
  assert.match(windowsUpdaterSource, /finished\.recv_timeout\(UPDATE_WAIT\)/);
  assert.match(windowsUpdaterSource, /const UPDATE_WAIT: Duration = Duration::from_secs\(8\);/);
  // A new installer resets the downloads so its embedded frontend is served.
  assert.match(windowsUpdaterSource, /if state\.builtin != builtin_version/);
});
