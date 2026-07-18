# Claude Code CLI Usage Guide

Reference for driving the `claude` CLI programmatically: headless invocation,
custom system prompts, model selection, tool access, sessions, and the full
flag/subcommand reference.

Verified against `claude --version` → `2.1.209 (Claude Code)`. Flag
names/behavior may shift between versions — re-check `claude --help` if
something here doesn't match.

## Prerequisites

Confirm you're authenticated:

```bash
claude auth status
```

If not logged in: `claude auth login`. For a long-lived token suited to a
background process (not tied to an interactive login session), see
[Long-lived auth](#long-lived-auth) below.

## Core building block: headless mode

```bash
claude -p "your message here" --output-format text
```

- `-p` / `--print`: run once, print the response, exit. This is what makes
  `claude` usable as a subprocess instead of an interactive TUI.
- `--output-format`:
  - `text` (default) — plain response text.
  - `json` — single JSON object with the result, cost/usage metadata, session id.
  - `stream-json` — newline-delimited JSON events as they arrive (for
    token-by-token streaming).

Example with JSON output:

```bash
claude -p "Summarize this in one sentence: ..." --output-format json
```

## Custom system prompt

Two flags, pick one:

```bash
# Full replacement of the default system prompt
claude -p --system-prompt "You are Aria, a terse trading-desk assistant. \
Answer only about markets and this workspace." \
  "What's today's date?"

# Keep the default system prompt, add instructions on top
claude -p --append-system-prompt "Always answer in under 3 sentences." \
  "Explain options theta decay"
```

- `--system-prompt <prompt>` — replaces the default system prompt entirely.
- `--append-system-prompt <prompt>` — keeps the default behavior and layers
  your instructions on top. Use this if you still want CLAUDE.md discovery,
  default tool behavior, etc., just nudged.
- Both also have `-file` variants (`--system-prompt-file`,
  `--append-system-prompt-file`) in recent versions, for keeping long prompts
  in a separate file instead of inline — check `claude --help` for
  availability in your version.

## Picking a model

```bash
claude -p --model sonnet "hello"
claude -p --model opus "hello"
claude -p --model claude-sonnet-5 "hello"     # full model name also works
```

- `--model <model>` accepts either a rolling alias (`sonnet`, `opus`, `fable`)
  that always points at the latest model in that tier, or an exact model id
  (`claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-4-5-20251001`, etc.).
- `--fallback-model <model1,model2,...>` (print mode only) — automatically
  retries with the next model in the list if the primary is
  overloaded/unavailable, and re-tries the primary at the start of each new
  turn.
- `--effort <low|medium|high|xhigh|max>` — reasoning effort/depth for models
  that support it. Higher = slower/more thorough, lower = faster.

## Tool calling

Claude Code ships with built-in tools (Bash, Read, Write, Edit, Grep, Glob,
etc.) and supports adding custom tools via MCP (Model Context Protocol). Both
work in headless mode.

### Restricting/choosing built-in tools

```bash
# Only allow these built-ins
claude -p --tools "Bash,Read" "..."

# Disable all built-in tools
claude -p --tools "" "..."

# Fine-grained allow/deny by pattern
claude -p --allowedTools "Bash(git *) Edit" "..."
claude -p --disallowedTools "Bash(rm *)" "..."
```

- `--tools <list>` — the coarse switch: which built-in tools exist at all this
  session. `""` = none, `"default"` = everything, or a specific comma/space
  list.
- `--allowedTools` / `--disallowedTools` — finer pattern-based allow/deny,
  e.g. restrict Bash to only `git` subcommands.
- `--permission-mode <mode>` — controls whether tool use prompts for
  confirmation:
  - `manual` — asks before each tool call (interactive-only; don't use in
    headless scripts, it'll hang waiting for input).
  - `acceptEdits` — auto-approves file edits, still asks for other risky
    actions.
  - `auto` / `dontAsk` — don't prompt, just proceed within allowed tools.
  - `bypassPermissions` — skip all permission checks entirely.
  - `plan` — plan-only, no execution.
  - For non-interactive use, `acceptEdits` or `bypassPermissions` combined
    with a tight `--tools`/`--allowedTools` list avoids hanging on a
    confirmation prompt. `--dangerously-skip-permissions` /
    `--allow-dangerously-skip-permissions` skip all checks for fully
    unattended runs — recommended only for sandboxes with no internet access.

### Adding custom tools (MCP)

MCP lets you attach arbitrary external tools (your own scripts/APIs) that
Claude can call, same as built-ins.

Quick add, stdio server (a local script/binary):

```bash
claude mcp add my-tool -- /path/to/my-tool-server --some-flag
```

Quick add, HTTP server:

```bash
claude mcp add --transport http my-api https://internal.example/mcp \
  --header "Authorization: Bearer $MY_TOKEN"
```

Inline JSON, scoped to a single headless call (doesn't touch global MCP config):

```bash
claude -p --mcp-config '{
  "mcpServers": {
    "my-tool": {
      "command": "/path/to/my-tool-server",
      "args": ["--some-flag"]
    }
  }
}' --strict-mcp-config "use my-tool to look up X"
```

- `claude mcp add/list/get/remove` — manage persistent MCP servers available
  to every session.
- `--mcp-config <file-or-json...>` — load MCP servers just for this
  invocation.
- `--strict-mcp-config` — ignore all other MCP sources (global config,
  project `.mcp.json`) and use only what's passed via `--mcp-config`.

### Structured output

```bash
claude -p --json-schema '{"type":"object","properties":{"reply":{"type":"string"},"action":{"type":"string"}},"required":["reply"]}' \
  --output-format json "..."
```

`--json-schema` forces the final response to validate against your schema —
useful if you need structured fields (e.g. `{reply, intent, action}`) instead
of free text.

## Conversation continuity (multi-turn)

Headless mode is stateless per call by default (each invocation is a new
conversation) unless you tell it to continue one:

```bash
# Start a session, capture its id from --output-format json (field: session_id)
claude -p --output-format json --session-id <uuid> "hello, remember the number 42"

# Continue that same session later
claude -p --resume <uuid> "what number did I ask you to remember?"

# Or just continue the most recent conversation in this directory
claude -p --continue "and what about now?"
```

- `-r` / `--resume [id]` — resume a specific past session by id.
- `-c` / `--continue` — resume the most recent session in the current
  directory, no id needed.
- `--session-id <uuid>` — pin a specific id up front.
- `--fork-session` — when resuming, branch into a new session id instead of
  mutating the original.
- `--no-session-persistence` — don't save this session to disk at all;
  nothing to resume later.
- `-n` / `--name <name>` — friendly display name for the session (shows up in
  `/resume` pickers etc.).

### Persistent process instead of spawning per call

Spawning `claude -p` fresh for every message works but costs ~1-2s of startup
each time. To avoid that, keep one process open and stream JSON lines in/out:

```bash
claude -p --input-format stream-json --output-format stream-json --include-partial-messages
```

Write one JSON message object per line to its stdin and read streamed JSON
events from its stdout as they arrive. `--replay-user-messages` (works only
with `stream-json`/`stream-json`) echoes input back on stdout, useful for
acknowledging receipt.

## Directory/filesystem scope

```bash
claude -p --add-dir /some/other/project "..."
```

`--add-dir` grants tool access to additional directories beyond the current
working directory.

## Safety switches

- `--safe-mode` — disables all customizations (CLAUDE.md, skills, plugins,
  hooks, MCP servers, custom commands/agents, output styles, etc.) while
  keeping auth, model selection, built-in tools, and permissions working
  normally. Good for isolating whether a bug is your custom config or the base
  assistant.
- `--bare` — a stricter minimal mode: skips hooks/LSP/plugin sync/auto-memory/
  CLAUDE.md discovery too, and forces auth to `ANTHROPIC_API_KEY`/
  `apiKeyHelper` only — OAuth and Keychain are never read in this mode.
- `--max-budget-usd <amount>` (print mode only) — caps spend for the call.

## Long-lived auth

For a process that runs standing (not launched from an interactive terminal
each time), set up a long-lived token once instead of relying on an
interactive login session:

```bash
claude setup-token
```

Produces a token you can export as `CLAUDE_CODE_OAUTH_TOKEN` so a process can
authenticate non-interactively without re-running the login flow.

Check current auth state any time:

```bash
claude auth status
```

## Minimal example: calling Claude from a script (Python)

```python
import subprocess
import json

SYSTEM_PROMPT = "You are Aria. Keep answers under 4 sentences."

def ask(message: str, session_id: str | None = None) -> dict:
    cmd = [
        "claude", "-p",
        "--system-prompt", SYSTEM_PROMPT,
        "--model", "sonnet",
        "--tools", "",              # no filesystem/shell access
        "--output-format", "json",
    ]
    if session_id:
        cmd += ["--resume", session_id]
    else:
        cmd += ["--no-session-persistence"]
    cmd.append(message)

    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)

reply = ask("What's a covered call?")
print(reply["result"])  # exact field name may vary by version; inspect the JSON once
```

For a persistent process, swap the per-call `--resume` pattern for the
`stream-json`/`stream-json` process described above once the basic flow is
confirmed working.

## Quick reference

| Need | Flag(s) |
|---|---|
| Run once, get output | `-p` / `--print` |
| Machine-readable output | `--output-format json` or `stream-json` |
| Custom system prompt (full override) | `--system-prompt "..."` |
| Custom system prompt (layered on default) | `--append-system-prompt "..."` |
| Pick model | `--model sonnet\|opus\|fable\|<full-id>` |
| Fallback if overloaded | `--fallback-model <list>` |
| Reasoning depth | `--effort low\|medium\|high\|xhigh\|max` |
| Restrict built-in tools | `--tools "Bash,Read"` / `--tools ""` |
| Fine-grained tool allow/deny | `--allowedTools` / `--disallowedTools` |
| No confirmation prompts (headless) | `--permission-mode acceptEdits\|auto\|bypassPermissions` |
| Custom external tools | `claude mcp add ...` or `--mcp-config` (+ `--strict-mcp-config`) |
| Force structured JSON reply | `--json-schema '{...}'` |
| Continue a conversation | `-c` / `--resume <id>` / `--session-id <uuid>` |
| Don't save this conversation | `--no-session-persistence` |
| Persistent process | `--input-format stream-json --output-format stream-json` |
| Extra directories for tools | `--add-dir <path>` |
| Long-lived auth for a process | `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` |
| Sanity-check config | `--safe-mode` |

## Every remaining flag (completeness pass)

The sections above cover the flags you'll actually reach for. Below is
everything else in `claude --help` (v2.1.209).

### Commonly useful

| Flag | What it does |
|---|---|
| `--agents <json>` | Define named custom agents/personas inline, e.g. `'{"reviewer":{"description":"...","prompt":"You are a code reviewer"}}'`. Combine with `--agent <name>` to select one. |
| `--agent <agent>` | Selects which defined agent (from `--agents`, or configured in settings) this session uses. |
| `--settings <file-or-json>` | Load additional settings from a file path or inline JSON string. |
| `--setting-sources <user,project,local>` | Choose which settings layers apply (user/project/local). |
| `--exclude-dynamic-system-prompt-sections` | Strips per-machine bits (cwd, env, git status, memory paths) out of the system prompt into the first user message instead, improving prompt-cache reuse. Ignored if you're using `--system-prompt` (full override). |
| `--file <specs...>` | Preload file resources at startup, format `file_id:relative_path`. |
| `--brief` | Enables the `SendUserMessage` tool so the agent can proactively send messages mid-session rather than only reply-per-turn. |
| `--prompt-suggestions [true\|false]` | In print/SDK mode, emits a predicted next-user-prompt after each turn. |
| `--bg` / `--background` | Start the session as a background agent and return immediately; manage with `claude agents`. |
| `--betas <betas...>` | Extra beta headers for API requests — API-key users only, not applicable on OAuth/subscription auth. |
| `--verbose` | Overrides the verbose-logging setting for this run. |
| `-d` / `--debug [filter]`, `--debug-file <path>` | Turn on debug logging (optionally filtered, e.g. `"api,hooks"`), optionally to a specific file. |
| `--include-hook-events` | (stream-json output only) include hook lifecycle events in the stream. |
| `--disable-slash-commands` | Disables all skills/slash-commands for the session. |
| `--plugin-dir <path>`, `--plugin-url <url>` | Load a plugin from a local dir/zip or a URL, scoped to this session only. |

### Interactive/coding-workflow features (rarely needed headless)

| Flag | What it does |
|---|---|
| `--ide` | Auto-connect to an IDE on startup. |
| `--chrome` / `--no-chrome` | Claude-in-Chrome browser integration. |
| `--tmux`, `-w`/`--worktree [name]` | tmux pane / git worktree session setup. |
| `--from-pr [value]` | Resume a session linked to a GitHub PR. |
| `--remote-control [name]`, `--remote-control-session-name-prefix` | Enables/names a Remote Control interactive session. |
| `--ax-screen-reader` | Flat, screen-reader-friendly rendering. |
| `-v` / `--version` | Prints the CLI version and exits. |
| `-h` / `--help` | Prints help and exits. |

## Subcommands (`claude <command>`)

| Command | Purpose |
|---|---|
| `auth` | `login`/`logout`/`status` — manage authentication. |
| `mcp` | `add`/`add-json`/`add-from-claude-desktop`/`get`/`list`/`login`/`logout`/`remove`/`reset-project-choices`/`serve` — manage MCP tool servers. |
| `setup-token` | Create a long-lived OAuth token for headless/background use. |
| `agents` | List/manage background agent sessions started with `--bg`. Supports `--json` for scripting. |
| `doctor` | Checks the health of your Claude Code install/config. |
| `auto-mode` | Inspect the auto-mode classifier configuration. |
| `plugin` / `plugins` | Manage installed plugins. |
| `project` | Manage Claude Code project-level state. |
| `gateway` | Runs an enterprise auth/telemetry gateway. |
| `install` | Install a specific Claude Code build/version. |
| `update` / `upgrade` | Check for and install CLI updates. |
| `ultrareview` | Cloud-hosted multi-agent code review of a branch/PR. |
