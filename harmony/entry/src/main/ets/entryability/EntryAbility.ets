import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    // Remote DevTools (PC chrome://inspect over hdc). Must be set BEFORE the
    // ArkWeb kernel initializes, so it lives here rather than onControllerAttached
    // (where the kernel is already up and the switch no-ops). Disable for release.
    try {
      webview.WebviewController.setWebDebuggingAccess(true);
    } catch (e) {
      console.error(`setWebDebuggingAccess failed: ${JSON.stringify(e)}`);
    }

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
    // Paint the status/navigation bars in the brand dark so they don't show as
    // white strips above/below the dark web content; use light bar icons.
    try {
      const win = windowStage.getMainWindowSync();
      win.setWindowSystemBarProperties({
        statusBarColor: '#0D1117',
        statusBarContentColor: '#FFFFFF',
        navigationBarColor: '#0D1117',
        navigationBarContentColor: '#FFFFFF'
      });
      // The gesture-navigation inset at the bottom shows the window background,
      // not the navigation bar — paint it dark so no white strip remains.
      win.setWindowBackgroundColor('#0D1117');
    } catch (e) {
      console.error(`setWindowSystemBarProperties failed: ${JSON.stringify(e)}`);
    }
  }
}
