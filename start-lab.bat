@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install it from https://nodejs.org and run this file again. & pause & exit /b)
if not exist node_modules (
  echo First start: installing, this takes a few minutes...
  call npm install
  call npx playwright install chromium
)
start "" cmd /c "timeout /t 6 >nul & start http://localhost:3000/app.html"
call npm start
pause