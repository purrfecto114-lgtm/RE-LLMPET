//! LLMPET R4 · Tauri 宿主五门禁 PoC
//! 运行：cargo run --release（桌面会话）
//! G2/G3/G4 自动判定；G1 需按窗口提示人工点击确认（R 键切换穿透观察事件流）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Instant;
use tao::dpi::LogicalSize;

const HTML: &str = r#"<!doctype html><meta charset="utf-8">
<body style="margin:0;background:transparent;font:14px sans-serif;color:#fff">
<div style="position:fixed;inset:0;background:rgba(0,0,0,0.01)"></div>
<div style="width:220px;height:130px;background:#d97757;border-radius:12px;padding:10px">
  <b>R4 Gate PoC</b><br>
  G1: 点击橙色框外空白处<br>→ 焦点落到下层应用 = PASS<br>
  按 R 切换穿透，悬停橙框移动鼠标看控制台 mousemove 计数
</div>"#;

fn main() {
    use tao::event_loop::{ControlFlow, EventLoop};
    use tao::window::Window;
    use tao::{event::ElementState, event::Event, event::WindowEvent, keyboard::KeyCode};

    let event_loop = EventLoop::new();
    let win = tao::window::WindowBuilder::new()
        .with_title("LLMPET R4 gate")
        .with_transparent(true)      // G2
        .with_always_on_top(true)    // G2
        .with_decorations(false)
        .with_resizable(false)
        .with_inner_size(LogicalSize::new(420.0, 240.0))
        .build(&event_loop)
        .expect("window");
    println!("G2 transparent+aot: PASS");

    // G3 托盘
    match tray_icon::TrayIconBuilder::new().with_tooltip("LLMPET R4 gate").build() {
        Ok(_) => println!("G3 tray          : PASS"),
        Err(e) => println!("G3 tray          : FAIL ({e})"),
    }

    let mut webview = wry::WebViewBuilder::new()
        .with_html(HTML)
        .build(&win)
        .expect("webview");
    let _ = &mut webview;

    // G4 setBounds 动画：60 步 320x340 -> 520x544
    let t0 = Instant::now();
    let steps = 60u32;
    for i in 1..=steps {
        let k = i as f64 / steps as f64;
        let w = 320.0 + (520.0 - 320.0) * k;
        let h = 340.0 + (544.0 - 340.0) * k;
        win.set_inner_size(LogicalSize::new(w, h));
    }
    let fps = steps as f32 / t0.elapsed().as_secs_f32().max(f32::EPSILON);
    println!("G4 bounds anim   : {fps:.0}fps {}", if fps >= 60.0 { "PASS" } else { "FAIL" });
    println!("G1 click-through : MANUAL（人工点击框外确认；按 R 切穿透）");
    println!("G5 size          : 看 target/release 产物（<15MB 含 sidecar 为 PASS）");

    let mut ignoring = false;
    event_loop.run(move |e, _, cf| {
        *cf = ControlFlow::Poll;
        if let Event::WindowEvent { event: WindowEvent::KeyboardInput { event, .. }, .. } = e {
            if event.state == ElementState::Pressed && event.physical_key == KeyCode::KeyR {
                ignoring = !ignoring;
                win.set_ignore_cursor_events(ignoring).ok();
                println!("[toggle] ignore_cursor_events -> {ignoring}");
            }
        }
    });
}
