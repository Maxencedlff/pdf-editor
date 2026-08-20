@echo off
rem Lanceur de l'editeur PDF local.
rem Demarre le serveur dans WSL s'il ne tourne pas deja, puis ouvre l'application
rem dans une fenetre Chrome dediee.

set PORT=8420
set DISTRO=Ubuntu
set PROJET=/mnt/c/Users/maxde/pdf-editor
set URL=http://localhost:%PORT%

rem Tout se joue en une seule invocation de WSL : on demarre le serveur s'il est absent,
rem puis on attend qu'il reponde. setsid et nohup le detachent du terminal, sans quoi il
rem s'arreterait des que cette fenetre se referme.
wsl.exe -d %DISTRO% -e bash -lc "cd %PROJET% || exit 1; curl -s --max-time 2 http://127.0.0.1:%PORT%/api/config >/dev/null || setsid nohup ./run.sh %PORT% </dev/null >/tmp/editeur-pdf.log 2>&1 & n=0; until curl -s --max-time 1 http://127.0.0.1:%PORT%/api/config >/dev/null; do n=$((n+1)); [ $n -gt 80 ] && exit 1; sleep 0.5; done; exit 0"

if errorlevel 1 goto echec

set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
if exist "%CHROME%" (
    rem --app ouvre une fenetre sans barre d'adresse ni onglets
    start "" "%CHROME%" --app=%URL% --window-size=1560,980
) else (
    start "" %URL%
)
exit /b 0

:echec
echo.
echo   L'editeur PDF n'a pas pu demarrer.
echo   Journal : \\wsl$\%DISTRO%\tmp\editeur-pdf.log
echo.
pause
exit /b 1
