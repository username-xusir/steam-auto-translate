@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ====================================
echo  Steam 自动翻译 - 卸载
echo ====================================
if not exist "sat.exe" (
  echo 找不到 sat.exe。
  pause
  exit /b 1
)
sat.exe uninstall
echo.
pause
