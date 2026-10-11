import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    // Register the app:// scheme BEFORE any Web component initializes the kernel.
    // Standard + CORS + fetch + secure → a real web origin so ES module scripts
    // execute and cross-origin fetch to the HTTPS API is allowed.
    try {
      webview.WebviewController.customizeSchemes([
        {
          schemeName: 'app',
          isStandard: true,
          isSupportCORS: true,
          isSupportFetch: true,
          isSecure: true
        }
      ]);
    } catch (e) {
      console.error(`customizeSchemes failed: ${JSON.stringify(e)}`);
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        console.error(`loadContent failed: ${JSON.stringify(err)}`);
      }
    });
  }
}
