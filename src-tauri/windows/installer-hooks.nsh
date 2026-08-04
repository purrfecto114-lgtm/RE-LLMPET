; Octopus NSIS extension point.
; The previous rewrite shipped as "RE-LLMPET" with identifier
; "io.github.purrfecto114.rellmpet". Tauri/NSIS versions may derive the
; uninstall registry key from either value, so check both scopes and names.
; Do not silently remove it: the old process/hooks/config writer must exit
; before Octopus is installed, otherwise duplicate tray icons and stale hooks
; can coexist.
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
    MessageBox MB_ICONEXCLAMATION|MB_YESNO "检测到旧版 RE-LLMPET。为避免重复托盘、旧 Hook 与配置冲突，需要先卸载旧版。现在打开旧版卸载程序吗？" IDNO octopus_old_install_abort
      ExecWait '$0'
      Abort "旧版卸载程序已结束。请确认卸载完成后重新运行 Octopus 安装程序。"
    octopus_old_install_abort:
      Abort "安装已取消。请先卸载旧版 RE-LLMPET，再安装 Octopus。"
  ${EndIf}
!macroend
