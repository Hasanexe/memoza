@echo off
setlocal
cd /d "%~dp0"

echo ==============================
echo   Memoza Public Sites Deploy
echo ==============================
echo.

echo [public-sites] Building public-reader bundle...
pushd ..
call npm run build --workspace=public-reader
popd
if errorlevel 1 goto :error

echo [public-sites] Deploying sites-worker with wrangler...
pushd ..\..\backend-services\4-public-sites\sites-worker
call wrangler deploy
popd
if errorlevel 1 goto :error

echo.
echo [public-sites] Done.
goto :eof

:error
echo.
echo [ERROR] public-sites deploy failed.
exit /b 1
