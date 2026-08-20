@echo off
rem Arrete le serveur de l'editeur PDF.
wsl.exe -d Ubuntu -e bash -lc "pkill -f 'uvicorn server:app' >/dev/null 2>&1; exit 0"
echo Editeur PDF arrete.
timeout /t 2 /nobreak >nul
exit /b 0
