; Installer hooks (Tauri NSIS): a "Kern Lite" Start menu shortcut that opens
; the same app in Kern Lite (kern.exe --lite). Removed on uninstall.

!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$SMPROGRAMS\Kern Lite.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "--lite" "$INSTDIR\${MAINBINARYNAME}.exe" 0 SW_SHOWNORMAL "" "Kern Lite - just your tasks"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$SMPROGRAMS\Kern Lite.lnk"
!macroend
