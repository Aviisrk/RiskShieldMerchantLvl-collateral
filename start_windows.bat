@echo off
REM Double-clickable launcher for Windows.
cd /d "%~dp0"
echo Launching RiskShield Risk Desk...
where py >nul 2>nul && ( py run_riskshield.py & goto :eof )
where python >nul 2>nul && ( python run_riskshield.py & goto :eof )
echo Python 3 not found. Install it from https://www.python.org/downloads/ (tick "Add to PATH") and try again.
pause
