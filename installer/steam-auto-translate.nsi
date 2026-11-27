Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

!define ROOT ".."
!define APP_NAME "Steam 自动翻译"
!define APP_VERSION "0.1.0"
!define INST_DIR "$LOCALAPPDATA\SteamAutoTranslate"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SteamAutoTranslate"

Name "${APP_NAME}"
OutFile "${ROOT}\dist\SteamAutoTranslate-Setup-0.1.0.exe"
InstallDir "${INST_DIR}"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "Steam 自动翻译已安装。$\r$\n$\r$\n请完全退出 Steam 再重新打开，翻译才会生效（页面右下角会出现「译」按钮）。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File "${ROOT}\dist\sat.exe"
  File "${ROOT}\install.bat"
  File "${ROOT}\uninstall.bat"
  File "${ROOT}\status.bat"
  File "${ROOT}\README.md"
  File "${ROOT}\LICENSE"
  File "${ROOT}\VERSION"

  DetailPrint "正在写入 Steam 调试标记并启动监听器..."
  ExecWait '"$INSTDIR\sat.exe" install' $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "创建 Steam 调试标记失败。$\r$\n请右键安装程序 → 以管理员身份运行，或安装后手动运行 $INSTDIR\install.bat。"
  ${EndIf}

  CreateDirectory "$SMPROGRAMS\Steam 自动翻译"
  CreateShortcut "$SMPROGRAMS\Steam 自动翻译\安装状态.lnk" "$INSTDIR\status.bat" "" "$INSTDIR\sat.exe" 0
  CreateShortcut "$SMPROGRAMS\Steam 自动翻译\卸载 Steam 自动翻译.lnk" "$INSTDIR\uninstall.bat" "" "$INSTDIR\sat.exe" 0
  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "SteamAutoTranslate"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\sat.exe"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  DetailPrint "正在停止监听器并移除 Steam 调试标记..."
  ExecWait '"$INSTDIR\sat.exe" uninstall'
  Delete "$INSTDIR\sat.exe"
  Delete "$INSTDIR\install.bat"
  Delete "$INSTDIR\uninstall.bat"
  Delete "$INSTDIR\status.bat"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\VERSION"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Steam 自动翻译\安装状态.lnk"
  Delete "$SMPROGRAMS\Steam 自动翻译\卸载 Steam 自动翻译.lnk"
  RMDir "$SMPROGRAMS\Steam 自动翻译"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
