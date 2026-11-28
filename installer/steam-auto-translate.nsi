Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

!define ROOT ".."
!define APP_NAME "STranslateM"
!define APP_VERSION "0.1.1"
!define INST_DIR "$LOCALAPPDATA\SteamAutoTranslate"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\STranslateM"

Name "${APP_NAME}"
OutFile "${ROOT}\dist\STranslateM-Setup-0.1.1.exe"
InstallDir "${INST_DIR}"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "STranslateM 已安装。$\r$\n$\r$\n直接双击 Steam 即可，1 分钟内自动开始翻译；桌面「STranslateM」可立即启动。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  ; 先结束正在运行的监听器，避免覆盖 exe 失败
  ExecWait 'taskkill /F /IM STranslateM.exe'
  Sleep 1000
  SetOutPath "$INSTDIR"
  File "${ROOT}\dist\STranslateM.exe"
  File "${ROOT}\install.bat"
  File "${ROOT}\uninstall.bat"
  File "${ROOT}\status.bat"
  File "${ROOT}\README.md"
  File "${ROOT}\LICENSE"
  File "${ROOT}\VERSION"
  ; 迁移旧版本文件
  Delete "$INSTDIR\sat.exe"

  DetailPrint "正在写入 Steam 调试标记并启动监听器..."
  ExecWait '"$INSTDIR\STranslateM.exe" install' $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "创建 Steam 调试标记失败。$\r$\n请右键安装程序 → 以管理员身份运行，或安装后手动运行 $INSTDIR\install.bat。"
  ${EndIf}

  CreateDirectory "$SMPROGRAMS\STranslateM"
  CreateShortcut "$SMPROGRAMS\STranslateM\安装状态.lnk" "$INSTDIR\status.bat" "" "$INSTDIR\STranslateM.exe" 0
  CreateShortcut "$SMPROGRAMS\STranslateM\卸载 STranslateM.lnk" "$INSTDIR\uninstall.bat" "" "$INSTDIR\STranslateM.exe" 0
  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "SteamAutoTranslate"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\STranslateM.exe"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  DetailPrint "正在停止监听器并移除 Steam 调试标记..."
  ExecWait '"$INSTDIR\STranslateM.exe" uninstall'
  Delete "$INSTDIR\STranslateM.exe"
  Delete "$INSTDIR\sat.exe"
  Delete "$INSTDIR\install.bat"
  Delete "$INSTDIR\uninstall.bat"
  Delete "$INSTDIR\status.bat"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\VERSION"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\STranslateM\安装状态.lnk"
  Delete "$SMPROGRAMS\STranslateM\卸载 STranslateM.lnk"
  RMDir "$SMPROGRAMS\STranslateM"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SteamAutoTranslate"
SectionEnd
