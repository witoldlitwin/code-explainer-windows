<p align="center">
  <img src="vscode-extension/media/icon.png" width="120" height="120" alt="Code Explainer icon" />
</p>

<h1 align="center">Code Explainer</h1>

<p align="center">
  <strong>✨ Interactive code walkthroughs with editor highlighting and AI-powered voice narration.</strong>
</p>

<p align="center">
  A coding agent skill that scans your codebase, builds a walkthrough plan, and explains code segment-by-segment — highlighting lines in VS Code / Cursor with a dedicated sidebar panel and narrating with natural-sounding local TTS. Works with Claude Code, Codex, OpenCode, Kilo Code, Amp, and more.
</p>

<p align="center">
  <img src="docs/cover.png" alt="Code Explainer cover" width="100%" />
</p>

<p align="center">
  <a href="https://youtu.be/3eX4hGW9ym8">🎬 Watch Demo</a> &nbsp;·&nbsp;
  <a href="https://srujangurram.me/blog/code-explainer">📝 Read Writeup</a>
</p>

---

## 🚀 Features

- 🪟 **VS Code Sidebar** — Dedicated sidebar panel with walkthrough controls, segment navigation, and live explanation display
- 🎯 **Code Highlighting** — Automatically opens files, scrolls to code, and highlights 1–8 line ranges with per-highlight explanations
- 🔊 **Local TTS** — Natural-sounding voice narration powered by Kokoro-82M (#1 ranked open-source TTS), running locally on CPU via kokoro-onnx (ONNX Runtime)
- 🎬 **Three Modes** — Walkthrough (hands-free with TTS), Read (text in terminal), or Podcast (single audio file)
- 🧠 **Adaptive Depth** — Overview or Deep Dive explanations based on your familiarity
- 📋 **Plan-First** — Scout finds files, planner builds narrative order, parallel segment agents generate highlights — outline visible immediately, segments stream in as they finish
- 💾 **Save & Share** — Save walkthroughs to `.walkthrough.json` files, replay later or share with teammates via the repo
- ⌨️ **Keyboard Shortcuts** — Full keybinding support for hands-free navigation

## 📦 Requirements

- 🪟 Windows 11
- 🐍 Python 3.10+ (`winget install Python.Python.3.13`)
- 📗 Node.js 18+ (`winget install OpenJS.NodeJS.LTS`)
- 🖥️ VS Code or Cursor with CLI on PATH (`code` or `cursor` command)
- ⚡ Optional: [uv](https://docs.astral.sh/uv/)

## 🔧 Installation

Just tell your coding agent:

```
Install the code explainer skill from https://github.com/Royal-lobster/code-explainer
```

Your agent will clone the repo into the skills directory, run `setup.ps1`, and ask you to reload your editor — all while keeping you in the loop at each step.

<details>
<summary>📋 Manual installation</summary>

### Skill-native agents

These agents support the `skills/<name>/SKILL.md` format natively. Clone directly into the skills directory:

| Agent | Install commands |
|-------|-----------------|
| **Claude Code** | `git clone https://github.com/Royal-lobster/code-explainer.git "$HOME\.claude\skills\explainer"` |
| **Amp** | `git clone https://github.com/Royal-lobster/code-explainer.git "$HOME\.config\agents\skills\explainer"` |
| **OpenCode** | `git clone https://github.com/Royal-lobster/code-explainer.git "$HOME\.config\opencode\skills\explainer"` |
| **Codex CLI** | `git clone https://github.com/Royal-lobster/code-explainer.git "$HOME\.codex\skills\explainer"` |

Then run setup:

```powershell
cd <SKILLS_DIR>\explainer
.\setup.ps1
# or: powershell -ExecutionPolicy Bypass -File setup.ps1
# Reload your editor: Ctrl+Shift+P → "Developer: Reload Window"
```

### Rule-based agents

These agents use their own rules/instructions format. Clone to any location, run setup, then point your agent's rules at the `SKILL.md`:

```powershell
# 1. Clone to a shared location
git clone https://github.com/Royal-lobster/code-explainer.git "$HOME\code-explainer"

# 2. Run setup
& "$HOME\code-explainer\setup.ps1"

# 3. Reload your editor: Ctrl+Shift+P → "Developer: Reload Window"
```

Then add a rule or instruction pointing to the skill:

| Agent | How to add |
|-------|------------|
| **Cursor** | Add a `.cursor/rules/explainer.mdc` file in your project that includes the contents of `SKILL.md` |
| **Windsurf** | Append the contents of `SKILL.md` to `%USERPROFILE%\.codeium\windsurf\memories\global_rules.md` |
| **Kilo Code** | Copy `SKILL.md` to `%USERPROFILE%\.kilocode\rules\explainer.md` |
| **Roo Code** | Copy `SKILL.md` to `%USERPROFILE%\.roo\rules\explainer.md` |
| **Cline** | Copy `SKILL.md` to your `.clinerules/explainer.md` directory |

> **Note:** The `SKILL.md` references relative paths (e.g., `docs/assess.md`), so the full repo must exist at the cloned location. For rule-based agents, ensure paths in the copied rules resolve correctly or use absolute paths.

### What setup.ps1 does

- 🐍 Python venv creation with TTS engine (kokoro-onnx + ONNX Runtime)
- 🧩 VS Code extension build and installation (.vsix for VS Code + Cursor)
- 🗣️ Voice model download (~330 MB, into `models\`)

</details>

## 💬 Usage

In your coding agent:

```
/explainer the authentication system
```

Or naturally:

```
Explain how the matching engine works
Walk me through the order flow
How does the WebSocket gateway handle events?
```

## ⚙️ How It Works

```
1. 💬 You ask to explain a feature
2. 🎯 Asks your depth preference (Overview / Deep Dive) and delivery mode
3. 🔍 Scout sub-agent maps the codebase — discovers relevant files and call chain

Overview path (fast):
4. 📋 Single agent builds plan + highlights in one pass → sends set_plan

Deep Dive path (thorough):
4. 🗺️ Planner builds narrative order + transition objects
5. ⚡ Parallel segment agents generate dense highlights
   Waits for all agents to finish, then sends full set_plan to sidebar

6. ✅ Plan in sidebar + chat — approve, reorder, or skip before playback starts
7. 🔄 Walkthrough runs based on your chosen mode:
   Walkthrough — sidebar drives playback automatically with TTS narration
   Read        — step through explanations in terminal, highlights code as you go
   Podcast     — renders a single audio file of the entire walkthrough
8. 📝 Summarizes key takeaways
```

## 🎬 Modes

| Mode | Description |
|------|-------------|
| 🎥 **Walkthrough** | Highlights move through code automatically while voice narrates in sync. Hands-free — just watch and listen. |
| 📝 **Read** | Text explanations in terminal. Highlights code, explains in text, waits for "next". No sidebar or TTS required. |
| 🎙️ **Podcast** | Generates a single audio file of the entire walkthrough. Listen anywhere. |

### 🪟 Sidebar Controls

The VS Code sidebar provides buttons for all walkthrough controls:

- ▶️ **Play / Pause** — Toggle walkthrough playback
- ⏭️ **Next / Previous** — Navigate between highlights within a segment
- ⏩ **Next / Previous Segment** — Jump between segments
- ⏩ **Speed** — Adjust TTS playback speed
- 🔈 **Volume** — Adjust TTS volume
- 🗣️ **Voice** — Select TTS voice
- 🔇 **Mute / Unmute** — Toggle voice narration
- 🔄 **Restart** — Restart walkthrough from the beginning
- 💾 **Save** — Save current walkthrough to `.walkthroughs/` for later replay
- ✕ **Close** — Close walkthrough (prompts to save if unsaved)

### 💾 Save & Share

Save walkthroughs as portable JSON files that live in your repo:

```powershell
# Save via CLI
.\scripts\explainer.ps1 save auth-flow

# Load a saved walkthrough
.\scripts\explainer.ps1 load auth-flow

# List all saved walkthroughs
.\scripts\explainer.ps1 list
```

Or use the VS Code command palette:
- **Code Explainer: Save Walkthrough** — Save with a custom name
- **Code Explainer: Load Walkthrough** — Browse and load saved walkthroughs

Saved walkthroughs are stored in `.walkthroughs/` at the workspace root with relative file paths, so teammates can pull them and replay on their own machine. The sidebar also shows a browse list of saved walkthroughs when no walkthrough is active.

### ⌨️ Keyboard Shortcuts

All shortcuts are active when a walkthrough is running:

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+Space` | Toggle play / pause |
| `Ctrl+Alt+]` | Next sub-segment |
| `Ctrl+Alt+[` | Previous sub-segment |
| `Ctrl+Alt+Shift+]` | Next segment |
| `Ctrl+Alt+Shift+[` | Previous segment |
| `Ctrl+Alt+\` | Stop walkthrough |
| `Ctrl+Alt+=` | Speed up TTS |
| `Ctrl+Alt+-` | Speed down TTS |

### 💬 Text Controls

You can also type commands in your agent's chat:

| Command | Action |
|---------|--------|
| `next` | ⏭️ Move to next segment |
| `skip` | ⏩ Skip current segment |
| `skip to 4` | 🎯 Jump to segment 4 |
| `pause` | ⏸️ Pause walkthrough |
| `mute` / `unmute` | 🔇 Toggle voice narration |
| `stop` | ⏹️ End walkthrough |

## 🗣️ Voice Configuration

Code Explainer uses [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) via [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) (ONNX Runtime, CPU) for high-quality local TTS. Model files live in `models\` inside the skill directory.

```powershell
# Change voice
$env:TTS_VOICE = "am_adam"    # American male

# Change speed
$env:TTS_SPEED = "1.2"        # 20% faster
```

### 🎤 Available Voices

| Voice | Description |
|-------|-------------|
| `af_heart` | 🇺🇸 American English, female (default) |
| `af_bella` | 🇺🇸 American English, female |
| `af_sarah` | 🇺🇸 American English, female |
| `am_adam` | 🇺🇸 American English, male |
| `am_michael` | 🇺🇸 American English, male |
| `bf_emma` | 🇬🇧 British English, female |
| `bm_george` | 🇬🇧 British English, male |

## 🏗️ Architecture

The extension runs an HTTP + WebSocket server on localhost for communication between your coding agent and the VS Code sidebar.

```
Coding Agent ──HTTP──▶ Extension Server ──Events──▶ Sidebar Webview
                           │                            │
                      Highlight API              TTS Audio Stream
                           │                            │
                     VS Code Editor              Browser AudioContext
```

### 🧩 Key Components

| Component | Description |
|-----------|-------------|
| 🌐 **Extension Server** (`server.ts`) | HTTP + WebSocket server with bearer token auth. Endpoints for plan delivery, state queries, save/load, and long-polling user actions. |
| 🪟 **Sidebar** (`sidebar.ts`) | Webview panel showing the walkthrough — segment list, per-highlight explanations, and playback controls. |
| 🔄 **Walkthrough** (`walkthrough.ts`) | State machine managing segment and sub-highlight navigation and playback status. |
| 🎯 **Highlight** (`highlight.ts`) | Opens files, scrolls to ranges, and applies gold background decorations. |
| 🔊 **TTS Bridge** (`tts-bridge.ts`) | Streams audio from the Python TTS server to the sidebar webview via WebSocket. |
| 🐍 **TTS Server** (`tts_server.py`) | Persistent Python daemon that loads Kokoro once and streams audio over localhost TCP (127.0.0.1, token auth). |
| 💾 **Storage** (`storage.ts`) | Save and load walkthroughs as `.walkthrough.json` files for replay and sharing. |
| 📡 **Helper Script** (`explainer.ps1`) | CLI wrapper around the HTTP API — used by the coding agent to send plans and poll for user actions. |

## 📁 Project Structure

```
code-explainer/
├── 📄 SKILL.md                      # AI agent skill instructions
├── 🔧 setup.ps1                     # One-command setup script
├── 📂 scripts/
│   ├── 📡 explainer.ps1             # HTTP API helper for the coding agent
│   ├── 🐍 tts_server.py             # Persistent TTS server (Kokoro-82M)
│   ├── 🎙️ podcast.py                # Podcast mode audio generator
│   └── 🔄 reinstall-extension.ps1   # Quick extension rebuild
├── 📂 docs/
│   ├── 📖 setup.md                  # Setup reference
│   ├── 🗑️ uninstall.md              # Uninstall guide
│   ├── 🎯 assess.md                 # Preference gathering (depth + delivery mode)
│   ├── 🔍 scan.md                   # Scout sub-agent (file discovery + call chain)
│   ├── 📋 plan.md                   # Planner sub-agent (narrative + transition objects)
│   ├── ⚡ segments.md               # Parallel segment agents (highlight generation)
│   ├── 🎥 walkthrough.md            # Walkthrough mode (sidebar + TTS)
│   ├── 📝 read.md                   # Read mode (text in terminal)
│   ├── 🎙️ podcast.md               # Podcast mode (single audio file)
│   └── 🗣️ tts.md                   # TTS reference (voices, speeds)
└── 📂 vscode-extension/
    ├── 📦 package.json
    ├── ⚙️ tsconfig.json
    ├── 📂 src/
    │   ├── 🚀 extension.ts          # Main entry point
    │   ├── 🌐 server.ts             # HTTP + WebSocket server
    │   ├── 🪟 sidebar.ts            # Webview sidebar provider
    │   ├── 🔄 walkthrough.ts        # Walkthrough state machine
    │   ├── 🎯 highlight.ts          # Code highlighting
    │   ├── 🔊 tts-bridge.ts         # TTS audio streaming
    │   ├── 💾 storage.ts            # Walkthrough persistence
    │   └── 📝 types.ts              # Message protocol types
    └── 📂 media/
        ├── 🎨 icon.svg
        ├── 🖼️ icon.png
        └── 📜 sidebar.js            # Sidebar webview script
```

## 📄 License

MIT
