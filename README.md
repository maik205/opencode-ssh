# opencode-ssh

A persistent, interactive SSH session and profile manager plugin for **OpenCode v2**.

## Key Features

1. **Persistent Session Management**:
   - Holds SSH connections in memory across agent tool calls.
   - Eliminates re-authenticating on every command.
   - Automatic reconnect if a session is interrupted.
2. **Dual Execution Modes (Hybrid Exec + PTY)**:
   - **`ssh_exec`**: High-performance discrete command execution channel returning stdout, stderr, and exit codes.
   - **`ssh_interactive_cmd`**: Persistent pseudo-terminal (PTY) shell preserving working directory, environment variables, virtualenvs, and interactive state.
   - **`ssh_pty_send`** & **`ssh_pty_read`**: Send keystrokes, answers to interactive prompts (`sudo`, `yes/no`, passwords), and read buffer chunks.
3. **Authentication Profiles (`~/.ssh/config` + OpenCode storage)**:
   - Automatically parses and detects existing hosts from your system `~/.ssh/config`.
   - Allows saving custom profiles with keys, passwords, custom ports, or passphrase settings.
   - Safe credential handling (passwords and sensitive keys are not leaked in listing tools).
4. **Agent-Friendly Tool Design**:
   - Clean JSON schemas, clear descriptions, and typed outputs.
   - Supports OpenCode Code Mode (`options: { codemode: true }`).
   - Informative progress notifications.

---

## Available Tools

| Tool | Description |
|---|---|
| `ssh_list_profiles` | Lists configured profiles from `~/.ssh/config` and saved OpenCode profiles. |
| `ssh_save_profile` | Saves or updates an SSH connection profile. |
| `ssh_connect` | Establishes or reuses a persistent SSH session. |
| `ssh_list_sessions` | Lists currently active open SSH sessions and connection metadata. |
| `ssh_exec` | Executes a single command over SSH multiplexing (fast, discrete output). |
| `ssh_interactive_cmd` | Runs a command in the persistent interactive PTY shell. |
| `ssh_pty_send` | Sends interactive input, answers, or control signals (`\x03` Ctrl+C) to PTY. |
| `ssh_pty_read` | Reads recent terminal output buffer lines. |
| `ssh_close` | Closes and cleans up a specific active SSH session. |

---

## Installation & Setup in OpenCode v2

### Option 1: Load as a Local Plugin in `opencode.jsonc`

Add the directory to your project or global OpenCode configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "C:/Users/maik/Documents/Projects/oc-ssh"
  ]
}
```

Or copy/symlink to `.opencode/plugins/ssh`:

```bash
mkdir -p .opencode/plugins/ssh
# copy dist and package.json or reference directly
```

### Option 2: Build from Source

```bash
npm run build
```

---

## Agent Usage Examples

### Example 1: Listing Profiles and Running a Command
```ts
// Agent lists profiles
await tools.ssh.ssh_list_profiles()

// Agent executes a command on 'staging' profile (no re-auth needed next time)
await tools.ssh.ssh_exec({
  sessionID: "staging",
  command: "docker ps -a"
})
```

### Example 2: Interactive Session State (Virtualenv & Directory Persistence)
```ts
// Navigate and activate virtual environment in the persistent PTY
await tools.ssh.ssh_interactive_cmd({
  command: "cd /opt/myapp && source venv/bin/activate"
})

// Run python inside the same active environment
await tools.ssh.ssh_interactive_cmd({
  command: "python manage.py migrate"
})
```
