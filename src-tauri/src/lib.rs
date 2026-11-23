// Kesit — Tauri arka ucu.
// Bilerek küçük ve genel tutuldu: ffmpeg çalıştırma (ilerleme, iptal), dosya işlemleri, pencereler,
// Geri Dönüşüm Kutusu, tek örnek ve sağ tık menüsü. Kesim planı gibi asıl mantık ön yüzde (ffcore.js).

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

const VIDEO_EXT: &[&str] = &[
    "mp4", "mov", "m4v", "mkv", "webm", "avi", "mts", "m2ts", "ts", "3gp", "wmv", "flv", "mpg", "mpeg",
];

struct AppState {
    jobs: Mutex<HashMap<u32, Arc<Mutex<Child>>>>,
    killed: Mutex<HashSet<u32>>,
    initial_file: Mutex<Option<String>>,
    temp_root: PathBuf,
    temp_seq: AtomicU32,
    ffmpeg: PathBuf,
}

/// Windows'ta konsol penceresi açmadan süreç başlatır.
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

fn spawn_err(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        "ffmpeg bulunamadı. Uygulama klasöründeki dosyalar eksik olabilir.".into()
    } else {
        e.to_string()
    }
}

fn tail(s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_string()
}

fn resolve_ffmpeg(app: &AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("KESIT_FFMPEG") {
        return PathBuf::from(p);
    }
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let mut dirs = Vec::new();
    if let Ok(d) = app.path().resource_dir() {
        dirs.push(d);
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        dirs.push(d);
    }
    for d in dirs {
        let p = d.join(exe);
        if p.is_file() {
            return p;
        }
    }
    PathBuf::from(exe) // PATH üzerinden
}

fn file_from_args(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .find(|a| Path::new(a).is_file())
        .map(|a| std::fs::canonicalize(a).map(|p| simplify(&p)).unwrap_or_else(|_| a.clone()))
}

/// Windows'ta canonicalize'ın eklediği \\?\ önekini kaldırır.
fn simplify(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

// ---------------- ffmpeg ----------------

#[derive(Serialize)]
struct RunResult {
    code: i32,
    stderr: String,
    killed: bool,
}

/// ffmpeg'i çalıştırır; `-progress pipe:1` çıktısındaki süreyi (mikrosaniye) kanala yollar.
#[tauri::command]
async fn ff_run(
    state: State<'_, AppState>,
    args: Vec<String>,
    job: u32,
    on_progress: Channel<u64>,
) -> Result<RunResult, String> {
    let mut child = hidden_command(&state.ffmpeg)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_err)?;
    let stdout = child.stdout.take().ok_or("stdout yok")?;
    let stderr = child.stderr.take().ok_or("stderr yok")?;
    let child = Arc::new(Mutex::new(child));
    state.jobs.lock().unwrap().insert(job, child.clone());

    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut buf);
        tail(String::from_utf8_lossy(&buf).to_string(), 20000)
    });
    let out_thread = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let v = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms="));
            if let Some(n) = v.and_then(|v| v.trim().parse::<u64>().ok()) {
                let _ = on_progress.send(n);
            }
        }
    });

    let waiter = child.clone();
    let (code, stderr) = tauri::async_runtime::spawn_blocking(move || {
        let status = loop {
            if let Ok(Some(st)) = waiter.lock().unwrap().try_wait() {
                break st;
            }
            std::thread::sleep(Duration::from_millis(40));
        };
        let _ = out_thread.join();
        let stderr = err_thread.join().unwrap_or_default();
        (status.code().unwrap_or(-1), stderr)
    })
    .await
    .map_err(|e| e.to_string())?;

    state.jobs.lock().unwrap().remove(&job);
    let killed = state.killed.lock().unwrap().remove(&job);
    Ok(RunResult { code, stderr, killed })
}

#[tauri::command]
fn ff_kill(state: State<'_, AppState>, job: u32) {
    let child = state.jobs.lock().unwrap().get(&job).cloned();
    if let Some(c) = child {
        state.killed.lock().unwrap().insert(job);
        let _ = c.lock().unwrap().kill();
    }
}

#[derive(Serialize)]
struct CaptureResult {
    code: i32,
    stdout: String,
    stderr: String,
}

/// ffmpeg'i çalıştırıp çıktısını toplar (bilgi okuma, küçük resimler). `binary` ise stdout base64 döner.
#[tauri::command]
async fn ff_capture(
    state: State<'_, AppState>,
    args: Vec<String>,
    binary: bool,
    timeout_ms: Option<u64>,
) -> Result<CaptureResult, String> {
    let ffmpeg = state.ffmpeg.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = hidden_command(&ffmpeg)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(spawn_err)?;
        let mut so = child.stdout.take().ok_or("stdout yok")?;
        let mut se = child.stderr.take().ok_or("stderr yok")?;
        let t1 = std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = so.read_to_end(&mut b);
            b
        });
        let t2 = std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = se.read_to_end(&mut b);
            b
        });
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.unwrap_or(30000));
        let status = loop {
            if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
                break Some(s);
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            std::thread::sleep(Duration::from_millis(15));
        };
        let out = t1.join().unwrap_or_default();
        let err = t2.join().unwrap_or_default();
        Ok(CaptureResult {
            code: status.and_then(|s| s.code()).unwrap_or(-1),
            stdout: if binary {
                base64::engine::general_purpose::STANDARD.encode(&out)
            } else {
                String::from_utf8_lossy(&out).to_string()
            },
            stderr: tail(String::from_utf8_lossy(&err).to_string(), 40000),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------- Dosyalar ----------------

#[derive(Serialize)]
struct Stat {
    size: u64,
    is_file: bool,
}

#[tauri::command]
fn fs_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn fs_stat(path: String) -> Option<Stat> {
    std::fs::metadata(&path).ok().map(|m| Stat { size: m.len(), is_file: m.is_file() })
}

#[tauri::command]
fn fs_write_base64(path: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_write_text(path: String, text: String) -> Result<(), String> {
    std::fs::write(&path, text.as_bytes()).map_err(|e| e.to_string())
}

/// Windows'ta hedef varsa üzerine yazar (MoveFileEx, REPLACE_EXISTING).
#[tauri::command]
fn fs_rename(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_remove(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
fn fs_remove_dir(path: String) -> Result<(), String> {
    match std::fs::remove_dir_all(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
fn fs_mkdtemp(state: State<'_, AppState>, prefix: String) -> Result<String, String> {
    let n = state.temp_seq.fetch_add(1, Ordering::SeqCst);
    let p = state.temp_root.join(format!("{prefix}{n}"));
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn temp_root(state: State<'_, AppState>) -> String {
    state.temp_root.to_string_lossy().to_string()
}

#[tauri::command]
fn trash_item(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_hidden(path: String, hidden: bool) {
    #[cfg(windows)]
    {
        let flag = if hidden { "+h" } else { "-h" };
        let _ = hidden_command("attrib").args([flag, path.as_str()]).status();
    }
    #[cfg(not(windows))]
    let _ = (path, hidden);
}

#[tauri::command]
fn reveal(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

// ---------------- Pencereler ----------------

#[tauri::command]
fn initial_file(state: State<'_, AppState>) -> Option<String> {
    state.initial_file.lock().unwrap().take()
}

#[tauri::command]
async fn pick_video(app: AppHandle) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = app
            .dialog()
            .file()
            .set_title("Video aç")
            .add_filter("Videolar", VIDEO_EXT)
            .add_filter("Tüm dosyalar", &["*"]);
        if let Some(w) = app.get_webview_window("main") {
            d = d.set_parent(&w);
        }
        d.blocking_pick_file()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn pick_image(app: AppHandle) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = app
            .dialog()
            .file()
            .set_title("Görsel ekle")
            .add_filter("Görseller", &["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
        if let Some(w) = app.get_webview_window("main") {
            d = d.set_parent(&w);
        }
        d.blocking_pick_file()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn pick_save(app: AppHandle, title: String, default_path: String, filter_name: String, ext: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&default_path);
        let ext = ext.trim_start_matches('.').to_string();
        let mut d = app.dialog().file().set_title(&title).add_filter(&filter_name, &[ext.as_str()]);
        if let Some(dir) = p.parent() {
            d = d.set_directory(dir);
        }
        if let Some(name) = p.file_name() {
            d = d.set_file_name(name.to_string_lossy());
        }
        if let Some(w) = app.get_webview_window("main") {
            d = d.set_parent(&w);
        }
        d.blocking_save_file()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

// ---------------- Ayarlar ----------------

fn settings_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("kesit"))
        .join("ayarlar.json")
}

#[tauri::command]
fn get_settings(app: AppHandle) -> serde_json::Value {
    std::fs::read_to_string(settings_path(&app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

#[tauri::command]
fn set_settings(app: AppHandle, value: serde_json::Value) -> Result<(), String> {
    let p = settings_path(&app);
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    std::fs::write(p, value.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_zoom(window: tauri::WebviewWindow, zoom: f64) -> Result<(), String> {
    window.set_zoom(zoom).map_err(|e| e.to_string())
}

// ---------------- Güncelleme ----------------
// GitHub'daki son sürümün latest.json dosyasına bakar; imzası doğrulanan kurulumu indirip çalıştırır.

#[derive(Default)]
struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

#[tauri::command]
async fn update_check(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    if cfg!(debug_assertions) || std::env::var_os("KESIT_GUNCELLEME_YOK").is_some() {
        return Ok(None);
    }
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone() });
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

#[tauri::command]
async fn update_install(pending: State<'_, PendingUpdate>, on_progress: Channel<f64>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("Güncelleme bilgisi bulunamadı")?;
    let mut got: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                got += chunk as u64;
                if let Some(t) = total.filter(|t| *t > 0) {
                    let _ = on_progress.send(got as f64 / t as f64);
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}

// ---------------- Sağ tık menüsü (Windows) ----------------

#[cfg(windows)]
fn menu_key(ext: &str) -> String {
    format!(r"HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\.{ext}\shell\Kesit")
}

/// Videolara sağ tıklayınca "Kesit ile düzenle". Yönetici izni gerektirmez (HKCU).
#[cfg(windows)]
fn register_context_menu(temp_root: &Path) {
    let Ok(exe) = std::env::current_exe() else { return };
    let exe = simplify(&exe);
    let esc = |s: &str| s.replace('\\', r"\\").replace('"', "\\\"");
    let mut txt = String::from("Windows Registry Editor Version 5.00\r\n\r\n");
    for ext in VIDEO_EXT {
        let key = menu_key(ext);
        txt += &format!("[{key}]\r\n@=\"Kesit ile düzenle\"\r\n\"Icon\"=\"{},0\"\r\n\r\n", esc(&exe));
        txt += &format!("[{key}\\command]\r\n@=\"{}\"\r\n\r\n", esc(&format!("\"{exe}\" \"%1\"")));
    }
    let file = temp_root.join("sag-tik.reg");
    let mut bytes = vec![0xFF, 0xFE];
    for u in txt.encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    if std::fs::write(&file, bytes).is_ok() {
        std::thread::spawn(move || {
            let _ = hidden_command("reg").arg("import").arg(&file).status();
        });
    }
}

#[cfg(windows)]
fn unregister_context_menu() {
    for ext in VIDEO_EXT {
        let key = menu_key(ext).replacen("HKEY_CURRENT_USER", "HKCU", 1);
        let _ = hidden_command("reg").args(["delete", key.as_str(), "/f"]).status();
    }
}

// ---------------- Kendi kendini sınama (yalnızca geliştirme) ----------------
// KESIT_SELFTEST=<betik.js> ile debug sürümü betiği sayfaya enjekte eder; betik sonuçları buraya yollar.

#[tauri::command]
fn selftest_report(app: AppHandle, text: String, done: bool) {
    if std::env::var_os("KESIT_SELFTEST").is_none() {
        return;
    }
    println!("{text}");
    if done {
        app.exit(if text.contains("\"fail\":0") { 0 } else { 1 });
    }
}

// ---------------- Başlangıç ----------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--sag-tik-kaldir") {
        #[cfg(windows)]
        unregister_context_menu();
        return;
    }
    let tmp_root = std::env::temp_dir().join(format!("kesit-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&tmp_root);
    let initial = file_from_args(&args);
    let temp_for_exit = tmp_root.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if let Some(f) = file_from_args(&argv) {
                let _ = app.emit("open-file", f);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate::default())
        .on_page_load(|webview, payload| {
            if !cfg!(debug_assertions) || payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            if let Some(script) = std::env::var_os("KESIT_SELFTEST").and_then(|p| std::fs::read_to_string(p).ok()) {
                let _ = webview.eval(&script);
            }
        })
        .setup(move |app| {
            let ffmpeg = resolve_ffmpeg(app.handle());
            #[cfg(windows)]
            if !cfg!(debug_assertions) {
                register_context_menu(&tmp_root);
            }
            app.manage(AppState {
                jobs: Mutex::new(HashMap::new()),
                killed: Mutex::new(HashSet::new()),
                initial_file: Mutex::new(initial.clone()),
                temp_root: tmp_root.clone(),
                temp_seq: AtomicU32::new(1),
                ffmpeg,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ff_run, ff_kill, ff_capture,
            fs_exists, fs_stat, fs_write_base64, fs_write_text, fs_rename, fs_remove, fs_remove_dir, fs_mkdtemp, temp_root,
            trash_item, set_hidden, reveal, open_path,
            initial_file, pick_video, pick_image, pick_save, update_check, update_install,
            get_settings, set_settings, set_zoom, selftest_report
        ])
        .build(tauri::generate_context!())
        .expect("Kesit başlatılamadı")
        .run(move |app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    for c in state.jobs.lock().unwrap().values() {
                        let _ = c.lock().unwrap().kill();
                    }
                }
                let _ = std::fs::remove_dir_all(&temp_for_exit);
            }
        });
}
