import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { DownloadBridge } from './DownloadBridge';
import { JsChannel } from './JsChannel';
import { OpenBridge } from './OpenBridge';
import { PreviewBridge } from './PreviewBridge';
import { ScanBridge } from './ScanBridge';
import { WebUpdater } from './WebUpdater';

// Injected as window.harmonyBridge. Every method takes one JSON argument; calls
// with an id are answered through JsChannel (web/js/harmony.js on the page side).
export class NativeBridge {
  readonly channel: JsChannel = new JsChannel();
  readonly scanner: ScanBridge = new ScanBridge();
  readonly downloads: DownloadBridge = new DownloadBridge();
  readonly preview: PreviewBridge = new PreviewBridge();
  readonly links: OpenBridge = new OpenBridge();
  readonly web: WebUpdater = new WebUpdater();

  static readonly METHODS: string[] = [
    'scan', 'download', 'save', 'openExternal', 'previewStart', 'previewStop',
    'previewReset', 'previewWrite', 'previewShutdownWrite', 'previewCredit',
    'previewCloseSocket', 'webReady', 'webUpdateCheck'
  ];

  attach(controller: webview.WebviewController, context: common.Context): void {
    this.channel.controller = controller;
    this.scanner.channel = this.channel;
    this.scanner.context = context;
    this.downloads.channel = this.channel;
    this.downloads.context = context;
    this.preview.channel = this.channel;
    this.links.channel = this.channel;
    this.links.context = context as common.UIAbilityContext;
    this.web.init(context, controller);
  }

  release(): void {
    this.channel.controller = null;
    this.downloads.release();
    this.preview.release();
    this.web.release();
  }

  scan(argsJson: string): void {
    this.scanner.scan(argsJson);
  }

  download(argsJson: string): void {
    this.downloads.download(argsJson);
  }

  save(argsJson: string): void {
    this.downloads.save(argsJson);
  }

  openExternal(argsJson: string): void {
    this.links.open(argsJson);
  }

  previewStart(argsJson: string): void {
    this.preview.start(argsJson);
  }

  previewStop(argsJson: string): void {
    this.preview.stop(argsJson);
  }

  previewReset(argsJson: string): void {
    this.preview.reset(argsJson);
  }

  previewWrite(argsJson: string): void {
    this.preview.write(argsJson);
  }

  previewShutdownWrite(argsJson: string): void {
    this.preview.shutdownWrite(argsJson);
  }

  previewCredit(argsJson: string): void {
    this.preview.credit(argsJson);
  }

  previewCloseSocket(argsJson: string): void {
    this.preview.closeSocket(argsJson);
  }

  webReady(): void {
    this.web.ready();
  }

  webUpdateCheck(argsJson: string): void {
    this.web.check(argsJson);
  }
}
