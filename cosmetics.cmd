@echo off
rem Double-click to place a passive's art on each Scoba's head. Opens the
rem cosmetics editor in a browser and writes straight to
rem src\game\content\cosmetics.json, so there is nothing to export or carry
rem back by hand. Close this window when you are done.
cd /d "%~dp0"
if not exist node_modules (
  echo First run: installing dependencies...
  call npm install
)
call npm run cosmetics
pause
