@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==============================
echo   Memoza Frontend Pipeline
echo ==============================
echo.

git diff --quiet HEAD -- core/package.json web/package.json desktop/package.json package-lock.json
if %errorlevel%==0 (
    echo [deps] No dependency changes detected. Skipping npm install.
) else (
    echo [deps] package.json changed - running npm install...
    call npm install
    if errorlevel 1 goto :error
)
echo.

set /p DOWEB="Build and deploy WEB (app.memoza.io)? [y/N] "
if /i "%DOWEB%"=="y" (
    echo.
    echo [web] Building...
    call npm run build --workspace=web
    if errorlevel 1 goto :error

    echo [web] Deploying with wrangler...
    pushd web
    call wrangler deploy
    popd
    if errorlevel 1 goto :error
    echo [web] Done.
)
echo.

set /p DODESK="Build DESKTOP app (Windows installer)? [y/N] "
if /i "%DODESK%"=="y" (
    echo.
    echo [desktop] Building frontend + NSIS installer...
    pushd desktop
    call npm run tauri build -- --bundles nsis
    popd
    if errorlevel 1 goto :error

    echo [desktop] Copying installer to frontend root...
    for /r "desktop\src-tauri\target\release\bundle\nsis" %%f in (*.exe) do (
        copy /y "%%f" "%~dp0%%~nxf" >nul
        echo [desktop] Copied %%~nxf to frontend\
    )
    echo [desktop] Done.
)

echo.
echo ==============================
echo   Pipeline finished.
echo ==============================
goto :eof

:error
echo.
echo [ERROR] A step failed. Stopping pipeline.
exit /b 1
