(function () {
  var ua = navigator.userAgent || '';
  var platform = navigator.platform || '';
  var isiPadDesktopMode = platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  var isMobileOS = /Android|iPhone|iPad|iPod/i.test(ua) || isiPadDesktopMode;
  // The HarmonyOS shell serves its pages from app://; its system browser shares the UA.
  var isHarmonyShell = /^app:/.test((window.location && window.location.protocol) || '');
  var isNativeMobile = (!!window.__TAURI_INTERNALS__ && isMobileOS) || isHarmonyShell;

  document.documentElement.classList.toggle('native-mobile', isNativeMobile);
  window.__BATON_NATIVE_MOBILE__ = isNativeMobile;
})();
