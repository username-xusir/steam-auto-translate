@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ====================================
echo  STranslateM - 安装
echo ====================================
if not exist "STranslateM.exe" (
  echo 找不到 STranslateM.exe，请把本文件与 STranslateM.exe 放在同一目录。
  pause
  exit /b 1
)
STranslateM.exe install
echo.
pause
