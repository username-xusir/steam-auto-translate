@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ====================================
echo  STranslateM - 卸载
echo ====================================
if not exist "STranslateM.exe" (
  echo 找不到 STranslateM.exe。
  pause
  exit /b 1
)
STranslateM.exe uninstall
echo.
pause
