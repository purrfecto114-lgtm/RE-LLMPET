#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--octopus-hook" | "--re-llmpet-hook"))
    {
        octopus_lib::hook_client::entry();
        return;
    }
    // R56: uninstaller-invoked headless hook cleanup. The NSIS PREUNINSTALL
    // hook runs `octopus.exe --uninstall-hooks` AFTER killing the tray app
    // and BEFORE deleting $INSTDIR — so the provider configs are repaired
    // while the binary still exists. Exit code 0 = all hooks clean, 1 = at
    // least one provider needs manual attention (the uninstaller only logs
    // it; the files still get deleted). On macOS/Linux this flag is the
    // documented manual cleanup step after drag-to-trash / dpkg -r.
    if args.iter().any(|arg| arg == "--uninstall-hooks") {
        std::process::exit(octopus_lib::uninstall_all_hooks_cli());
    }
    octopus_lib::run();
}
