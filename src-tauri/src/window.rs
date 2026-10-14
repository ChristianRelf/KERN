//! Main window behaviour: state persistence (position, size, maximised),
//! start maximised / minimised, close & minimise to tray, and the tray icon.
//!
//! The window runs in one of two modes: full Kern, or Kern Lite (a small task
//! tracker over the same data). Each mode keeps its own size and position.

use crate::domain::settings;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, Window, WindowEvent};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

static LAST_SAVED: Mutex<Option<WindowState>> = Mutex::new(None);

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Kern,
    Lite,
}

static MODE: Mutex<Mode> = Mutex::new(Mode::Kern);
/// True until the person picks a mode at startup ("ask on start").
static ASKING: Mutex<bool> = Mutex::new(false);

pub fn mode() -> Mode {
    MODE.lock().map(|m| *m).unwrap_or(Mode::Kern)
}

fn state_key(mode: Mode) -> &'static str {
    match mode {
        Mode::Kern => "internal.windowState",
        Mode::Lite => "internal.liteWindowState",
    }
}

/// The mode requested on the command line (`--lite`, `--full`), if any.
pub fn mode_from_args<I: IntoIterator<Item = S>, S: AsRef<str>>(args: I) -> Option<Mode> {
    args.into_iter().find_map(|a| match a.as_ref() {
        "--lite" => Some(Mode::Lite),
        "--full" | "--kern" => Some(Mode::Kern),
        _ => None,
    })
}

fn current_state(app: &AppHandle) -> Option<WindowState> {
    let w = app.get_webview_window("main")?;
    if w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true) {
        return None;
    }
    let maximized = w.is_maximized().unwrap_or(false);
    let pos = w.outer_position().ok()?;
    let size = w.inner_size().ok()?;
    let mut s = WindowState { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized };
    if maximized {
        // Keep the restored (un-maximised) geometry from last time.
        if let Some(prev) = *LAST_SAVED.lock().ok()? {
            s = WindowState { maximized: true, ..prev };
        }
    }
    Some(s)
}

/// Persists the window geometry if it changed since the last save.
pub fn save_window_state(app: &AppHandle) {
    let Some(s) = current_state(app) else { return };
    let Ok(mut last) = LAST_SAVED.lock() else { return };
    if *last == Some(s) {
        return;
    }
    let state = app.state::<AppState>();
    if state.with(|c| settings::set(c, state_key(mode()), &json!(s))).is_ok() {
        *last = Some(s);
    }
}

const KERN_MIN: (f64, f64) = (900.0, 580.0);
const LITE_MIN: (f64, f64) = (320.0, 420.0);
const LITE_DEFAULT: (f64, f64) = (420.0, 720.0);

/// Applies a mode's minimum size, title and saved geometry to the window.
fn apply_geometry(w: &WebviewWindow, mode: Mode, remember: bool, saved: Option<WindowState>) {
    let (min, title) = match mode {
        Mode::Kern => (KERN_MIN, "Kern"),
        Mode::Lite => (LITE_MIN, "Kern Lite"),
    };
    let _ = w.set_min_size(Some(LogicalSize::new(min.0, min.1)));
    let _ = w.set_title(title);
    if let Ok(mut last) = LAST_SAVED.lock() {
        *last = None;
    }
    match (remember, saved) {
        (true, Some(s)) => {
            // Only restore a position that is still on a connected display.
            let on_screen = w
                .available_monitors()
                .map(|ms| {
                    ms.iter().any(|m| {
                        let p = m.position();
                        let sz = m.size();
                        s.x + 80 >= p.x && s.y + 20 >= p.y && s.x + 80 < p.x + sz.width as i32 && s.y + 20 < p.y + sz.height as i32
                    })
                })
                .unwrap_or(false);
            let scale = w.scale_factor().unwrap_or(1.0);
            if s.width as f64 >= min.0 * scale * 0.66 && s.height as f64 >= min.1 * scale * 0.66 {
                let _ = w.set_size(PhysicalSize::new(s.width, s.height));
            }
            if on_screen {
                let _ = w.set_position(PhysicalPosition::new(s.x, s.y));
            } else {
                let _ = w.center();
            }
            if let Ok(mut last) = LAST_SAVED.lock() {
                *last = Some(WindowState { maximized: false, ..s });
            }
            if s.maximized {
                let _ = w.maximize();
            }
        }
        _ => {
            let size = if mode == Mode::Lite { LITE_DEFAULT } else { (1360.0, 860.0) };
            let _ = w.set_size(LogicalSize::new(size.0, size.1));
            let _ = w.center();
        }
    }
}

/// Switches the window between full Kern and Kern Lite.
pub fn set_mode(app: &AppHandle, next: Mode) {
    let Some(w) = app.get_webview_window("main") else { return };
    if let Ok(mut a) = ASKING.lock() {
        *a = false;
    }
    let state = app.state::<AppState>();
    let _ = state.with(|c| settings::set(c, "internal.lastMode", &json!(next)));
    if mode() == next {
        return;
    }
    save_window_state(app);
    if let Ok(mut m) = MODE.lock() {
        *m = next;
    }
    let (remember, saved, start_max): (bool, Option<WindowState>, bool) = state
        .with(|c| {
            Ok((
                settings::get_or(c, "general.rememberWindow", true),
                settings::get(c, state_key(next)),
                settings::get_or(c, "general.startMaximized", false),
            ))
        })
        .unwrap_or((true, None, false));
    // A minimised window ignores resizing, so bring it back first.
    let _ = w.unminimize();
    let _ = w.unmaximize();
    let _ = w.set_always_on_top(false);
    apply_geometry(&w, next, remember, saved);
    if next == Mode::Kern && start_max && saved.is_none() {
        let _ = w.maximize();
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Applies saved geometry and the launch options, then shows the window.
pub fn restore_and_show(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let state = app.state::<AppState>();
    let (remember, start_max, launch_min, tray_visible, start_mode, last_mode): (bool, bool, bool, bool, String, Option<Mode>) = state
        .with(|c| {
            Ok((
                settings::get_or(c, "general.rememberWindow", true),
                settings::get_or(c, "general.startMaximized", false),
                settings::get_or(c, "general.launchMinimized", false),
                settings::get_or(c, "general.showTray", true),
                settings::get_or(c, "general.startMode", "ask".to_string()),
                settings::get(c, "internal.lastMode"),
            ))
        })
        .unwrap_or((true, false, false, true, "ask".into(), None));

    // Which mode to open in: the command line, then the startup choice. When
    // asking, the window opens in the mode used last time.
    let (start, ask) = match mode_from_args(std::env::args()) {
        Some(m) => (m, false),
        None => match start_mode.as_str() {
            "lite" => (Mode::Lite, false),
            "ask" => (last_mode.unwrap_or(Mode::Kern), true),
            _ => (Mode::Kern, false),
        },
    };
    if let Ok(mut m) = MODE.lock() {
        *m = start;
    }
    if let Ok(mut a) = ASKING.lock() {
        *a = ask;
    }
    let saved: Option<WindowState> = state.with(|c| Ok(settings::get(c, state_key(start)))).ok().flatten();
    apply_geometry(&w, start, remember, saved);
    if start_max && start == Mode::Kern {
        let _ = w.maximize();
    }
    let at_login = std::env::args().any(|a| a == "--autostart");
    if at_login && launch_min {
        if tray_visible {
            return; // Stay in the tray.
        }
        let _ = w.show();
        let _ = w.minimize();
        return;
    }
    let _ = w.show();
    let _ = w.set_focus();
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    let app = window.app_handle();
    let state = app.state::<AppState>();
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            save_window_state(app);
            let behavior: String = state
                .with(|c| Ok(settings::get_or(c, "general.closeBehavior", "quit".to_string())))
                .unwrap_or_else(|_| "quit".into());
            if behavior == "tray" && !state.quitting.load(Ordering::SeqCst) {
                api.prevent_close();
                let _ = window.hide();
            } else if !state.quitting.load(Ordering::SeqCst) && state.pty.running_count() > 0 {
                // Don't silently abandon running terminal processes: ask first.
                api.prevent_close();
                let _ = app.emit("kern://confirm-quit", state.pty.running_count());
            }
        }
        WindowEvent::Resized(_) => {
            if window.is_minimized().unwrap_or(false) {
                let to_tray: bool =
                    state.with(|c| Ok(settings::get_or(c, "general.minimizeToTray", false))).unwrap_or(false);
                if to_tray {
                    let _ = window.hide();
                }
            }
        }
        _ => {}
    }
}

pub fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Kern", true, None::<&str>)?;
    let lite = MenuItem::with_id(app, "lite", "Open Kern Lite", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "Quick capture", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &lite, &capture, &sep, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Kern")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                show_main(app);
                let _ = app.emit("kern://switch-mode", Mode::Kern);
            }
            "lite" => {
                show_main(app);
                let _ = app.emit("kern://switch-mode", Mode::Lite);
            }
            "capture" => {
                show_main(app);
                let _ = app.emit("kern://quick-capture", ());
            }
            "quit" => {
                app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
                save_window_state(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    let visible = app
        .state::<AppState>()
        .with(|c| Ok(settings::get_or(c, "general.showTray", true)))
        .unwrap_or(true);
    let _ = tray.set_visible(visible);
    Ok(())
}

// ------------------------------------------------------------ commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeInfo {
    pub mode: Mode,
    /// Show the "Kern or Kern Lite?" choice before anything else.
    pub ask: bool,
}

#[tauri::command]
pub fn app_mode_get() -> ModeInfo {
    ModeInfo { mode: mode(), ask: ASKING.lock().map(|a| *a).unwrap_or(false) }
}

#[tauri::command]
pub fn app_mode_set(app: AppHandle, mode: Mode) {
    set_mode(&app, mode);
}

/// Keeps the Kern Lite window above other windows (Lite only).
#[tauri::command]
pub fn app_lite_pin(app: AppHandle, on: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(on && mode() == Mode::Lite);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_arguments_pick_the_mode() {
        assert_eq!(mode_from_args(["kern.exe", "--lite"]), Some(Mode::Lite));
        assert_eq!(mode_from_args(["kern.exe", "--autostart", "--full"]), Some(Mode::Kern));
        assert_eq!(mode_from_args(["kern.exe", "--autostart"]), None);
    }

    #[test]
    fn modes_serialize_lowercase() {
        assert_eq!(serde_json::to_string(&Mode::Lite).unwrap(), "\"lite\"");
        assert_eq!(serde_json::from_str::<Mode>("\"kern\"").unwrap(), Mode::Kern);
    }
}
