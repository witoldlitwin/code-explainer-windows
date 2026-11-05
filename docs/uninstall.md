# Uninstalling Code Explainer

This guide walks you through completely removing Code Explainer from your system. Each step includes a verification check so you can confirm the removal was successful. All commands are for PowerShell.

---

## Step 1: Stop Running Processes

Stop the TTS server if it's running.

```powershell
# Stop TTS server
$pidFile = "$env:USERPROFILE\.claude-explainer\tts-server.pid"
if (Test-Path $pidFile) {
    Stop-Process -Id ([int](Get-Content $pidFile)) -Force -ErrorAction SilentlyContinue
    Write-Host "TTS server stopped"
} else {
    Write-Host "TTS server not running"
}
```

**Verify:**

```powershell
# Should print "No TTS process found"
$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*tts_server.py*' }
if ($procs) { Write-Host "WARNING: TTS server still running" } else { Write-Host "No TTS process found" }
```

---

## Step 2: Uninstall the VS Code / Cursor Extension

```powershell
# VS Code
code --uninstall-extension srujangurram.code-explainer

# Cursor
cursor --uninstall-extension srujangurram.code-explainer
```

(An error such as "extension not installed" simply means it was not installed in that editor.)

**Verify:**

```powershell
# Should NOT list code-explainer
if (code --list-extensions | Select-String -Pattern code-explainer) { "VS Code: WARNING still installed" } else { "VS Code: clean" }
if (cursor --list-extensions | Select-String -Pattern code-explainer) { "Cursor: WARNING still installed" } else { "Cursor: clean" }
```

After uninstalling, reload your editor: **Ctrl+Shift+P** → **Developer: Reload Window**

---

## Step 3: Remove the Skill Directory

This removes the skill files, Python virtual environment, and TTS model files.

```powershell
Remove-Item -Recurse -Force "$HOME\.claude\skills\explainer"
```

**Verify:**

```powershell
if (Test-Path "$HOME\.claude\skills\explainer") { "WARNING: directory still exists" } else { "Skill directory removed" }
```

---

## Step 4: Clean Up Runtime Files

Remove files created during use.

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.claude-explainer" -ErrorAction SilentlyContinue
Remove-Item -Force "$env:USERPROFILE\.claude-explainer-port-*", "$env:USERPROFILE\.claude-explainer-token-*", "$env:USERPROFILE\.claude-highlight-*.json" -ErrorAction SilentlyContinue
```

**Verify:**

```powershell
foreach ($f in "$env:USERPROFILE\.claude-explainer", "$env:USERPROFILE\.claude-explainer-port-*", "$env:USERPROFILE\.claude-explainer-token-*", "$env:USERPROFILE\.claude-highlight-*.json") {
    if (Test-Path $f) { "WARNING: $f still exists" } else { "$f removed" }
}
```

---

## All-in-One Script

To remove everything in one go, run this from PowerShell:

```powershell
Write-Host "Uninstalling Code Explainer..."

# 1. Stop TTS server
$pidFile = "$env:USERPROFILE\.claude-explainer\tts-server.pid"
if (Test-Path $pidFile) {
    Stop-Process -Id ([int](Get-Content $pidFile)) -Force -ErrorAction SilentlyContinue
    Write-Host "  Stopped TTS server"
}

# 2. Uninstall extension
code --uninstall-extension srujangurram.code-explainer
cursor --uninstall-extension srujangurram.code-explainer

# 3. Remove skill directory
Remove-Item -Recurse -Force "$HOME\.claude\skills\explainer" -ErrorAction SilentlyContinue
Write-Host "  Removed skill directory"

# 4. Clean up runtime files
Remove-Item -Recurse -Force "$env:USERPROFILE\.claude-explainer" -ErrorAction SilentlyContinue
Remove-Item -Force "$env:USERPROFILE\.claude-explainer-port-*", "$env:USERPROFILE\.claude-explainer-token-*", "$env:USERPROFILE\.claude-highlight-*.json" -ErrorAction SilentlyContinue
Write-Host "  Cleaned up runtime files"

Write-Host ""
Write-Host "Done. Reload your editor: Ctrl+Shift+P -> 'Developer: Reload Window'"
```

---

## What Gets Removed

| Component | Location | Size |
|-----------|----------|------|
| Skill files + venv + TTS model | `%USERPROFILE%\.claude\skills\explainer\` | ~500 MB |
| VS Code extension | Editor extensions directory | ~1 MB |
| Port/token/highlight files (one set per editor) | `%USERPROFILE%\.claude-explainer-port-<editor>`, `%USERPROFILE%\.claude-explainer-token-<editor>`, `%USERPROFILE%\.claude-highlight-<editor>.json` | <1 KB |
| TTS runtime files | `%USERPROFILE%\.claude-explainer\` | <1 KB |
