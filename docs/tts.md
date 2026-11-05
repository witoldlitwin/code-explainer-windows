# TTS Reference

## Engine

**Kokoro-82M** via kokoro-onnx (ONNX Runtime, CPU) — top-ranked open-source TTS, runs locally. Model files (`kokoro-v1.0.onnx` and `voices-v1.0.bin`, ~330 MB, downloaded by setup) live in `<skill>\models\` by default. Set the `TTS_MODEL_DIR` env var to use a different directory containing them.

Persistent server (`tts_server.py`) loads model once and streams audio over localhost TCP (127.0.0.1, OS-assigned port, token auth). First call ~5s (model load), subsequent ~450ms (streaming). Starts automatically on first TTS call. Runtime files: `%USERPROFILE%\.claude-explainer\tts-server.{port,token,pid,log}`.

## Behavior

- **Non-blocking** — agent continues while audio plays (`run_in_background: true`)
- **Auto-canceling** — new segment kills previous audio
- **Streaming** — playback starts on first sentence while rest generates

## Voices

Default: `af_heart`. Configurable via `TTS_VOICE` env var.

| Voice | Description |
|-------|-------------|
| `af_heart` | American female (default) |
| `af_bella` | American female |
| `af_sarah` | American female |
| `am_adam` | American male |
| `am_michael` | American male |
| `bf_emma` | British female |
| `bm_george` | British male |

Convention: `a`=American, `b`=British, `f`=female, `m`=male.

## Speed

Default: `1.0`. Configurable via `TTS_SPEED` env var. Always pass user's speed setting.

## Spoken text rules

- **Plain text only** — no backticks, bold, line numbers, file paths
- **2-4 sentences** — shorter than written explanation
- **Conversational** — as if explaining to a colleague
