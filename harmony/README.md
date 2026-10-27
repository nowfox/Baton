# Baton for HarmonyOS NEXT

**English** | [中文](README.zh-CN.md)

An ArkWeb shell around the same `web/` frontend as the Tauri apps. No server
address or API key is built in: sign in by scanning the setup-page QR code or
pasting the Start URL.

AppGallery builds are not available yet, so build and install it on your own
device.

## Build and install

Requirements: Node.js 20+, DevEco Studio with the HarmonyOS SDK, a Huawei ID,
and a HarmonyOS NEXT phone or tablet.

1. Bundle the web frontend (rerun after every frontend update):

   ```bash
   bash harmony/sync-web.sh                                       # macOS / Linux
   powershell -ExecutionPolicy Bypass -File harmony\sync-web.ps1  # Windows
   ```

2. Open the `harmony/` folder in DevEco Studio.
3. File → Project Structure → Signing Configs → **Automatically generate
   signature**, and sign in with your Huawei ID. Do not commit the generated
   signing config (`git checkout harmony/build-profile.json5`).
4. On the device, enable Developer options and USB debugging, then connect it.
5. Click **Run**.

If automatic signing rejects the bundle name, change `bundleName` in
`AppScope/app.json5` to any unique value for your local build.

## How it differs from the Tauri apps

- Pages load from `app://local/`, a registered secure scheme served from
  `rawfile/`, so ES modules execute.
- Scan, download/save, Remote preview and external links go through one
  injected `window.harmonyBridge` (`entry/src/main/ets/bridge/NativeBridge.ets`).
- One download or save runs at a time; a second one fails until it finishes.
- Remote preview has no TCP half-close, so a remote FIN closes the connection,
  and the local port may differ from the remote port.
- `MixedMode.All` lets the `http://127.0.0.1` preview iframe load inside the
  `app://` page.

## Web updates

After installing, the shell can update its frontend without a new package:
on a cold start it fetches `<server>/web-manifest.json`, downloads changed
files (SHA-256 checked) and serves them from that launch, waiting up to 8 s.
A version that does not report ready within 15 s is rolled back. Bump
`NATIVE_API` in `WebUpdater.ets` together with `HARMONY_NATIVE_API` in
`vite.config.js` whenever the frontend needs native code older shells lack;
they then keep their bundled frontend.
