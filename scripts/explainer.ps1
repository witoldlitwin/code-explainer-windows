# Helper for Claude to communicate with the Code Explainer VS Code extension (Windows).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File explainer.ps1 <cmd> [args]
#
#   health                      GET /api/health (exit 0 if OK, 1 otherwise)
#   tempdir                     Create a unique empty temp dir and print its path
#   plan <json_file>            Send walkthrough plan from file
#   send '<json>'               Send raw JSON message
#   assemble <dir> <title>      Build walkthrough-plan.json from <dir>\segment-*.json and send it
#   state                       Get current walkthrough state
#   wait-action [timeout]       Wait for user action (default 30s)
#   stop                        Stop the walkthrough
#   save [name]                 Save current walkthrough
#   load <name>                 Load a saved walkthrough
#   list                        List saved walkthroughs
#   highlight <file> <start> <end>  Fallback highlight (no sidebar): writes the editor's highlight file
#   editor                      Print which editor this script talks to
#
# Target editor (each editor writes its own ~\.claude-explainer-port-<editor> file):
#   1. $env:CLAUDE_EXPLAINER_EDITOR      e.g. vscode, vscode-insiders, cursor
#   2. <skill root>\editor.txt           first line, same values
#   3. the only running editor, if exactly one port file exists

$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
    $json = ConvertTo-Json -Compress -InputObject @{ error = $msg }
    [Console]::Error.WriteLine($json)
    exit 1
}

function Json-String([string]$s) {
    # Escape manually into a JSON string literal.
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $s.ToCharArray()) {
        $c = [int]$ch
        if ($ch -eq '"') { [void]$sb.Append('\"') }
        elseif ($ch -eq '\') { [void]$sb.Append('\\') }
        elseif ($c -eq 8) { [void]$sb.Append('\b') }
        elseif ($c -eq 9) { [void]$sb.Append('\t') }
        elseif ($c -eq 10) { [void]$sb.Append('\n') }
        elseif ($c -eq 12) { [void]$sb.Append('\f') }
        elseif ($c -eq 13) { [void]$sb.Append('\r') }
        elseif ($c -lt 32) { [void]$sb.Append(('\u{0:x4}' -f $c)) }
        else { [void]$sb.Append($ch) }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$cmd = if ($args.Count -ge 1) { [string]$args[0] } else { '' }
$arg1 = if ($args.Count -ge 2) { [string]$args[1] } else { '' }
$arg2 = if ($args.Count -ge 3) { [string]$args[2] } else { '' }

# Commands that need no server
if ($cmd -eq 'tempdir') {
    $d = Join-Path $env:TEMP ('explainer-' + [guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $d)
    Write-Output $d
    exit 0
}

function Resolve-Editor {
    if ($env:CLAUDE_EXPLAINER_EDITOR) { return $env:CLAUDE_EXPLAINER_EDITOR.Trim() }
    $cfg = Join-Path (Split-Path $PSScriptRoot -Parent) 'editor.txt'
    if (Test-Path -LiteralPath $cfg) {
        $v = ([IO.File]::ReadAllText($cfg) -split "`r?`n")[0].Trim()
        if ($v) { return $v }
    }
    $prefix = '.claude-explainer-port-'
    $found = @(Get-ChildItem -LiteralPath $env:USERPROFILE -Filter "$prefix*" -File -Force -ErrorAction SilentlyContinue)
    if ($found.Count -eq 1) { return $found[0].Name.Substring($prefix.Length) }
    if ($found.Count -gt 1) {
        $names = ($found | ForEach-Object { $_.Name.Substring($prefix.Length) }) -join ', '
        Fail "Several editors are running ($names). Set CLAUDE_EXPLAINER_EDITOR or write the editor name to <skill>\editor.txt"
    }
    Fail 'Code Explainer extension not running (no port file)'
}

$Editor = Resolve-Editor
if ($Editor -notmatch '^[A-Za-z0-9-]+$') { Fail "Invalid editor name: $Editor" }

if ($cmd -eq 'editor') { Write-Output $Editor; exit 0 }

if ($cmd -eq 'highlight') {
    $s = 0; $e = 0
    if (-not $arg1 -or -not [int]::TryParse($arg2, [ref]$s) -or -not [int]::TryParse([string]$args[3], [ref]$e)) {
        [Console]::Error.WriteLine('Usage: explainer.ps1 highlight <file> <start> <end>'); exit 1
    }
    $hl = '{"file":' + (Json-String $arg1) + ',"start":' + $s + ',"end":' + $e + '}'
    [IO.File]::WriteAllText((Join-Path $env:USERPROFILE ".claude-highlight-$Editor.json"), $hl, $utf8NoBom)
    Write-Output '{"status":"ok"}'
    exit 0
}

$PortFile = Join-Path $env:USERPROFILE ".claude-explainer-port-$Editor"
$TokenFile = Join-Path $env:USERPROFILE ".claude-explainer-token-$Editor"

# assemble: build the plan file first (works offline)
$assembledFile = $null
if ($cmd -eq 'assemble') {
    if (-not $arg1 -or -not $arg2) { [Console]::Error.WriteLine('Usage: explainer.ps1 assemble <dir> <title>'); exit 1 }
    if (-not (Test-Path -LiteralPath $arg1 -PathType Container)) { Fail "Directory not found: $arg1" }
    $files = Get-ChildItem -LiteralPath $arg1 -Filter 'segment-*.json' -File |
        Where-Object { $_.Name -match '^segment-(\d+)\.json$' } |
        Sort-Object { [int]([regex]::Match($_.Name, '^segment-(\d+)\.json$').Groups[1].Value) }
    if (-not $files) { Fail "No segment-*.json files in $arg1" }
    $parts = @()
    foreach ($f in $files) {
        $t = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8).Trim([char]0xFEFF, ' ', "`t", "`r", "`n")
        $parts += $t
    }
    $plan = '{"type":"set_plan","title":' + (Json-String $arg2) + ',"segments":[' + ($parts -join ',') + ']}'
    $assembledFile = Join-Path $arg1 'walkthrough-plan.json'
    [IO.File]::WriteAllText($assembledFile, $plan, $utf8NoBom)
}

if (-not (Test-Path -LiteralPath $PortFile)) { Fail "Code Explainer extension not running in '$Editor' (no port file)" }
$Port = ([IO.File]::ReadAllText($PortFile)).Trim()
$Base = "http://127.0.0.1:$Port"

if (-not (Test-Path -LiteralPath $TokenFile)) { Fail 'No auth token found' }
$Token = ([IO.File]::ReadAllText($TokenFile)).Trim()
$Headers = @{ Authorization = "Bearer $Token" }

function Invoke-Api([string]$Method, [string]$Path, [string]$Body, [int]$TimeoutSec = 30) {
    try {
        if ($Method -eq 'POST') {
            $bytes = $utf8NoBom.GetBytes($Body)
            $r = Invoke-WebRequest -UseBasicParsing -Uri ($Base + $Path) -Method Post -Headers $Headers `
                -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec $TimeoutSec
        } else {
            $r = Invoke-WebRequest -UseBasicParsing -Uri ($Base + $Path) -Method Get -Headers $Headers -TimeoutSec $TimeoutSec
        }
        $content = $r.Content
        if ($content -is [byte[]]) { $content = $utf8NoBom.GetString($content) }
        Write-Output $content
    } catch {
        $msg = $_.Exception.Message
        $resp = $_.Exception.Response
        if ($resp) {
            try {
                $sr = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
                $b = $sr.ReadToEnd()
                if ($b) { [Console]::Error.WriteLine($b); exit 1 }
            } catch {}
        }
        Fail $msg
    }
}

switch ($cmd) {
    'health' {
        Invoke-Api 'GET' '/api/health' '' 10
    }
    'plan' {
        if (-not $arg1) { [Console]::Error.WriteLine('Usage: explainer.ps1 plan <json_file>'); exit 1 }
        if (-not (Test-Path -LiteralPath $arg1)) { Fail "File not found: $arg1" }
        $body = [IO.File]::ReadAllText($arg1, [Text.Encoding]::UTF8)
        Invoke-Api 'POST' '/api/message' $body
    }
    'assemble' {
        $body = [IO.File]::ReadAllText($assembledFile, [Text.Encoding]::UTF8)
        Invoke-Api 'POST' '/api/message' $body
    }
    'send' {
        if (-not $arg1) { [Console]::Error.WriteLine("Usage: explainer.ps1 send '<json>'"); exit 1 }
        Invoke-Api 'POST' '/api/message' $arg1
    }
    'state' {
        Invoke-Api 'GET' '/api/state' ''
    }
    'wait-action' {
        $timeout = 30
        if ($arg1) {
            $n = 0
            if (-not [int]::TryParse($arg1, [ref]$n)) { Fail "Invalid timeout: $arg1" }
            $timeout = $n
        }
        Invoke-Api 'GET' "/api/actions?timeout=$timeout" '' ($timeout + 5)
    }
    'stop' {
        Invoke-Api 'POST' '/api/message' '{"type": "stop"}'
    }
    'save' {
        if ($arg1) {
            $body = ConvertTo-Json -Compress -InputObject @{ name = $arg1 }
        } else {
            $body = '{}'
        }
        Invoke-Api 'POST' '/api/save' $body
    }
    'load' {
        if (-not $arg1) { [Console]::Error.WriteLine('Usage: explainer.ps1 load <name>'); exit 1 }
        $body = ConvertTo-Json -Compress -InputObject @{ name = $arg1 }
        Invoke-Api 'POST' '/api/load' $body
    }
    'list' {
        Invoke-Api 'GET' '/api/walkthroughs' ''
    }
    default {
        [Console]::Error.WriteLine('Usage: explainer.ps1 {health|tempdir|plan|send|assemble|state|wait-action|stop|save|load|list|highlight|editor}')
        exit 1
    }
}
exit 0
