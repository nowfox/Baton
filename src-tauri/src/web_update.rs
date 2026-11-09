// Windows release builds update the bundled web frontend without a new
// installer, the same scheme as harmony/.../bridge/WebUpdater.ets: the server
// publishes web-manifest.json (vite.config.js) next to the files it hosts; a
// newer version is assembled under %LOCALAPPDATA%\<identifier>\web-update —
// unchanged files copied locally, the rest downloaded and checked against their
// SHA-256 — and served in place of the embedded assets.
//
// The page reports its signed-in server through web_update_check; the next cold
// start checks it before the first window is created and waits up to
// UPDATE_WAIT, so an update takes effect on that launch. A slower download
// finishes in the background and is served from the following cold start.
// The active version is fixed for the process, so lazy chunks always match the
// page. A version that never calls web_update_ready within READY_TIMEOUT is
// marked bad and the previous one restored. A new installer discards every
// download, so its embedded frontend wins.

#[cfg(all(windows, not(debug_assertions)))]
pub use imp::{attach, wrap};

#[cfg(not(all(windows, not(debug_assertions))))]
pub fn wrap(context: tauri::Context<tauri::Wry>) -> tauri::Context<tauri::Wry> {
  context
}

#[cfg(not(all(windows, not(debug_assertions))))]
pub fn attach(_app: &tauri::AppHandle) {}

#[tauri::command]
pub fn web_update_ready() {
  #[cfg(all(windows, not(debug_assertions)))]
  {
    if let Some(updater) = imp::UPDATER.get() {
      updater.ready();
    }
  }
}

#[tauri::command]
pub fn web_update_check(server: String) {
  #[cfg(all(windows, not(debug_assertions)))]
  {
    if let Some(updater) = imp::UPDATER.get() {
      updater.check(&server);
    }
  }
  let _ = server;
}

#[cfg(all(windows, not(debug_assertions)))]
mod imp {
  use std::borrow::Cow;
  use std::collections::{HashMap, HashSet};
  use std::fs;
  use std::io::Read;
  use std::path::{Path, PathBuf};
  use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
  use std::sync::{mpsc, Arc, Mutex, OnceLock, RwLock};
  use std::thread;
  use std::time::{Duration, SystemTime, UNIX_EPOCH};

  use serde::{Deserialize, Serialize};
  use reqwest::blocking::Client;
  use sha2::{Digest, Sha256};
  use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
  use tauri::{App, AppHandle, Assets, Context, Manager, Wry};

  // Bump together with WINDOWS_NATIVE_API in vite.config.js whenever the
  // frontend starts relying on native code older shells lack.
  pub const NATIVE_API: u32 = 1;

  const MANIFEST: &str = "web-manifest.json";
  const STATE: &str = "state.json";
  const READY_TIMEOUT: Duration = Duration::from_secs(15);
  const UPDATE_WAIT: Duration = Duration::from_secs(8);
  const PARALLEL: usize = 4;
  const MAX_BAD: usize = 20;
  const MAX_FILE: u64 = 64 * 1024 * 1024;

  pub static UPDATER: OnceLock<Arc<Updater>> = OnceLock::new();

  #[derive(Clone, Deserialize)]
  struct ManifestFile {
    path: String,
    sha256: String,
  }

  #[derive(Clone, Deserialize)]
  struct Manifest {
    version: String,
    #[serde(rename = "windowsNativeApi")]
    windows_native_api: Option<u32>,
    files: Vec<ManifestFile>,
  }

  #[derive(Default, Deserialize, Serialize)]
  #[serde(default)]
  struct State {
    server: String,   // signed-in server, reported by the page
    builtin: String,  // embedded version these downloads were made against
    current: String,  // downloaded version being served; "" = embedded
    previous: String,
    ready: String,    // downloaded, not applied yet
    trial: String,    // applied, waiting for web_update_ready
    bad: Vec<String>,
  }

  struct Active {
    dir: Option<PathBuf>,
    manifest: Option<Manifest>,
  }

  fn is_version(v: &str) -> bool {
    v.len() == 16 && v.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
  }

  fn safe_path(path: &str) -> bool {
    !path.is_empty()
      && path.split('/').all(|segment| {
        !segment.is_empty()
          && segment != "."
          && segment != ".."
          && segment.bytes().all(|b| b.is_ascii_alphanumeric() || b"._@~+-".contains(&b))
      })
  }

  // https, a host, and no user:password — the same rule as the Harmony shell.
  fn is_https(url: &str) -> bool {
    url.strip_prefix("https://").map_or(false, |rest| {
      let host = rest.split(['/', '?', '#']).next().unwrap_or("");
      !host.is_empty() && !host.contains('@')
    })
  }

  fn parse_manifest(data: &[u8]) -> Option<Manifest> {
    let manifest: Manifest = serde_json::from_slice(data).ok()?;
    let valid = is_version(&manifest.version)
      && manifest.files.iter().all(|f| {
        safe_path(&f.path) && f.sha256.len() == 64 && f.sha256.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
      });
    valid.then_some(manifest)
  }

  fn sha256_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
  }

  fn remove(path: &Path) {
    let result = if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) };
    if let Err(e) = result {
      if e.kind() != std::io::ErrorKind::NotFound {
        log::warn!("web update: cannot remove {}: {e}", path.display());
      }
    }
  }

  fn client() -> Result<Client, String> {
    Client::builder()
      .connect_timeout(Duration::from_secs(15))
      .timeout(Duration::from_secs(120))
      .build()
      .map_err(|e| e.to_string())
  }

  fn fetch(client: &Client, url: &str) -> Result<Vec<u8>, String> {
    // Bytes are hashed exactly as received, so ask for them uncompressed.
    let response = client
      .get(url)
      .header("Accept-Encoding", "identity")
      .header("Cache-Control", "no-cache")
      .send()
      .map_err(|e| format!("{url}: {e}"))?;
    if response.status().as_u16() != 200 {
      return Err(format!("HTTP {}: {url}", response.status()));
    }
    let mut data = Vec::new();
    response.take(MAX_FILE).read_to_end(&mut data).map_err(|e| format!("{url}: {e}"))?;
    Ok(data)
  }

  pub struct Updater {
    root: PathBuf,
    embedded: Box<dyn Assets<Wry>>,
    builtin: Option<Manifest>,
    state: Mutex<State>,
    active: RwLock<Active>,
    checked: AtomicBool,
    ready_generation: AtomicU64,
    app: OnceLock<AppHandle>,
  }

  impl Updater {
    fn new(embedded: Box<dyn Assets<Wry>>, root: PathBuf) -> Self {
      let builtin = embedded.get(&AssetKey::from(MANIFEST)).and_then(|data| parse_manifest(&data));
      let updater = Updater {
        root,
        embedded,
        active: RwLock::new(Active { dir: None, manifest: builtin.clone() }),
        builtin,
        state: Mutex::new(State::default()),
        checked: AtomicBool::new(false),
        ready_generation: AtomicU64::new(0),
        app: OnceLock::new(),
      };
      if let Err(e) = updater.init() {
        log::warn!("web update init failed: {e}");
        *updater.active.write().unwrap() = Active { dir: None, manifest: updater.builtin.clone() };
        *updater.state.lock().unwrap() = State::default();
      }
      updater
    }

    fn init(&self) -> std::io::Result<()> {
      fs::create_dir_all(&self.root)?;
      let builtin_version = self.builtin.as_ref().map(|m| m.version.clone()).unwrap_or_default();
      let mut state = self.load_state();
      if state.builtin != builtin_version {
        state = State { server: state.server, builtin: builtin_version, ..State::default() };
      }
      if !state.ready.is_empty() {
        if state.ready == state.current {
          state.ready.clear();
        } else {
          let ready = state.ready.clone();
          promote(&mut state, &ready);
        }
      }
      if !state.previous.is_empty() && self.read_manifest(&state.previous).is_none() {
        state.previous.clear();
      }
      self.activate(&mut state);
      self.save(&state);
      self.prune(&state);
      *self.state.lock().unwrap() = state;
      Ok(())
    }

    // Serves one asset of the active version; None when it is not part of it.
    fn asset(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
      let dir = self.active.read().unwrap().dir.clone();
      match dir {
        None => self.embedded.get(key),
        Some(dir) => {
          let path = key.as_ref().trim_start_matches('/');
          if !safe_path(path) {
            return None;
          }
          fs::read(dir.join(path)).ok().map(Cow::Owned)
        }
      }
    }

    // Runs before the first window exists. An update that finishes in time is
    // activated; anything slower continues in the background and only becomes
    // ready for the next cold start.
    fn prepare(self: &Arc<Self>) {
      let server = {
        let state = self.state.lock().unwrap();
        (!state.server.is_empty() && state.ready.is_empty()).then(|| state.server.clone())
      };
      let Some(server) = server else { return };
      self.checked.store(true, Ordering::SeqCst);
      let (done, finished) = mpsc::channel();
      let updater = self.clone();
      thread::spawn(move || {
        updater.run_update(&server);
        let _ = done.send(());
      });
      let _ = finished.recv_timeout(UPDATE_WAIT);
      let mut state = self.state.lock().unwrap();
      if !state.ready.is_empty() {
        let ready = state.ready.clone();
        promote(&mut state, &ready);
        self.activate(&mut state);
        self.save(&state);
      }
    }

    fn attach(&self, app: &AppHandle) {
      let _ = self.app.set(app.clone());
      if !self.state.lock().unwrap().trial.is_empty() {
        self.arm_ready_timer();
      }
    }

    pub fn ready(&self) {
      self.ready_generation.fetch_add(1, Ordering::SeqCst);
      let mut state = self.state.lock().unwrap();
      if !state.trial.is_empty() && state.trial == state.current {
        state.trial.clear();
        self.save(&state);
      }
    }

    // Called by every page: remembers the server for the next prepare(), and
    // checks it in the background when this launch had none to check before.
    pub fn check(self: &Arc<Self>, server: &str) {
      let server = server.trim_end_matches('/');
      if !is_https(server) {
        return;
      }
      {
        let mut state = self.state.lock().unwrap();
        if state.server != server {
          state.server = server.to_string();
          self.save(&state);
        }
        if !state.ready.is_empty() {
          return;
        }
      }
      if self.checked.swap(true, Ordering::SeqCst) {
        return;
      }
      let updater = self.clone();
      let server = server.to_string();
      thread::spawn(move || updater.run_update(&server));
    }

    fn run_update(&self, server: &str) {
      if let Err(e) = self.update(server) {
        log::warn!("web update failed: {e}");
      }
    }

    fn update(&self, server: &str) -> Result<(), String> {
      let client = client()?;
      let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
      let raw = fetch(&client, &format!("{server}/{MANIFEST}?ts={ts}"))?;
      let Some(manifest) = parse_manifest(&raw) else { return Ok(()) };
      // A frontend without the field predates this shell and never reports ready.
      if !manifest.windows_native_api.map_or(false, |level| (1..=NATIVE_API).contains(&level)) {
        return Ok(());
      }
      let active_version = self.active.read().unwrap().manifest.as_ref().map(|m| m.version.clone()).unwrap_or_default();
      let previous = {
        let state = self.state.lock().unwrap();
        if manifest.version == active_version || state.bad.contains(&manifest.version) {
          return Ok(());
        }
        state.previous.clone()
      };
      if manifest.version != previous || self.read_manifest(&manifest.version).is_none() {
        self.assemble(&client, server, &manifest, &raw)?;
      }
      let mut state = self.state.lock().unwrap();
      state.ready = manifest.version;
      self.save(&state);
      Ok(())
    }

    // Builds the version in a temp dir and renames it into place only when
    // every file matched its hash, so a half-written version is never served.
    fn assemble(&self, client: &Client, server: &str, manifest: &Manifest, raw: &[u8]) -> Result<(), String> {
      let temp = self.root.join(format!("tmp-{}", manifest.version));
      remove(&temp);
      fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
      // (path, sha256) -> directory holding that exact file; None = embedded.
      let mut local: HashMap<(String, String), Option<PathBuf>> = HashMap::new();
      {
        let active = self.active.read().unwrap();
        for (source, dir) in [(active.manifest.as_ref(), active.dir.clone()), (self.builtin.as_ref(), None)] {
          for file in source.map(|m| m.files.as_slice()).unwrap_or(&[]) {
            local.entry((file.path.clone(), file.sha256.clone())).or_insert_with(|| dir.clone());
          }
        }
      }
      let next = AtomicUsize::new(0);
      let failure: Mutex<Option<String>> = Mutex::new(None);
      thread::scope(|scope| {
        for _ in 0..PARALLEL {
          scope.spawn(|| loop {
            if failure.lock().unwrap().is_some() {
              break;
            }
            let Some(file) = manifest.files.get(next.fetch_add(1, Ordering::SeqCst)) else { break };
            if let Err(e) = self.place(client, server, file, &local, &temp) {
              failure.lock().unwrap().get_or_insert(e);
              break;
            }
          });
        }
      });
      let result = match failure.into_inner().unwrap() {
        Some(e) => Err(e),
        None => fs::write(temp.join(MANIFEST), raw)
          .and_then(|_| {
            let target = self.dir_of(&manifest.version);
            remove(&target);
            fs::rename(&temp, &target)
          })
          .map_err(|e| e.to_string()),
      };
      if result.is_err() {
        remove(&temp);
      }
      result
    }

    fn place(
      &self,
      client: &Client,
      server: &str,
      file: &ManifestFile,
      local: &HashMap<(String, String), Option<PathBuf>>,
      temp: &Path,
    ) -> Result<(), String> {
      let mut data = match local.get(&(file.path.clone(), file.sha256.clone())) {
        Some(Some(dir)) => fs::read(dir.join(&file.path)).ok(),
        Some(None) => self.embedded.get(&AssetKey::from(file.path.as_str())).map(Cow::into_owned),
        None => None,
      };
      if data.as_deref().map_or(true, |d| sha256_hex(d) != file.sha256) {
        // safe_path() admits only characters that need no URL encoding.
        let downloaded = fetch(client, &format!("{server}/{}", file.path))?;
        if sha256_hex(&downloaded) != file.sha256 {
          return Err(format!("hash mismatch: {}", file.path));
        }
        data = Some(downloaded);
      }
      let target = temp.join(&file.path);
      if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
      }
      fs::write(&target, data.unwrap_or_default()).map_err(|e| format!("{}: {e}", file.path))
    }

    fn activate(&self, state: &mut State) {
      let manifest = if state.current.is_empty() { None } else { self.read_manifest(&state.current) };
      let mut active = self.active.write().unwrap();
      match manifest {
        None => {
          state.current.clear();
          state.trial.clear();
          *active = Active { dir: None, manifest: self.builtin.clone() };
        }
        Some(manifest) => *active = Active { dir: Some(self.dir_of(&state.current)), manifest: Some(manifest) },
      }
    }

    fn rollback(&self) {
      let failed = {
        let mut state = self.state.lock().unwrap();
        let failed = state.trial.clone();
        if failed.is_empty() || failed != state.current {
          return;
        }
        log::warn!("web update: {failed} did not boot, rolling back");
        state.bad.retain(|v| v != &failed);
        state.bad.push(failed.clone());
        let excess = state.bad.len().saturating_sub(MAX_BAD);
        state.bad = state.bad.split_off(excess);
        state.current = std::mem::take(&mut state.previous);
        state.trial.clear();
        self.activate(&mut state);
        self.save(&state);
        failed
      };
      remove(&self.dir_of(&failed));
      if let Some(app) = self.app.get() {
        for window in app.webview_windows().values() {
          if let Ok(url) = window.url() {
            let _ = window.navigate(url);
          }
        }
      }
    }

    fn arm_ready_timer(&self) {
      let generation = self.ready_generation.fetch_add(1, Ordering::SeqCst) + 1;
      thread::spawn(move || {
        thread::sleep(READY_TIMEOUT);
        if let Some(updater) = UPDATER.get() {
          if updater.ready_generation.load(Ordering::SeqCst) == generation {
            updater.rollback();
          }
        }
      });
    }

    fn dir_of(&self, version: &str) -> PathBuf {
      self.root.join(format!("v-{version}"))
    }

    fn read_manifest(&self, version: &str) -> Option<Manifest> {
      let data = fs::read(self.dir_of(version).join(MANIFEST)).ok()?;
      parse_manifest(&data).filter(|m| m.version == version)
    }

    fn load_state(&self) -> State {
      // First launch, or an unreadable file: start from the embedded frontend.
      let Ok(data) = fs::read(self.root.join(STATE)) else { return State::default() };
      let Ok(saved) = serde_json::from_slice::<State>(&data) else { return State::default() };
      let pick = |v: String| if is_version(&v) { v } else { String::new() };
      State {
        server: if is_https(&saved.server) { saved.server } else { String::new() },
        builtin: saved.builtin,
        current: pick(saved.current),
        previous: pick(saved.previous),
        ready: pick(saved.ready),
        trial: pick(saved.trial),
        bad: saved.bad.into_iter().filter(|v| is_version(v)).collect(),
      }
    }

    fn save(&self, state: &State) {
      let temp = self.root.join(format!("{STATE}.tmp"));
      let result = serde_json::to_vec(state)
        .map_err(std::io::Error::other)
        .and_then(|data| fs::write(&temp, data))
        .and_then(|_| fs::rename(&temp, self.root.join(STATE)));
      if let Err(e) = result {
        log::warn!("web update: cannot save state: {e}");
      }
    }

    // Keeps only the versions the state still points at.
    fn prune(&self, state: &State) {
      let mut keep: HashSet<String> = HashSet::from([STATE.to_string()]);
      for version in [&state.current, &state.previous, &state.ready] {
        if !version.is_empty() {
          keep.insert(format!("v-{version}"));
        }
      }
      let Ok(entries) = fs::read_dir(&self.root) else { return };
      for entry in entries.flatten() {
        if !keep.contains(entry.file_name().to_string_lossy().as_ref()) {
          remove(&entry.path());
        }
      }
    }
  }

  fn promote(state: &mut State, version: &str) {
    state.previous = std::mem::take(&mut state.current);
    state.current = version.to_string();
    state.ready.clear();
    state.trial = version.to_string();
  }

  struct WebAssets(Arc<Updater>);

  impl Assets<Wry> for WebAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
      self.0.asset(key)
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
      self.0.embedded.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
      self.0.embedded.csp_hashes(html_path)
    }

    fn setup(&self, app: &App<Wry>) {
      self.0.embedded.setup(app);
    }
  }

  struct NoAssets;

  impl Assets<Wry> for NoAssets {
    fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
      None
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
      Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
      Box::new(std::iter::empty())
    }
  }

  pub fn wrap(mut context: Context<Wry>) -> Context<Wry> {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else { return context };
    let root = PathBuf::from(local).join(&context.config().identifier).join("web-update");
    let embedded = context.set_assets(Box::new(NoAssets));
    let updater = Arc::new(Updater::new(embedded, root));
    updater.prepare();
    let _ = UPDATER.set(updater.clone());
    context.set_assets(Box::new(WebAssets(updater)));
    context
  }

  pub fn attach(app: &AppHandle) {
    if let Some(updater) = UPDATER.get() {
      updater.attach(app);
    }
  }
}
