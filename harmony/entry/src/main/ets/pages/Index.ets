import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { resourceManager } from '@kit.LocalizationKit';

// The web frontend is bundled under resources/rawfile (run sync-web). It is a
// vite build whose scripts are ES modules, which do NOT execute when loaded
// from a bare resource:// origin. So we serve rawfile over a custom standard
// scheme (app://) with correct MIME + CORS, registered in EntryAbility, giving
// the page a real web origin. Server URL + API key still arrive via a scanned
// / pasted Start URL — nothing is hardcoded.
const ENTRY: string = 'app://local/landing.html';

function mimeFor(path: string): string {
  const i: number = path.lastIndexOf('.');
  const ext: string = i >= 0 ? path.substring(i + 1).toLowerCase() : '';
  switch (ext) {
    case 'html':
    case 'htm': return 'text/html';
    case 'js':
    case 'mjs': return 'application/javascript';
    case 'css': return 'text/css';
    case 'json':
    case 'map': return 'application/json';
    case 'svg': return 'image/svg+xml';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'ico': return 'image/x-icon';
    case 'woff2': return 'font/woff2';
    case 'woff': return 'font/woff';
    case 'ttf': return 'font/ttf';
    case 'wasm': return 'application/wasm';
    default: return 'application/octet-stream';
  }
}

function isTextMime(mime: string): boolean {
  return mime.startsWith('text/')
    || mime === 'application/javascript'
    || mime === 'application/json'
    || mime === 'image/svg+xml';
}

// Injected into the webview as window.harmonyScanBridge. The frontend
// (web/js/entry-landing.js) calls scan(); the ScanKit default UI handles the
// camera, permission prompt and cancel, then we hand the decoded string back
// via window.__onHarmonyScan / window.__onHarmonyScanError.
class ScanBridge {
  controller: webview.WebviewController | null = null;
  context: common.Context | null = null;

  scan(): void {
    if (!this.controller || !this.context) {
      return;
    }
    const options: scanBarcode.ScanOptions = {
      scanTypes: [scanCore.ScanType.QR_CODE],
      enableMultiMode: false,
      enableAlbum: true
    };
    scanBarcode.startScanForResult(this.context, options)
      .then((result: scanBarcode.ScanResult) => {
        const value: string = JSON.stringify(result.originalValue ?? '');
        this.controller?.runJavaScript(
          `window.__onHarmonyScan && window.__onHarmonyScan(${value})`
        );
      })
      .catch((err: BusinessError) => {
        const code: string = JSON.stringify(String(err?.code ?? ''));
        this.controller?.runJavaScript(
          `window.__onHarmonyScanError && window.__onHarmonyScanError(${code})`
        );
      });
  }
}

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private scanBridge: ScanBridge = new ScanBridge();
  private schemeHandler: webview.WebSchemeHandler = new webview.WebSchemeHandler();
  private resMgr: resourceManager.ResourceManager | null = null;
  @State loading: boolean = true;
  @State failed: boolean = false;

  aboutToAppear(): void {
    const ctx: common.Context = getContext(this);
    this.scanBridge.controller = this.controller;
    this.scanBridge.context = ctx;
    this.resMgr = ctx.resourceManager;

    // Serve app://local/<path> from resources/rawfile with correct MIME + CORS.
    this.schemeHandler.onRequestStart(
      (request: webview.WebSchemeHandlerRequest, resourceHandler: webview.WebResourceHandler): boolean => {
        let path: string = request.getRequestUrl().replace(/^app:\/\/[^/]*\//, '');
        const q: number = path.indexOf('?');
        if (q >= 0) { path = path.substring(0, q); }
        const h: number = path.indexOf('#');
        if (h >= 0) { path = path.substring(0, h); }
        if (path.length === 0) { path = 'landing.html'; }
        path = decodeURIComponent(path);

        const resp: webview.WebSchemeHandlerResponse = new webview.WebSchemeHandlerResponse();
        resp.setHeaderByName('Access-Control-Allow-Origin', '*', false);
        try {
          const data: Uint8Array = this.resMgr!.getRawFileContentSync(path);
          const mime: string = mimeFor(path);
          resp.setStatus(200);
          resp.setStatusText('OK');
          resp.setMimeType(mime);
          if (isTextMime(mime)) { resp.setEncoding('utf-8'); }
          resourceHandler.didReceiveResponse(resp);
          resourceHandler.didReceiveResponseBody(data.buffer as ArrayBuffer);
          resourceHandler.didFinish();
        } catch (e) {
          resp.setStatus(404);
          resp.setStatusText('Not Found');
          resp.setMimeType('text/plain');
          resourceHandler.didReceiveResponse(resp);
          resourceHandler.didFinish();
        }
        return true;
      }
    );
  }

  // Back key: navigate web history first, exit the app only at the first page.
  onBackPress(): boolean {
    if (this.controller.accessBackward()) {
      this.controller.backward();
      return true;
    }
    return false;
  }

  build() {
    Stack() {
      Web({ src: ENTRY, controller: this.controller })
        .onControllerAttached(() => {
          // Remote DevTools (PC chrome://inspect over hdc). Disable for release.
          webview.WebviewController.setWebDebuggingAccess(true);
          // Must be registered before the first app:// request is served.
          this.controller.setWebSchemeHandler('app', this.schemeHandler);
        })
        .domStorageAccess(true)     // localStorage: _ak/_as auth + nav cache
        .javaScriptAccess(true)
        .databaseAccess(true)
        .fileAccess(true)
        .imageAccess(true)
        .onlineImageAccess(true)
        .mixedMode(MixedMode.None)
        .javaScriptProxy({
          object: this.scanBridge,
          name: 'harmonyScanBridge',
          methodList: ['scan'],
          controller: this.controller
        })
        .width('100%')
        .height('100%')
        .onPageBegin(() => { this.loading = true; this.failed = false; })
        .onPageEnd(() => { this.loading = false; })
        .onErrorReceive((e) => {
          if (e && e.request && e.request.isMainFrame()) {
            this.loading = false;
            this.failed = true;
          }
        })

      if (this.loading && !this.failed) {
        LoadingProgress().width(48).height(48)
      }

      if (this.failed) {
        Column({ space: 12 }) {
          Text($r('app.string.load_failed'))
          Button($r('app.string.retry')).onClick(() => {
            this.failed = false;
            this.loading = true;
            this.controller.loadUrl(ENTRY);
          })
        }
      }
    }
    .width('100%')
    .height('100%')
  }
}
