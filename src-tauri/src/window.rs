//! Main window behaviour: state persistence (position, size, maximised),
//! start maximised / minimised, close & minimise to tray, and the tray icon.

use crate::domain::settings;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Window, WindowEvent};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

static LAST_SAVED: Mutex<Option<WindowState>> = Mutex::new(None);

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
    if state.with(|c| settings::set(c, "internal.windowState", &json!(s))).is_ok() {
        *last = Some(s);
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
    let (remember, saved, start_max, launch_min, tray_visible): (bool, Option<WindowState>, bool, bool, bool) = state
        .with(|c| {
            Ok((
                settings::get_or(c, "general.rememberWindow", true),
                settings::get(c, "internal.windowState"),
                settings::get_or(c, "general.startMaximized", false),
                settings::get_or(c, "general.launchMinimized", false),
                settings::get_or(c, "general.showTray", true),
            ))
        })
        .unwrap_or((true, None, false, false, true));

    if let (true, Some(s)) = (remember, saved) {
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
        if s.width >= 600 && s.height >= 400 {
            let _ = w.set_size(PhysicalSize::new(s.width, s.height));
        }
        if on_screen {
            let _ = w.set_position(PhysicalPosition::new(s.x, s.y));
        } else {
            let _ = w.center();
        }
        *LAST_SAVED.lock().unwrap() = Some(WindowState { maximized: false, ..s });
        if s.maximized {
            let _ = w.maximize();
        }
    }
    if start_max {
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
    let capture = MenuItem::with_id(app, "capture", "Quick capture", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &capture, &sep, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Kern")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
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
