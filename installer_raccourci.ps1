# Cree un raccourci "Editeur PDF" avec son icone.
# A lancer depuis Windows : clic droit > Executer avec PowerShell.
#
# Le raccourci est cree dans le dossier du projet plutot que directement sur le Bureau :
# Windows Defender refuse qu'un script y depose un .lnk pointant vers un .cmd. Glissez
# ensuite le raccourci sur votre Bureau depuis l'Explorateur, cette action est autorisee.
$projet = Split-Path -Parent $MyInvocation.MyCommand.Path
$cible = Join-Path $projet 'Editeur PDF.lnk'

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($cible)
$lnk.TargetPath = Join-Path $projet 'lancer.cmd'
$lnk.WorkingDirectory = $projet
$lnk.IconLocation = Join-Path $projet 'icone.ico'
$lnk.Description = 'Editeur PDF local (natifs et scans)'
$lnk.WindowStyle = 7          # demarre reduit dans la barre des taches
$lnk.Save()

Write-Host ""
Write-Host "Raccourci cree : $cible"
Write-Host "Glissez-le sur votre Bureau depuis l'Explorateur."
Write-Host ""
