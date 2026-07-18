# Voice I/O: Speech-to-Text + Text-to-Speech (macOS only)

This documents the voice layer that sits on top of the text pipeline in
[`CLAUDE_USAGE_GUIDE.md`](CLAUDE_USAGE_GUIDE.md). The "brain" (understanding +
reply generation) is still `claude -p` on your existing subscription — nothing
about that changes. This doc only covers turning speech into text before it goes
in, and turning text back into speech after it comes out.

Every command below was actually run on this machine to confirm it works, not
copied from memory — versions/paths noted where it matters.

## Platform scope: macOS only, and why

- **TTS** uses macOS's built-in Speech Synthesis framework (the `say` command
  and the system voice registry, e.g. the `Joelle (Enhanced)` voice). This is
  Apple system infrastructure — there is no equivalent on Linux/Windows. A
  downloaded system voice like Joelle cannot be bundled into the app or shipped
  to another machine; it only works where it's already installed via System
  Settings (see the bundling discussion — same conclusion applies here).
- **STT** (whisper.cpp) is technically cross-platform, but this setup —
  install paths, model cache location, mic capture via `whisper-stream`'s SDL2
  backend — is written and verified for macOS only, matching the TTS
  constraint. If the app ever needs to run on Linux/Windows, STT could
  theoretically follow, but TTS would need a completely different engine
  there, so voice mode as a whole should stay gated to macOS for now.

**The app must detect the OS at startup and only enable voice mode on macOS.**
Everywhere else, fall back to text-only chat (which already works fine via
`claude -p`, no voice layer needed).

Detection pattern, pick whichever matches your app's language:

```python
# Python
import platform
VOICE_MODE_SUPPORTED = platform.system() == "Darwin"
```

```javascript
// Node.js
const VOICE_MODE_SUPPORTED = process.platform === "darwin";
```

```bash
# Shell
if [[ "$(uname -s)" == "Darwin" ]]; then
  VOICE_MODE_SUPPORTED=1
else
  VOICE_MODE_SUPPORTED=0
fi
```

Gate every voice-specific code path (mic capture, `whisper-cli`/`whisper-stream`
calls, `say` calls) behind this check. On unsupported platforms, disable the
voice UI entirely rather than letting a `say`/`whisper-*` call fail at runtime.

## Components

| Layer | Tool | License | Cost |
|---|---|---|---|
| STT (speech → text) | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) via Homebrew | MIT | Free, fully local/offline |
| Brain (text → reply) | `claude -p` (see `CLAUDE_USAGE_GUIDE.md`) | — | Your existing subscription, no extra billing |
| TTS (text → speech) | macOS `say` + `Joelle (Enhanced)` system voice | Apple system asset | Free, already on your machine |

No API keys, no other providers, anywhere in this pipeline.

## Setup

### 1. Install whisper.cpp

```bash
brew install whisper-cpp
```

Confirmed installed binaries (v1.9.1, your machine): `whisper-cli`,
`whisper-stream`, `whisper-server`, `whisper-bench`, `whisper-quantize`, and a
few others. The two that matter here:
- `whisper-cli` — transcribe a finished audio file.
- `whisper-stream` — live microphone transcription (captures audio itself via
  SDL2, no separate recording step).

### 2. Download a model

Homebrew doesn't ship model weights — download separately from Hugging Face:

```bash
mkdir -p ~/Library/Application\ Support/voice-bot/whisper-models
curl -L -o ~/Library/Application\ Support/voice-bot/whisper-models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

(swap `voice-bot` for your actual app's name/support directory)

Model size vs. speed/accuracy tradeoff (English-only `.en` variants — smaller/
faster, use these unless you need multilingual):

| Model | Approx. size | Notes |
|---|---|---|
| `ggml-tiny.en.bin` | ~75 MB | Fastest, least accurate — fine for short commands |
| `ggml-base.en.bin` | ~142 MB | Good default; used in the verified test below |
| `ggml-small.en.bin` | ~466 MB | Noticeably more accurate, still fast on Apple Silicon |
| `ggml-medium.en.bin` | ~1.5 GB | Best accuracy of the `.en` set, slower |

Same base URL pattern for any of them:
`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<filename>`

These model files are plain permissively-licensed files (unlike the macOS
system voice) — they genuinely can be bundled inside your own app if you want
it self-contained, since they don't depend on Apple's asset framework.

### 3. Confirm the Joelle voice is available

```bash
say -v '?' | grep -i joelle
```

Expected output on this machine: `Joelle (Enhanced)   en_US`. If it's not
downloaded yet: System Settings → Accessibility → Spoken Content → System
Voice → find Joelle → download the Enhanced variant.

## Using it

### Text-to-speech

```bash
say -v "Joelle (Enhanced)" "Hello, it's so nice to meet you."
```

To render to a file instead of playing immediately (useful if your app wants
to control playback timing, e.g. queue it, stream it, play over a specific
output device):

```bash
say -v "Joelle (Enhanced)" -o reply.aiff "Hello, it's so nice to meet you."
```

### Speech-to-text — file-based (simplest to reason about)

Record audio to a 16kHz mono WAV (whisper.cpp's expected format), then
transcribe. Recording via `ffmpeg` (already on this machine):

```bash
# Record 5 seconds from the default mic
ffmpeg -y -f avfoundation -i ":0" -t 5 -ar 16000 -ac 1 -c:a pcm_s16le input.wav

# Transcribe
whisper-cli -m ~/Library/Application\ Support/voice-bot/whisper-models/ggml-base.en.bin \
  -f input.wav -np -nt
```

- `-np` (`--no-prints`) — suppress everything except the transcribed text.
- `-nt` (`--no-timestamps`) — plain text, no `[00:00:00.000 --> ...]` prefixes.

**Verified end to end on this machine**: generated `"This is a test of the
whisper pipeline"` via `say`, converted to 16kHz mono WAV, ran it through
`whisper-cli` with the `base.en` model — transcribed back correctly as *"This
is a test of the whisper pipeline."*

### Speech-to-text — live streaming (better UX, more moving parts)

`whisper-stream` listens to the mic directly and transcribes in near-real-time
chunks, no separate record step:

```bash
whisper-stream -m ~/Library/Application\ Support/voice-bot/whisper-models/ggml-base.en.bin \
  --step 3000 --length 10000
```

Key flags:
- `--step N` — how often (ms) it processes a new chunk (default 3000).
- `--length N` — how much trailing audio (ms) it considers each time (default
  10000).
- `-c ID` / `--capture ID` — pick a specific capture device if you have more
  than one mic.
- `-vth` / `--vad-thold` — voice-activity threshold, tune if it's triggering
  on silence/background noise or missing quiet speech.

Start with the file-based flow to get the pipeline working end to end, then
move to `whisper-stream` once you want a "just talk, it's always listening"
experience instead of push-to-talk.

### Microphone permission

First time anything (Terminal, your app, `ffmpeg`, `whisper-stream`) tries to
access the mic, macOS will prompt for permission. It's granted per-app under
System Settings → Privacy & Security → Microphone — check there if capture
silently returns empty audio.

## Full pipeline, tied together

```bash
#!/usr/bin/env bash
set -euo pipefail

MODEL="$HOME/Library/Application Support/voice-bot/whisper-models/ggml-base.en.bin"
VOICE="Joelle (Enhanced)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Voice mode requires macOS. Falling back to text-only." >&2
  exit 1
fi

# 1. Record 5s from the mic
ffmpeg -y -f avfoundation -i ":0" -t 5 -ar 16000 -ac 1 -c:a pcm_s16le /tmp/voice-in.wav -loglevel error

# 2. Speech -> text
USER_TEXT=$(whisper-cli -m "$MODEL" -f /tmp/voice-in.wav -np -nt)
echo "Heard: $USER_TEXT"

# 3. Text -> Claude reply (subscription, no API key — see CLAUDE_USAGE_GUIDE.md)
REPLY=$(claude -p --system-prompt "You are a helpful voice assistant. Keep replies short." \
  --model claude-haiku-4-5-20251001 --tools "" --no-session-persistence \
  --output-format json "$USER_TEXT" | python3 -c "import json,sys; print(json.load(sys.stdin)['result'])")
echo "Reply: $REPLY"

# 4. Text -> speech
say -v "$VOICE" "$REPLY"
```

Swap the fixed `-t 5` recording window for `whisper-stream`'s live mode once
push-to-talk feels too clunky, and swap the per-call `claude -p` for the
persistent `stream-json` process (see `CLAUDE_USAGE_GUIDE.md`) once startup
latency matters.

## Quick reference

| Need | Command |
|---|---|
| Install STT engine | `brew install whisper-cpp` |
| Download a model | `curl -L -o <path>.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<model>.bin` |
| Confirm voice installed | `say -v '?' \| grep -i joelle` |
| Speak text | `say -v "Joelle (Enhanced)" "text"` |
| Speak to file | `say -v "Joelle (Enhanced)" -o out.aiff "text"` |
| Record from mic | `ffmpeg -f avfoundation -i ":0" -t 5 -ar 16000 -ac 1 -c:a pcm_s16le out.wav` |
| Transcribe a file | `whisper-cli -m <model>.bin -f out.wav -np -nt` |
| Live mic transcription | `whisper-stream -m <model>.bin --step 3000 --length 10000` |
| Detect macOS at runtime | `platform.system() == "Darwin"` / `process.platform === "darwin"` / `uname -s` |

## Scope reminder

Same boundary as `CLAUDE_USAGE_GUIDE.md`: this is a local, personal-use voice
layer on your own machine, on top of your own subscription. Nothing here adds
a new account, a new API key, or new billing — whisper.cpp is local compute,
`say`/Joelle is a local OS asset, and the reply text still comes from your
existing `claude -p` setup.
