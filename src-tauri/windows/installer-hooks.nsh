; Octopus NSIS extension point.
; ---------------------------------------------------------------------------
; R56 (2026-09-24): full uninstall hygiene. The 0.5.4x-era hooks only copied
; an alias exe and deleted it on uninstall — the provider configs
; (~/.claude/settings.json, ~/.codex/hooks.json, CodeWhale config.toml,
; OpenCode plugin, .aider.conf.yml) kept pointing at the deleted binary, so
; "successful" uninstalls left every agent CLI broken (CodeWhale's
; fail-closed permission hook rejects every tool call once the exe is gone).
; New flow:
;   PREINSTALL  — old RE-LLMPET gate, now with a bounded registry poll and
;                 a dead-uninstaller escape hatch (the old ExecWait+Abort
;                 pair looped forever when the stale key pointed at a
;                 missing uninstaller).
;   POSTINSTALL — alias exe for legacy hook commands (unchanged).
;   PREUNINSTALL— kill every Octopus process (tray app + hook shims can be
;                 mid-flight in an agent session and lock the files), then
;                 run `octopus.exe --uninstall-hooks` to repair the provider
;                 configs, then delete the alias. Files are removed by the
;                 template right after, so the binary still exists here.
; ---------------------------------------------------------------------------
!macro NSIS_HOOK_PREINSTALL
  StrCpy $0 ""
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RE-LLMPET" "UninstallString"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\io.github.purrfecto114.rellmpet" "UninstallString"
  ${EndIf}
  ${If} $0 == ""
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\RE-LLMPET" "UninstallString"
  ${EndIf}
  ${If} $0 == ""
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\io.github.purrfecto114.rellmpet" "UninstallString"
  ${EndIf}
  ${If} $0 != ""
    ; R56: the old gate ExecWait'ed the legacy uninstaller and ALWAYS Abort'ed.
    ; NSIS uninstallers self-copy to %TEMP% and run asynchronously, so
    ; ExecWait returns before the registry key is gone and an immediate
    ; re-run looped forever ("无法正常卸载/安装"). If the recorded
    ; uninstaller no longer exists, the key is a dead corpse — offer to
    ; remove it instead of looping.
    IfFileExists "$0" octopus_old_exists octopus_old_dead
    octopus_old_dead:
      MessageBox MB_ICONEXCLAMATION|MB_YESNO "检测到旧版 RE-LLMPET 的注册表残留，但其卸载程序已不存在。是否清除这条残留记录并继续安装？" IDNO octopus_old_install_abort
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RE-LLMPET"
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\io.github.purrfecto114.rellmpet"
      DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\RE-LLMPET"
      DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\io.github.purrfecto114.rellmpet"
      Goto octopus_old_done
    octopus_old_exists:
      MessageBox MB_ICONEXCLAMATION|MB_YESNO "检测到旧版 RE-LLMPET。为避免重复托盘、旧 Hook 与配置冲突，需要先卸载旧版。现在打开旧版卸载程序吗？（卸载在后台继续，安装器将等待其完成）" IDNO octopus_old_install_abort
      ExecWait '$0 _?=$INSTDIR'
      ; R56: bounded registry poll (up to 30s) — ExecWait on a self-copying
      ; NSIS uninstaller returns early, so poll the key instead of trusting
      ; the exit. A stuck uninstaller surfaces the manual message once.
      StrCpy $1 0
      octopus_old_poll:
        ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RE-LLMPET" "UninstallString"
        StrCmp $2 "" octopus_old_check2 octopus_old_wait
      octopus_old_check2:
        ReadRegStr $2 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\RE-LLMPET" "UninstallString"
        StrCmp $2 "" octopus_old_done octopus_old_wait
      octopus_old_wait:
        IntOp $1 $1 + 1
        IntCmp $1 30 octopus_old_timeout 0 octopus_old_poll
        Sleep 1000
        Goto octopus_old_poll
      octopus_old_timeout:
        Abort "等待旧版 RE-LLMPET 卸载超时（注册表记录仍在）。请手动完成旧版卸载后重新运行本安装程序。"
    octopus_old_done:
  ${EndIf}
  Goto octopus_preinstall_exit
  octopus_old_install_abort:
    Abort "安装已取消。请先卸载旧版 RE-LLMPET，再安装 Octopus。"
  octopus_preinstall_exit:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CopyFiles "$INSTDIR\octopus-hook.exe" "$INSTDIR\re-llmpet-hook.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; R56: kill everything that can lock $INSTDIR files. The tray app
  ; (octopus.exe) holds the binary while running; the hook shims
  ; (octopus-hook.exe / re-llmpet-hook.exe alias) are short-lived but can
  ; be mid-flight inside an agent session. The template's own
  ; CheckIfAppIsRunning later in un.onInit becomes a no-op after this.
  nsis_tauri_utils::KillProcessCurrentUser "octopus.exe"
  Pop $0
  nsis_tauri_utils::KillProcessCurrentUser "octopus-hook.exe"
  Pop $0
  nsis_tauri_utils::KillProcessCurrentUser "re-llmpet-hook.exe"
  Pop $0
  Sleep 500
  ; Repair the provider configs while the binary still exists: removes our
  ; hook blocks from ~/.claude, ~/.codex, CodeWhale, OpenCode, .aider.conf.yml
  ; so no agent CLI is left pointing at a deleted exe. Exit code 1 means a
  ; provider needs manual attention — logged, not fatal.
  IfFileExists "$INSTDIR\octopus.exe" 0 octopus_uninstall_hooks_skip
    ExecWait '"$INSTDIR\octopus.exe" --uninstall-hooks' $0
    DetailPrint "octopus --uninstall-hooks exit code: $0"
  octopus_uninstall_hooks_skip:
  Delete "$INSTDIR\re-llmpet-hook.exe"
!macroend
