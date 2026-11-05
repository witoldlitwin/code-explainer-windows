# Setup (one-time)

Run the setup script — it handles everything:

```powershell
cd "$HOME\.claude\skills\explainer"
.\setup.ps1
# or: powershell -ExecutionPolicy Bypass -File setup.ps1
```

This will:
1. Check prerequisites (Windows 11, Python 3.10+, Node.js, VS Code or Cursor)
2. Ask your model preferences — shows the default `LARGE`/`MEDIUM`/`SMALL` models and lets you swap them for any model your agent supports (GPT-4o, Gemini, local models, etc.)
3. Create a Python venv and install TTS engine (kokoro-onnx + ONNX Runtime, CPU)
4. Build and install the `code-explainer` extension (VS Code + Cursor)
5. Download the TTS model files (~330 MB) into `<skill>\models\`

After setup, reload your editor: `Ctrl+Shift+P` → "Developer: Reload Window".

**Requirements:** Windows 11, VS Code or Cursor with the CLI on PATH, Node.js (`winget install OpenJS.NodeJS.LTS`), Python 3.10+ (`winget install Python.Python.3.13`), optionally uv.
