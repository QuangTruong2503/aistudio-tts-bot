@echo off
setlocal
cd /d "%~dp0\.."
echo [INFO] Starting AI Studio TTS Pro Web Dashboard (http://localhost:3456)...
node src\server.js
pause
endlocal
