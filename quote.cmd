@echo off
setlocal
where node.exe >nul 2>nul && where pnpm.cmd >nul 2>nul && goto run
for /f "delims=" %%R in ('powershell.exe -NoProfile -Command "(Get-AppxPackage 'OpenAI.CodexPrimaryRuntime*' | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation"') do set "quoteRuntime=%%R\dependencies"
if not exist "%quoteRuntime%\bin\fallback\pnpm.cmd" (
  echo Install Node.js 24 and pnpm 11 to run this project.
  exit /b 1
)
set "PATH=%quoteRuntime%\node\bin;%quoteRuntime%\bin\fallback;%PATH%"
:run
pushd "%~dp0"
call pnpm.cmd %*
set "quoteExit=%errorlevel%"
popd
exit /b %quoteExit%
