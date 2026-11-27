@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ====================================
echo  Steam 自动翻译 - 安装
echo ====================================
if not exist "sat.exe" (
  echo 找不到 sat.exe，请把本文件与 sat.exe 放在同一目录。
  pause
  exit /b 1
)
sat.exe install
echo.
pause
