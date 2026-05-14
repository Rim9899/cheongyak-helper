@echo off
title Cheongyak Server
cd /d "%~dp0"
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 "') do taskkill /PID %%a /F >nul 2>&1
echo.
echo  Server: http://localhost:3000
echo  Stop: Ctrl+C
echo.
"C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Microsoft\VisualStudio\NodeJs\node.exe" server.js
pause