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
    // it; the files still get deleted).
    //
    // R58-IMPL-D (R9, A1): on macOS/Linux there is NO uninstaller — you MUST
    // run this flag BEFORE dragging the .app to Trash / `dpkg -r`. The old
    // comment claimed the flag works "after drag-to-trash" — a dead path:
    // once the .app / binary is deleted, the provider configs keep pointing
    // at a nonexistent path and CodeWhale's fail-closed permission hook
    // rejects every tool call (see README uninstall notes for the exact
    // steps). `--purge-data` additionally removes `~/.re-llmpet` (config /
    // logs / usage history / receipts) after the hooks are clean.
    if args.iter().any(|arg| arg == "--uninstall-hooks") {
        // R58-IMPL-D (A1): --purge-data only takes effect together with
        // --uninstall-hooks (it is an uninstaller modifier, not a mode).
        let purge = args.iter().any(|arg| arg == "--purge-data");
        std::process::exit(octopus_lib::uninstall_all_hooks_cli(purge));
    }
    octopus_lib::run();
}
