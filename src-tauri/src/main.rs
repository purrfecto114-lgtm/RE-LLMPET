#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

fn main() {
    if std::env::args().any(|arg| arg == "--re-llmpet-hook") {
        octopus_lib::hook_client::entry();
        return;
    }
    octopus_lib::run();
}
