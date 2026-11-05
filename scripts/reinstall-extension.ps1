$ErrorActionPreference = 'Stop'

$extDir = Join-Path $PSScriptRoot '..\vscode-extension'

Push-Location $extDir
try {
    Write-Host 'Building extension...'
    npm run compile -- --minify
    if ($LASTEXITCODE -ne 0) { throw "Build failed (exit code $LASTEXITCODE)" }

    Write-Host 'Packaging extension...'
    npx @vscode/vsce package --no-dependencies
    if ($LASTEXITCODE -ne 0) { throw "Packaging failed (exit code $LASTEXITCODE)" }

    $vsix = Get-ChildItem -Filter *.vsix | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $vsix) { throw 'No .vsix file found after packaging' }

    Write-Host "Installing $($vsix.Name)..."
    code --install-extension $vsix.FullName --force
    if ($LASTEXITCODE -ne 0) { throw "Install failed (exit code $LASTEXITCODE)" }

    $arrow = [char]0x2192
    Write-Host "Done. Reload VS Code (Ctrl+Shift+P $arrow Developer: Reload Window) to pick up changes."
}
catch {
    Write-Error $_
    exit 1
}
finally {
    Pop-Location
}
