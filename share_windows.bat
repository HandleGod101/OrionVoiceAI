@echo off
setlocal
set "ORION_CLOUDFLARED="
for /f "delims=" %%I in ('where cloudflared.exe 2^>nul') do if not defined ORION_CLOUDFLARED set "ORION_CLOUDFLARED=%%I"
if defined ORION_CLOUDFLARED goto found
if exist "C:\Program Files (x86)\cloudflared\cloudflared.exe" set "ORION_CLOUDFLARED=C:\Program Files (x86)\cloudflared\cloudflared.exe"
if defined ORION_CLOUDFLARED goto found
if exist "C:\Program Files\cloudflared\cloudflared.exe" set "ORION_CLOUDFLARED=C:\Program Files\cloudflared\cloudflared.exe"
if defined ORION_CLOUDFLARED goto found
echo cloudflared was not found. Install it with:
echo winget install --id Cloudflare.cloudflared --exact
echo Then reopen this launcher.
pause
exit /b 1

:found
powershell -NoProfile -Command "try { $null = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8000/api/health' -TimeoutSec 5; exit 0 } catch { exit 1 }"
if errorlevel 1 goto server_missing
echo Copy the https://...trycloudflare.com link from the output below.
echo Keep this window and the app running. Press Ctrl+C to stop sharing.
"%ORION_CLOUDFLARED%" tunnel --url http://127.0.0.1:8000
set "ORION_EXIT=%ERRORLEVEL%"
echo Tunnel stopped.
pause
exit /b %ORION_EXIT%

:server_missing
echo Orion is not responding on port 8000. Start it in another terminal:
echo python -m uvicorn app:app --host 127.0.0.1 --port 8000
pause
exit /b 1
