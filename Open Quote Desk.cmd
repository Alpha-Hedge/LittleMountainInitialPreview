@echo off
setlocal
title Little Mountain Metalworks
pushd "%~dp0"
echo Opening the quote desk...
call quote.cmd exec node scripts/open-desk.mjs %*
set "deskResult=%errorlevel%"
if not "%deskResult%"=="0" pause
popd
exit /b %deskResult%
