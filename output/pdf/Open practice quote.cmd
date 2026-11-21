@echo off
setlocal
title Little Mountain - Practice quote
cd /d "%~dp0..\.."
set "LMM_DATA_DIR=%~dp0practice-data"
set "LMM_SUPABASE_DATA_DIR=%~dp0unconnected"
set "LMM_SUPABASE_WORKSPACE_KIND=verification"
set "LMM_GMAIL_CLIENT_ID="
set "LMM_GMAIL_CLIENT_SECRET="
powershell.exe -NoProfile -Command "try { $page = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://127.0.0.1:3150/quotes/new'; if ($page.StatusCode -eq 200 -and $page.Content.Contains('Little Mountain Metalworks')) { exit 0 } } catch {}; exit 1"
if not errorlevel 1 goto ready
start "Little Mountain practice desk" /min "%ComSpec%" /d /c quote.cmd exec node scripts/web.mjs start --hostname 127.0.0.1 --port 3150
powershell.exe -NoProfile -Command "for ($i=0; $i -lt 45; $i++) { try { $page = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://127.0.0.1:3150/quotes/new'; if ($page.StatusCode -eq 200 -and $page.Content.Contains('Little Mountain Metalworks')) { exit 0 } } catch {}; Start-Sleep -Seconds 1 }; exit 1"
if not errorlevel 1 goto ready
echo The practice desk could not open on this computer.
pause
exit /b 1
:ready
if /i "%~1"=="--check" exit /b 0
start "" "http://127.0.0.1:3150/quotes/new"