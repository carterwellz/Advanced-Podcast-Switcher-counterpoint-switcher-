<#
  Counterpoint Switcher installer.

  Run from the repo root, with Premiere Pro closed:

      powershell -ExecutionPolicy Bypass -File .\install.ps1

  To remove:

      powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall

  Nothing here needs administrator rights. The extension folder is a junction, not a
  symlink, precisely so that stays true.
#>

[CmdletBinding()]
param(
    [switch]$Uninstall,
    # Skip npm install and npm run build. Only useful when re-linking a repo you have
    # already built.
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$RepoRoot     = Split-Path -Parent $MyInvocation.MyCommand.Path
$CepSource    = Join-Path $RepoRoot 'cep'
$ExtensionsIn = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$LinkPath     = Join-Path $ExtensionsIn 'CounterpointSwitcher'
$CsxsVersions = 9, 10, 11, 12

function Write-Step  ($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok    ($m) { Write-Host "    OK   $m" -ForegroundColor Green }
function Write-Warn2 ($m) { Write-Host "    WARN $m" -ForegroundColor Yellow }
function Write-Fail  ($m) { Write-Host "    FAIL $m" -ForegroundColor Red }

function Test-PremiereRunning {
    $p = Get-Process -Name 'Adobe Premiere Pro' -ErrorAction SilentlyContinue
    return $null -ne $p
}

# ---------------------------------------------------------------- uninstall

if ($Uninstall) {
    Write-Step "Removing the Counterpoint Switcher extension link"

    if (Test-Path $LinkPath) {
        $item = Get-Item $LinkPath -Force
        # Only ever remove a link. If someone has copied real files in there, deleting
        # the folder outright would destroy work that is not ours to destroy.
        if ($item.LinkType) {
            # Remove-Item -Recurse on a junction can follow it and delete the target's
            # contents on older PowerShell hosts. Directory.Delete with recursive:$false
            # removes the reparse point itself and never walks through it.
            [System.IO.Directory]::Delete($LinkPath, $false)
            Write-Ok "Removed $LinkPath"
        }
        else {
            Write-Warn2 "$LinkPath is a real folder, not a link. Leaving it alone."
            Write-Warn2 "Delete it by hand if you are sure."
        }
    }
    else {
        Write-Ok "Nothing installed at $LinkPath"
    }

    Write-Step "Done"
    Write-Host "    PlayerDebugMode was left set. It is harmless and other unsigned"
    Write-Host "    extensions may rely on it."
    Write-Host ""
    exit 0
}

# ---------------------------------------------------------------- checks

Write-Step "Checking prerequisites"

if (Test-PremiereRunning) {
    Write-Warn2 "Premiere Pro is running."
    Write-Warn2 "The install will still work, but you must fully quit and reopen"
    Write-Warn2 "Premiere before the panel appears."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Fail "Node.js was not found on PATH."
    Write-Host ""
    Write-Host "    Install the LTS build from https://nodejs.org, then open a NEW"
    Write-Host "    terminal and run this script again."
    Write-Host ""
    exit 1
}
$nodeVersion = (& node -v).Trim()
$nodeMajor = [int]($nodeVersion -replace '^v(\d+)\..*$', '$1')
if ($nodeMajor -lt 18) {
    Write-Fail "Node $nodeVersion is too old. Version 18 or newer is required."
    exit 1
}
Write-Ok "Node $nodeVersion at $($node.Source)"

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Fail "npm was not found on PATH, though node was. Reinstall Node.js."
    exit 1
}

# ffmpeg is resolved at runtime by src/core/ffmpeg.ts, which searches PATH, CPSW_FFMPEG
# and the usual package manager locations. This check mirrors that so a missing ffmpeg is
# reported now rather than in the middle of the first analysis run.
$ffmpegFound = $null
$ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ffmpegCmd) {
    $ffmpegFound = $ffmpegCmd.Source
}
elseif ($env:CPSW_FFMPEG -and (Test-Path $env:CPSW_FFMPEG)) {
    $ffmpegFound = $env:CPSW_FFMPEG
}
else {
    $guesses = @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ffmpeg.exe'),
        (Join-Path $env:USERPROFILE  'scoop\shims\ffmpeg.exe'),
        (Join-Path $env:ProgramData  'chocolatey\bin\ffmpeg.exe'),
        (Join-Path $env:ProgramFiles 'ffmpeg\bin\ffmpeg.exe'),
        'C:\ffmpeg\bin\ffmpeg.exe'
    )
    foreach ($g in $guesses) {
        if ($g -and (Test-Path $g)) { $ffmpegFound = $g; break }
    }
    if (-not $ffmpegFound) {
        $wingetPkgs = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
        if (Test-Path $wingetPkgs) {
            $hit = Get-ChildItem $wingetPkgs -Filter '*FFmpeg*' -Directory -ErrorAction SilentlyContinue |
                   ForEach-Object { Get-ChildItem $_.FullName -Recurse -Filter 'ffmpeg.exe' -ErrorAction SilentlyContinue } |
                   Select-Object -First 1
            if ($hit) { $ffmpegFound = $hit.FullName }
        }
    }
}

if ($ffmpegFound) {
    Write-Ok "ffmpeg at $ffmpegFound"
}
else {
    Write-Warn2 "ffmpeg was not found."
    Write-Warn2 "Install it with:  winget install Gyan.FFmpeg"
    Write-Warn2 "Then open a new terminal and confirm 'ffmpeg -version' works."
    Write-Warn2 "Installation will continue, but the panel cannot analyse audio without it."
}

# ---------------------------------------------------------------- build

if (-not $SkipBuild) {
    Write-Step "Installing dependencies (npm install)"
    Push-Location $RepoRoot
    try {
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
        Write-Ok "Dependencies installed"

        Write-Step "Building the engine (npm run build)"
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }

    # The panel spawns dist/cli/run-plan.js by absolute path, so verify it landed rather
    # than trusting the exit code alone.
    $engine = Join-Path $RepoRoot 'dist\cli\run-plan.js'
    if (-not (Test-Path $engine)) {
        Write-Fail "Build reported success but $engine does not exist."
        exit 1
    }
    Write-Ok "Engine built at dist\cli\run-plan.js"
}
else {
    Write-Step "Skipping build (-SkipBuild)"
}

# ---------------------------------------------------------------- PlayerDebugMode

Write-Step "Enabling unsigned extensions (PlayerDebugMode)"

# Premiere refuses to load an extension that is not signed unless this is set. It is a
# per-user setting under HKCU, so no administrator rights are needed. Which CSXS version
# applies depends on the Premiere build, so all the plausible ones are set.
foreach ($v in $CsxsVersions) {
    $key = "HKCU:\SOFTWARE\Adobe\CSXS.$v"
    try {
        if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
        # Deliberately a string, not a DWORD. CSXS reads it as text and a DWORD is ignored.
        New-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' -PropertyType String -Force | Out-Null
        Write-Ok "CSXS.$v"
    }
    catch {
        Write-Warn2 "Could not set PlayerDebugMode for CSXS.$v : $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------- link

Write-Step "Linking the panel into Premiere's extensions folder"

if (-not (Test-Path $CepSource)) {
    Write-Fail "$CepSource does not exist. Are you running this from the repo root?"
    exit 1
}

if (-not (Test-Path $ExtensionsIn)) {
    New-Item -ItemType Directory -Path $ExtensionsIn -Force | Out-Null
    Write-Ok "Created $ExtensionsIn"
}

if (Test-Path $LinkPath) {
    $existing = Get-Item $LinkPath -Force
    if ($existing.LinkType) {
        [System.IO.Directory]::Delete($LinkPath, $false)
        Write-Ok "Replaced the previous link"
    }
    else {
        Write-Fail "$LinkPath already exists and is a real folder, not a link."
        Write-Host  "    Move or delete it, then run this script again."
        exit 1
    }
}

New-Item -ItemType Junction -Path $LinkPath -Target $CepSource | Out-Null
Write-Ok "$LinkPath -> $CepSource"

# ---------------------------------------------------------------- done

Write-Step "Installed"
Write-Host ""
Write-Host "    Start Premiere Pro, then open:"
Write-Host "        Window > Extensions > Counterpoint Switcher" -ForegroundColor White
Write-Host ""
if (Test-PremiereRunning) {
    Write-Host "    Premiere is currently running. Quit it fully and reopen it first." -ForegroundColor Yellow
    Write-Host ""
}
Write-Host "    Open your sequence BEFORE opening the panel, then press Refresh."
Write-Host "    See README.md for the full walkthrough."
Write-Host ""
