@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org then run this file again. & pause & exit /b 1)
where curl >nul 2>nul || (echo curl.exe was not found. It ships with Windows 10 and 11. & pause & exit /b 1)
if not exist .env (
  copy /y .env.example .env >nul
  echo Created .env. Put your OPENAI_API_KEY in it, save, then close Notepad.
  notepad .env
)
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
node server.js
pause
