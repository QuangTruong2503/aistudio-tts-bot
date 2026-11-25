@echo off
setlocal

REM Allow passing a custom port as first argument (default: 9222)
set "PORT=%~1"
if "%PORT%"=="" set "PORT=9222"

REM Dedicated profile directory per port (9222 -> Profile 1, other port -> separate Profile)
if "%PORT%"=="9222" (
    set "PROFILE_DIR=%LOCALAPPDATA%\aistudio-tts-chrome-profile"
) else (
    set "PROFILE_DIR=%LOCALAPPDATA%\aistudio-tts-chrome-profile-%PORT%"
)

set "TARGET_URL=https://aistudio.google.com/generate-speech?model=gemini-3.8-flash-tts"

REM Auto-detect Google Chrome executable on Windows
set "CHROME_EXE="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
) else if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
    set "CHROME_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
)

if "%CHROME_EXE%"=="" (
    echo [ERROR] Chrome executable not found. Please check your Google Chrome installation.
    exit /b 1
)

if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

echo [INFO] Starting Chrome in Debug Mode...
echo [INFO] Port       : %PORT%
echo [INFO] Profile    : %PROFILE_DIR%
echo [INFO] Target URL : %TARGET_URL%
echo.

start "" "%CHROME_EXE%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE_DIR%" --no-first-run --no-default-browser-check "%TARGET_URL%"

endlocal
