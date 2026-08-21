@echo off
rem Drag an exported world.json onto this file to make it the map the game
rem ships with. Windows hands the dropped path in as %1.
setlocal
cd /d "%~dp0"

if "%~1"=="" (
  echo.
  echo   Drag an exported world.json onto this file.
  echo.
  pause
  exit /b 1
)

node "tools\import-world.mjs" "%~1"
if errorlevel 1 (
  pause
  exit /b 1
)

echo   Press any key to close.
pause >nul
