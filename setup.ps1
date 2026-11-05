# ============================================================================
# Code Explainer - Setup Script (Windows 11, Windows PowerShell 5.1+)
# ============================================================================
# Interactive code walkthrough skill with VS Code highlighting and TTS
# (kokoro-onnx, CPU).
#
# Usage:   .\setup.ps1
#
# If script execution is blocked, either run once:
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
# or run the script with a one-off bypass:
#   powershell -ExecutionPolicy Bypass -File setup.ps1
# ============================================================================

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvDir   = Join-Path $ScriptDir '.venv'
$ExtDir    = Join-Path $ScriptDir 'vscode-extension'
$ModelsDir = Join-Path $ScriptDir 'models'
$SkillFile = Join-Path $ScriptDir 'SKILL.md'
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'

$ModelBase = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
$ModelFile  = Join-Path $ModelsDir 'kokoro-v1.0.onnx'
$VoicesFile = Join-Path $ModelsDir 'voices-v1.0.bin'

$script:step = 0
$TotalSteps = 7

function Header($msg) {
    $script:step++
    Write-Host ''
    Write-Host "[$($script:step)/$TotalSteps] " -ForegroundColor Blue -NoNewline
    Write-Host $msg -ForegroundColor White
}
function Ok($msg)   { Write-Host '  [OK] ' -ForegroundColor Green -NoNewline; Write-Host $msg }
function Warn($msg) { Write-Host '  [!]  ' -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Fail($msg) { Write-Host '  [X]  ' -ForegroundColor Red -NoNewline; Write-Host $msg; exit 1 }

function Assert-Native($what) {
    if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE)" }
}

Write-Host ''
Write-Host '==============================================' -ForegroundColor White
Write-Host '   Code Explainer - Setup (Windows)' -ForegroundColor White
Write-Host '==============================================' -ForegroundColor White

# -- Step 1: Check prerequisites ---------------------------------------------
Header 'Checking prerequisites'

# Windows check
$build = [Environment]::OSVersion.Version.Build
if ($env:OS -ne 'Windows_NT') { Fail 'This script requires Windows.' }
if ($build -ge 22000) {
    Ok "Windows 11 detected (build $build)"
} else {
    Warn "Windows build $build is older than Windows 11 (22000) - this port targets Windows 11 and may not work"
}

# Editor CLI check (VS Code or Cursor)
$Editors = @()   # list of @{ Name=..; Cmd=.. }
$codeCmd = Get-Command code -ErrorAction SilentlyContinue | Select-Object -First 1
if ($codeCmd) {
    $Editors += @{ Name = 'code'; Cmd = $codeCmd.Source }
    Ok "VS Code CLI found: $($codeCmd.Source)"
}
$cursorCmd = Get-Command cursor -ErrorAction SilentlyContinue | Select-Object -First 1
if ($cursorCmd) {
    $Editors += @{ Name = 'cursor'; Cmd = $cursorCmd.Source }
    Ok "Cursor CLI found: $($cursorCmd.Source)"
}
if ($Editors.Count -eq 0) {
    Fail "No editor CLI found. Install VS Code or Cursor; for VS Code, reinstall and tick 'Add to PATH' so the 'code' command is available."
}

# Node.js / npm
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) { Ok "Node.js found: $(& node --version)" }
else { Fail 'Node.js not found. Install via: winget install OpenJS.NodeJS.LTS (then open a new terminal)' }

$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if ($npmCmd) { Ok "npm found: $(& npm --version)" }
else { Fail 'npm not found. Install via: winget install OpenJS.NodeJS.LTS (then open a new terminal)' }

# Python 3.10+ check. Try the py launcher first, then python.
# The Microsoft Store "python.exe" alias stub exists on PATH but does not run,
# so every candidate must actually run and print a version.
function Get-PythonInfo($exe, $prefixArgs) {
    try {
        $out = & $exe @prefixArgs -c "import sys; print('%d.%d' % sys.version_info[:2]); print(sys.executable)" 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        $lines = @($out | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
        if ($lines.Count -lt 2 -or $lines[0] -notmatch '^(\d+)\.(\d+)$') { return $null }
        $major = [int]$Matches[1]; $minor = [int]$Matches[2]
        if ($major -gt 3 -or ($major -eq 3 -and $minor -ge 10)) {
            return @{ Version = $lines[0]; Path = $lines[1] }
        }
    } catch { }
    return $null
}

$Python = $null
$PyVersion = $null
foreach ($cand in @(@{ Exe = 'py'; Args = @('-3') }, @{ Exe = 'python'; Args = @() })) {
    if (-not (Get-Command $cand.Exe -ErrorAction SilentlyContinue)) { continue }
    $info = Get-PythonInfo $cand.Exe $cand.Args
    if ($info) { $Python = $info.Path; $PyVersion = $info.Version; break }
}
if ($Python) { Ok "Python $PyVersion found: $Python" }
else { Fail 'Python 3.10+ not found (the Microsoft Store python alias does not count). Install via: winget install Python.Python.3.13 (then open a new terminal)' }

# uv (preferred) or pip fallback
$UseUv = $false
if (Get-Command uv -ErrorAction SilentlyContinue) {
    Ok 'uv found (fast package manager)'
    $UseUv = $true
} else {
    Warn 'uv not found - using pip (slower). Install uv for faster setup: winget install astral-sh.uv'
}

# -- Step 2: Configure AI models ---------------------------------------------
Header 'Configure AI models'

$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
$skillText = [IO.File]::ReadAllText($SkillFile, [Text.Encoding]::UTF8)

function Get-Current($tier, $default, $text) {
    $m = [regex]::Match($text, '\| `' + $tier + '` \| `([^`]+)`')
    if ($m.Success) { return $m.Groups[1].Value } else { return $default }
}
function Sanitize($val) {
    # Strip characters that would corrupt the markdown table.
    return ($val.Replace('`', '').Replace('|', '').Replace("`r", '').Replace("`n", '')).Trim()
}

$CurLarge  = Get-Current 'LARGE'  'opus'   $skillText
$CurMedium = Get-Current 'MEDIUM' 'sonnet' $skillText
$CurSmall  = Get-Current 'SMALL'  'haiku'  $skillText

Write-Host ''
Write-Host '  Default model configuration:'
Write-Host '    LARGE  ' -NoNewline; Write-Host '- planner (best reasoning)    : ' -NoNewline; Write-Host $CurLarge -ForegroundColor Blue
Write-Host '    MEDIUM ' -NoNewline; Write-Host '- segment agents (deep reading): ' -NoNewline; Write-Host $CurMedium -ForegroundColor Blue
Write-Host '    SMALL  ' -NoNewline; Write-Host '- scout + overview (fast)      : ' -NoNewline; Write-Host $CurSmall -ForegroundColor Blue
Write-Host ''
Write-Host '  Use any model name your agent supports (e.g. gpt-4o, gemini-2.5-pro).'
$keep = Read-Host '  Keep these defaults? [Y/n]'

if ($keep -match '^[Nn]') {
    Write-Host ''
    $newLarge  = Read-Host "  LARGE  [$CurLarge]"
    $newMedium = Read-Host "  MEDIUM [$CurMedium]"
    $newSmall  = Read-Host "  SMALL  [$CurSmall]"

    $newLarge  = Sanitize ("$newLarge")
    $newMedium = Sanitize ("$newMedium")
    $newSmall  = Sanitize ("$newSmall")
    # Fall back to current value if the user pressed Enter
    if (-not $newLarge)  { $newLarge  = $CurLarge }
    if (-not $newMedium) { $newMedium = $CurMedium }
    if (-not $newSmall)  { $newSmall  = $CurSmall }

    # Use MatchEvaluator-free replacement: escape '$' so user input is literal.
    $esc = { param($s) $s.Replace('$', '$$') }
    $skillText = [regex]::Replace($skillText, '(\| `LARGE` \| )`[^`]+`',  '${1}`' + (& $esc $newLarge)  + '`')
    $skillText = [regex]::Replace($skillText, '(\| `MEDIUM` \| )`[^`]+`', '${1}`' + (& $esc $newMedium) + '`')
    $skillText = [regex]::Replace($skillText, '(\| `SMALL` \| )`[^`]+`',  '${1}`' + (& $esc $newSmall)  + '`')
    [IO.File]::WriteAllText($SkillFile, $skillText, $Utf8NoBom)

    Ok 'Models saved to SKILL.md'
    Write-Host '    LARGE  -> ' -NoNewline; Write-Host $newLarge -ForegroundColor Green
    Write-Host '    MEDIUM -> ' -NoNewline; Write-Host $newMedium -ForegroundColor Green
    Write-Host '    SMALL  -> ' -NoNewline; Write-Host $newSmall -ForegroundColor Green
} else {
    Ok 'Using default models'
}

# -- Step 3: Create Python virtual environment -------------------------------
Header 'Setting up Python environment for TTS'

if (Test-Path $VenvPython) {
    Ok "Virtual environment already exists at $VenvDir"
} else {
    if ($UseUv) {
        & uv venv $VenvDir --python $Python
        Assert-Native 'uv venv'
    } else {
        & $Python -m venv $VenvDir
        Assert-Native 'python -m venv'
    }
    if (-not (Test-Path $VenvPython)) { Fail "Virtual environment was not created at $VenvDir" }
    Ok "Created virtual environment at $VenvDir"
}

# -- Step 4: Install TTS dependencies ----------------------------------------
Header 'Installing TTS dependencies (kokoro-onnx + soundfile)'
Write-Host '  This may take a few minutes on first install...'

if ($UseUv) {
    & uv pip install --python $VenvPython pip kokoro-onnx soundfile
    Assert-Native 'uv pip install'
} else {
    & $VenvPython -m pip install --quiet kokoro-onnx soundfile
    Assert-Native 'pip install'
}
Ok 'TTS dependencies installed'

& $VenvPython -c "import kokoro_onnx; print('ok')" | Out-Null
if ($LASTEXITCODE -eq 0) { Ok 'TTS engine (kokoro_onnx) verified' }
else { Fail 'import kokoro_onnx failed in the virtual environment' }

# -- Step 5: Build and install VS Code extension -----------------------------
Header 'Building and installing extension'

Push-Location $ExtDir
try {
    & npm install --silent
    Assert-Native 'npm install'
    Ok 'npm dependencies installed'

    & npm run compile --silent
    Assert-Native 'npm run compile'
    Ok 'TypeScript compiled'

    & npx --yes @vscode/vsce package --no-dependencies --allow-star-activation --allow-missing-repository
    Assert-Native 'vsce package'

    $vsix = Get-ChildItem -Path $ExtDir -Filter '*.vsix' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $vsix) { Fail 'VSIX packaging failed - no .vsix file found' }
    Ok "VSIX packaged: $($vsix.Name)"

    foreach ($ed in $Editors) {
        & $ed.Cmd --install-extension $vsix.FullName --force
        Assert-Native "$($ed.Name) --install-extension"
        Ok "Extension installed in $($ed.Name)"
    }
} finally {
    Pop-Location
}

# -- Step 6: Scripts (nothing to chmod on Windows) ---------------------------
Header 'Setting up scripts'
if (Test-Path (Join-Path $ScriptDir 'scripts\explainer.ps1')) { Ok 'scripts\explainer.ps1 present' }
else { Warn 'scripts\explainer.ps1 not found' }
Ok 'No executable bits needed on Windows'

# -- Step 7: Download TTS model + test synthesis -----------------------------
Header 'Downloading TTS voice model'

if (-not (Test-Path $ModelsDir)) { New-Item -ItemType Directory -Path $ModelsDir | Out-Null }

$ProgressPreference = 'SilentlyContinue'   # progress bar makes Invoke-WebRequest very slow in PS 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$downloads = @(
    @{ Url = "$ModelBase/kokoro-v1.0.onnx"; Path = $ModelFile;  Size = '~310 MB' },
    @{ Url = "$ModelBase/voices-v1.0.bin";  Path = $VoicesFile; Size = '~27 MB' }
)
$modelsOk = $true
foreach ($d in $downloads) {
    $name = Split-Path -Leaf $d.Path
    if ((Test-Path $d.Path) -and (Get-Item $d.Path).Length -gt 0) {
        Ok "$name already present"
        continue
    }
    Write-Host "  Downloading $name ($($d.Size))..."
    $tmp = "$($d.Path).part"
    try {
        Invoke-WebRequest -Uri $d.Url -OutFile $tmp -UseBasicParsing
        Move-Item -Force $tmp $d.Path
        Ok "Downloaded $name ($([math]::Round((Get-Item $d.Path).Length / 1MB, 1)) MB)"
    } catch {
        if (Test-Path $tmp) { Remove-Item -Force $tmp }
        Warn "Download of $name failed: $($_.Exception.Message)"
        $modelsOk = $false
    }
}

if ($modelsOk) {
    $synth = @'
import sys
from kokoro_onnx import Kokoro
k = Kokoro(sys.argv[1], sys.argv[2])
k.create("Setup complete.", voice="af_heart", speed=1.0, lang="en-us")
print("ok")
'@
    $out = & $VenvPython -c $synth $ModelFile $VoicesFile
    if ($LASTEXITCODE -eq 0 -and ("$out" -match 'ok')) { Ok 'Test synthesis succeeded' }
    else { Warn 'Test synthesis failed - TTS may not work until this is resolved' }
} else {
    Warn 'Model files missing - skipping test synthesis. Re-run setup.ps1 to retry.'
}

# -- Done --------------------------------------------------------------------
Write-Host ''
Write-Host '==============================================' -ForegroundColor Green
Write-Host '   Setup complete!' -ForegroundColor Green
Write-Host '==============================================' -ForegroundColor Green
Write-Host ''
Write-Host '  Skill installed at: ' -NoNewline; Write-Host $ScriptDir
Write-Host ''
Write-Host '  Next steps:'
Write-Host '  1. Reload your editor: ' -NoNewline
Write-Host "Ctrl+Shift+P -> 'Developer: Reload Window'" -ForegroundColor Blue

$home_ = $env:USERPROFILE
$agentDefs = @(
    @{ Name = 'Claude Code'; Root = Join-Path $home_ '.claude';           Skills = '.claude\skills\explainer';           Dest = '$env:USERPROFILE\.claude\skills\explainer' },
    @{ Name = 'Amp';         Root = Join-Path $home_ '.config\agents';    Skills = '.config\agents\skills\explainer';    Dest = '$env:USERPROFILE\.config\agents\skills\explainer' },
    @{ Name = 'OpenCode';    Root = Join-Path $home_ '.config\opencode';  Skills = '.config\opencode\skills\explainer';  Dest = '$env:USERPROFILE\.config\opencode\skills\explainer' },
    @{ Name = 'Codex CLI';   Root = Join-Path $home_ '.codex';            Skills = '.codex\skills\explainer';            Dest = '$env:USERPROFILE\.codex\skills\explainer' }
)
$detected = @($agentDefs | Where-Object { (Test-Path $_.Root) -or ($ScriptDir -like "*\$($_.Skills.Replace('\explainer',''))\*") })

$inSkillsDir = $ScriptDir -like '*\skills\explainer*'
if ($inSkillsDir) {
    Write-Host '  2. Use it: ' -NoNewline; Write-Host '/explainer <feature name>' -ForegroundColor Blue
} else {
    Write-Host "  2. Copy the skill to your agent's skills directory:"
    Write-Host ''
    $show = if ($detected.Count -gt 0) { $detected } else { $agentDefs }
    foreach ($a in $show) {
        Write-Host ("     {0,-12}" -f "$($a.Name):") -NoNewline
        Write-Host "Copy-Item -Recurse `"$ScriptDir`" `"$($a.Dest)`"" -ForegroundColor Blue
    }
    Write-Host ''
    Write-Host '     For rule-based agents (Cursor, Windsurf, Kilo, Roo, Cline),'
    Write-Host '     copy ' -NoNewline; Write-Host 'SKILL.md' -ForegroundColor Blue -NoNewline; Write-Host " into your agent's rules directory."
    Write-Host '     See the README for details.'
    Write-Host ''
    Write-Host '  3. Use it: ' -NoNewline; Write-Host '/explainer <feature name>' -ForegroundColor Blue
}
Write-Host ''
Write-Host '  Modes:'
Write-Host '  * ' -NoNewline; Write-Host 'Walkthrough' -ForegroundColor Green -NoNewline; Write-Host '  - highlights + voice narration play automatically'
Write-Host '  * ' -NoNewline; Write-Host 'Read       ' -ForegroundColor Green -NoNewline; Write-Host '  - text explanations in terminal'
Write-Host '  * ' -NoNewline; Write-Host 'Podcast    ' -ForegroundColor Green -NoNewline; Write-Host '  - single audio file of entire walkthrough'
Write-Host ''
Write-Host '  Voice config:'
Write-Host '  * Change voice (this session):  ' -NoNewline; Write-Host '$env:TTS_VOICE = ''am_adam''' -ForegroundColor Blue
Write-Host '  * Change voice (persistent):    ' -NoNewline; Write-Host 'setx TTS_VOICE am_adam' -ForegroundColor Blue -NoNewline; Write-Host '  (open a new terminal afterwards)'
Write-Host '  * Change speed: ' -NoNewline; Write-Host '$env:TTS_SPEED = ''1.2''' -ForegroundColor Blue -NoNewline; Write-Host ' (faster)'
Write-Host '  * Available: af_heart, af_bella, af_sarah, am_adam, am_michael, bf_emma, bm_george'
Write-Host ''
