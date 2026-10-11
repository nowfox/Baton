import webview from '@ohos.web.webview';
import { common } from '@kit.AbilityKit';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { BusinessError } from '@kit.BasicServicesKit';

// The web frontend is bundled locally under resources/rawfile (run sync-web.sh).
// Start at landing.html: it reads saved key+server from localStorage and, if
// absent, asks the user to scan a QR / paste a Start URL. The server URL and
// API key are NEVER hardcoded in the app — they arrive via that Start URL.
const ENTRY: Resource = $rawfile('landing.html');

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
    // NOTE: startScanForResult / ScanOptions field names follow the installed
    // HarmonyOS SDK (verified against API 24 / 6.1.1). Adjust if DevEco flags a
    // signature mismatch.
    scanBarcode.startScanForResult(this.context, options)
      .then((result: scanBarcode.ScanResult) => {
        const value: string = JSON.stringify(result.originalValue ?? '');
        this.controller?.runJavaScript(
          `window.__onHarmonyScan && window.__onHarmonyScan(${value})`
        );
      })
      .catch((err: BusinessError) => {
        // User cancel also lands here; the frontend treats scan errors as a
        // soft failure and falls back to manual Start URL paste.
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
  @State loading: boolean = true;
  @State failed: boolean = false;

  aboutToAppear(): void {
    this.scanBridge.controller = this.controller;
    this.scanBridge.context = getContext(this);
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
        .domStorageAccess(true)     // localStorage: _ak/_as auth + nav cache
        .javaScriptAccess(true)
        .databaseAccess(true)
        .fileAccess(true)
        .imageAccess(true)
        .onlineImageAccess(true)
        .mixedMode(MixedMode.None)  // local page + HTTPS API only
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
