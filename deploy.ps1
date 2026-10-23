[CmdletBinding()]
param(
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9.-]*$')][string]$Server = 'server.local',
    [ValidatePattern('^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$')][string]$User = 'user',
    [ValidateRange(1, 65535)][int]$SshPort = 22,
    [ValidateRange(1, 65535)][int]$AppPort = 8080,
    [ValidatePattern('^[a-zA-Z0-9_-][a-zA-Z0-9_/-]*$')][string]$RemoteDirectory = 'gestion-imprimantes',
    [string]$IdentityFile,
    [switch]$SetupSsh
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($IdentityFile)) {
    $IdentityFile = Join-Path $PSScriptRoot '.deploy/id_ed25519'
}
if ($RemoteDirectory.Split('/') -contains '..') { throw 'Chemin distant invalide.' }
$target = if ($User) { "$User@$Server" } else { $Server }
function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments, [string]$Context)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        $detail = if ($Context) { " : $Context" } else { '' }
        throw "Echec de $Executable (code $LASTEXITCODE)$detail."
    }
}
foreach ($tool in @('ssh', 'scp', 'ssh-keygen')) { Get-Command $tool -ErrorAction Stop | Out-Null }
$IdentityFile = [IO.Path]::GetFullPath($IdentityFile)
if ($SetupSsh) {
    if (!(Test-Path -LiteralPath $IdentityFile)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $IdentityFile) | Out-Null
        # ProcessStartInfo preserve l'argument vide sous Windows PowerShell 5.1.
        if ($IdentityFile.Contains('"')) { throw 'Chemin de cle invalide.' }
        $info = New-Object System.Diagnostics.ProcessStartInfo
        $info.FileName = (Get-Command ssh-keygen).Source
        $info.Arguments = '-t ed25519 -N "" -f "' + $IdentityFile + '" -C "atelier-deployment"'
        $info.UseShellExecute = $false
        $process = [Diagnostics.Process]::Start($info)
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw 'Generation de la cle SSH echouee.' }
    }
    if (!(Test-Path -LiteralPath "$IdentityFile.pub")) {
        $publicKey = & ssh-keygen -y -f $IdentityFile
        if ($LASTEXITCODE -ne 0) { throw 'Impossible de retrouver la cle publique.' }
        [IO.File]::WriteAllText("$IdentityFile.pub", "$publicKey`n", (New-Object Text.UTF8Encoding($false)))
    }
    $publicKey = (Get-Content -LiteralPath "$IdentityFile.pub" -Raw).Trim()
    if ($publicKey -notmatch '^(ssh-ed25519 [A-Za-z0-9+/=]+)(?: [^\r\n]*)?$') { throw 'Cle publique invalide.' }
    $publicKey = $Matches[1] + ' atelier-deployment'
    # Seule la cle publique est envoyee ; la cle privee reste sur ce PC.
    $install = "set -eu; umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF '$publicKey' ~/.ssh/authorized_keys || printf '%s\n' '$publicKey' >> ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys"
    Invoke-Checked 'ssh' @('-p', "$SshPort", $target, $install)
    Invoke-Checked 'ssh' @('-p', "$SshPort", '-i', $IdentityFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', $target, 'echo Cle SSH operationnelle')
    Write-Host 'SSH configure. Relancer sans -SetupSsh pour deployer.'
    return
}
if (!(Test-Path -LiteralPath $IdentityFile)) { throw 'Cle absente : lancer ce script avec -SetupSsh et le compte Linux (-User).' }
Get-Command podman -ErrorAction Stop | Out-Null
$sshArgs = @('-p', "$SshPort", '-i', $IdentityFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes')
$scpArgs = @('-P', "$SshPort", '-i', $IdentityFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes')
# Verifie la connexion et les prerequis avant de construire.
Write-Host "Verification de SSH et de Podman sur $target..."
$preflight = 'set -eu; echo SSH_OK; command -v podman >/dev/null || { echo PODMAN_ABSENT >&2; exit 1; }; podman info >/dev/null || { echo PODMAN_INDISPONIBLE >&2; exit 1; }; podman compose version || { echo COMPOSE_INDISPONIBLE >&2; exit 1; }; uname -m'
Invoke-Checked 'ssh' ($sshArgs + @($target, $preflight)) 'verification de la connexion et des prerequis distants'
Invoke-Checked 'ssh' ($sshArgs + @($target, 'test "$(uname -m)" = x86_64 || { echo "Ce script construit des images pour serveur x86_64." >&2; exit 1; }'))
Invoke-Checked 'podman' @('info', '--format', '{{.Host.Arch}}')
$version = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
$release = Join-Path $PSScriptRoot ".deploy/releases/$version"
New-Item -ItemType Directory -Force -Path $release | Out-Null
foreach ($service in @('backend', 'frontend')) {
    $image = "localhost/atelier-${service}:$version"
    Invoke-Checked 'podman' @('build', '--platform', 'linux/amd64', '-t', $image, '-f', (Join-Path $PSScriptRoot "$service/Containerfile"), (Join-Path $PSScriptRoot $service))
    Invoke-Checked 'podman' @('save', '--output', (Join-Path $release "$service.tar"), $image)
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($name in @('compose.yaml', 'remote-deploy.sh')) {
    $content = [IO.File]::ReadAllText((Join-Path $PSScriptRoot "deploy/$name")).Replace("`r`n", "`n")
    [IO.File]::WriteAllText((Join-Path $release $name), $content, $utf8)
}
[IO.File]::WriteAllText((Join-Path $release '.env'), "ATELIER_VERSION=$version`nAPP_BIND=0.0.0.0`nAPP_PORT=$AppPort`n", $utf8)
$remote = "$RemoteDirectory/releases/$version"
Invoke-Checked 'ssh' ($sshArgs + @($target, "mkdir -p '$remote'"))
foreach ($name in @('backend.tar', 'frontend.tar', 'compose.yaml', 'remote-deploy.sh', '.env')) {
    Invoke-Checked 'scp' ($scpArgs + @((Join-Path $release $name), "${target}:$remote/$name"))
}
Invoke-Checked 'ssh' ($sshArgs + @($target, "sh '$remote/remote-deploy.sh' '$version'"))
Write-Host "Application disponible : http://${Server}:$AppPort"
