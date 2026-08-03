@echo off
setlocal enabledelayedexpansion
rem ---------------------------------------------------------------------------
rem  serve.bat - run the game locally.
rem
rem  There is no build step, so this only needs to hand the files over HTTP.
rem  That much is not optional though: the consoles fetch data/*.json, and a
rem  browser refuses those over file:// - so opening index.html by double
rem  clicking it gets you a blank page and a CORS error.
rem
rem    serve.bat            serve on 8173 and open the facilitator page
rem    serve.bat 9000       serve on another port
rem    serve.bat 9000 quiet don't open a browser
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8173"

rem Find something that can serve a directory. Python first because this repo
rem already needs it for PASM, so it is almost certainly here.
set "SERVER="
where py >nul 2>&1 && set "SERVER=py -3 -m http.server %PORT%"
if not defined SERVER (
  where python >nul 2>&1 && set "SERVER=python -m http.server %PORT%"
)
if not defined SERVER (
  where npx >nul 2>&1 && set "SERVER=npx --yes http-server -p %PORT% -c-1"
)

if not defined SERVER (
  echo.
  echo   Could not find a way to serve files.
  echo   Install Python from python.org, or Node from nodejs.org, and try again.
  echo.
  exit /b 1
)

echo.
echo   The Raven Banner, served from %CD%
echo.
echo     Facilitator   http://localhost:%PORT%/host.html
echo     Player        http://localhost:%PORT%/index.html
echo     Map check     http://localhost:%PORT%/tools/map-check.html
echo.
echo   Open the player link in a second window to test a real connection -
echo   two tabs of the same window get their own seats too.
echo.
echo   Ctrl-C to stop.
echo.

if /i not "%~2"=="quiet" start "" "http://localhost:%PORT%/host.html"

%SERVER%
