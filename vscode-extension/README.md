# Code Explainer

**Interactive code walkthroughs with AI-powered voice narration and editor highlighting.**

A VS Code extension that works with your coding agent to scan your codebase, build a walkthrough plan, and explain code segment-by-segment — highlighting lines in your editor with a dedicated sidebar panel and narrating with natural-sounding local TTS. Compatible with Claude Code, Codex, OpenCode, Kilo Code, Amp, and more.

## Features

- **Sidebar Panel** — Dedicated sidebar with walkthrough controls, segment navigation, and live explanation display
- **Code Highlighting** — Automatically opens files, scrolls to code, and highlights line ranges
- **Local TTS** — Natural-sounding voice narration powered by Kokoro-82M, running locally on CPU via kokoro-onnx (ONNX Runtime)
- **Three Modes** — Walkthrough (hands-free with TTS), Read (text in terminal), or Podcast (single audio file)
- **Adaptive Depth** — Overview, detailed, or focused explanations based on your familiarity

## Usage

In your coding agent, just ask naturally:

```
Explain how the authentication system works
Walk me through the order flow
How does the WebSocket gateway handle events?
```

Or use the skill command:

```
/explainer the matching engine
```

## How It Works

1. You ask your coding agent to explain a feature
2. AI scans the codebase and builds an ordered walkthrough plan
3. You approve or adjust the plan
4. For each segment, the extension:
   - Highlights the relevant lines in your editor
   - Displays the explanation in the sidebar
   - Streams TTS audio narration (if enabled)
   - Waits for your input or auto-advances

## Sidebar Controls

| Control | Action |
|---------|--------|
| **Play / Pause** | Toggle walkthrough playback |
| **Next / Previous** | Navigate between segments |
| **Speed** | Adjust TTS playback speed |
| **Volume** | Adjust TTS volume |
| **Voice** | Select TTS voice |
| **Mute / Unmute** | Toggle voice narration |

## Text Controls

You can also type commands in your agent's chat:

| Command | Action |
|---------|--------|
| `next` | Move to next segment |
| `skip` | Skip current segment |
| `skip to 4` | Jump to segment 4 |
| `pause` | Pause walkthrough |
| `mute` / `unmute` | Toggle voice narration |
| `stop` | End walkthrough |

## Voice Configuration

Uses [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) via [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) (ONNX Runtime, CPU) for high-quality local TTS.

### Available Voices

| Voice | Description |
|-------|-------------|
| `af_heart` | American English, female (default) |
| `af_bella` | American English, female |
| `af_sarah` | American English, female |
| `am_adam` | American English, male |
| `am_michael` | American English, male |
| `bf_emma` | British English, female |
| `bm_george` | British English, male |

## Requirements

- Windows 11
- Python 3.10+
- Node.js 18+
- A coding agent (Claude Code, Codex, OpenCode, Kilo Code, Amp, etc.) with the Code Explainer skill installed

## Installation

Tell your coding agent:

```
Install the code explainer skill from https://github.com/Royal-lobster/code-explainer
```

Or manually:

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\skills"
git clone https://github.com/Royal-lobster/code-explainer.git "$HOME\.claude\skills\explainer"
& "$HOME\.claude\skills\explainer\setup.ps1"
```

## Architecture

```
Coding Agent ──HTTP──> Extension Server ──Events──> Sidebar Webview
                           |                            |
                      Highlight API              TTS Audio Stream
                           |                            |
                     VS Code Editor              Browser AudioContext
```

## License

MIT
