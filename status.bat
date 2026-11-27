@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ====================================
echo  Steam 自动翻译 - 安装状态
echo ====================================
sat.exe status
echo.
pause
