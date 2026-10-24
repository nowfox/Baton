package com.batonai.app

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
    )
    super.onCreate(savedInstanceState)
  }

  // System Back reaches JS through Tauri's onBackButtonPress; this lets the root page background the app.
  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun moveTaskToBack() { runOnUiThread { moveTaskToBack(true) } }
    }, "BatonAndroid")
  }
}
