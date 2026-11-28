@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ====================================
echo  STranslateM - 安装状态
echo ====================================
STranslateM.exe status
echo.
pause
