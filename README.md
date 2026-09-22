# opencode-ssh

A persistent, interactive SSH session, SFTP file management, and background job supervisor plugin for **OpenCode v2**.

---

## What Makes This Agent-Friendly?

1. **Deterministic Structured JSON Responses**:
   - Every tool returns `{ "success": true, ... }` or `{ "success": false, "error": { "code", "message", "hint" } }`.
   - Never leaves the agent guessing why a connection or file operation failed.
2. **Anti-Hang Protection & Environment Guard**:
   - Shell sessions automatically inject `TERM=dumb`, `PAGER=cat`, `GIT_PAGER=cat`, `SYSTEMD_PAGER=cat`, and `CI=1`. Commands like `journalctl` or `git diff` never hang inside pagers like `less`.
   - All async network handshakes (SFTP, stream creation) have hard timeout boundaries to prevent agent lockups.
3. **True Remote Code Editing (SFTP)**:
   - Eliminates fragile `sed` or `cat <<EOF` remote file mutations.
   - `ssh_edit_file` mirrors OpenCode’s native search-and-replace `edit` tool with uniqueness enforcement and line reporting.
4. **Multi-Session Management & Cluster Broadcast**:
   - Run dozens of remote connections concurrently.
   - Switch active default session seamlessly with `ssh_switch_session`.
   - Fan out commands across all connected servers in parallel via `ssh_broadcast`.
5. **Background Job Supervision**:
   - Detached, supervised long-running process manager (`ssh_job_spawn`, `ssh_job_status`, `ssh_job_logs`, `ssh_job_kill`).
   - Handles commands that outlive OpenCode tool execution timeouts (builds, migrations, containers).
6. **Instant Diagnostics**:
   - `ssh_system_inspect` runs a single multi-metric probe returning OS, Kernel, Arch, Uptime, Memory, Disk, listening ports, package managers, runtimes (`node`, `python`, `docker`, `go`, `git`), and git repo status in 1 round trip.

---

## Tool Reference (19 Registered Tools)

### Session & Multi-Host Management
- **`ssh_list_profiles`**: Lists hosts configured in `~/.ssh/config` or custom OpenCode profiles.
- **`ssh_save_profile`**: Save host, username, key path, port, passphrase, or password into persistent storage.
- **`ssh_connect`**: Connect or verify an active session using a profile name or direct host details.
- **`ssh_list_sessions`**: Inspect all active sessions, their hostnames, uptime, and active default flag.
- **`ssh_switch_session`**: Set which open SSH session acts as default for subsequent commands.
- **`ssh_broadcast`**: Run a command concurrently across all or a selected list of remote servers.
- **`ssh_close`**: Terminate and clean up an active connection.

### Execution & Interactive Terminal
- **`ssh_exec`**: Discrete multiplexed remote execution channel returning `{ stdout, stderr, exitCode, durationMs }`.
- **`ssh_interactive_cmd`**: Run a command in the persistent PTY shell preserving environment variables, working directory, and REPL state.
- **`ssh_pty_send`**: Send raw keystrokes, answers to interactive prompts, passwords, or signals (`\x03` Ctrl+C).
- **`ssh_pty_read`**: Read recent terminal output buffer lines.

### SFTP Remote Filesystem
- **`ssh_read_file`**: Read remote file content with line numbers, offset, and pagination.
- **`ssh_write_file`**: Atomically create or overwrite a remote file over SFTP.
- **`ssh_edit_file`**: Targeted search-and-replace (`oldString` -> `newString`) with match validation.

### Background Jobs & System Diagnostics
- **`ssh_system_inspect`**: Complete environment health check in 1 call.
- **`ssh_job_spawn`**: Spawn supervised background task (returns job ID immediately).
- **`ssh_job_status`**: Poll job status, liveness, and exit code.
- **`ssh_job_logs`**: Retrieve real-time tail of job stdout/stderr.
- **`ssh_job_kill`**: Send `SIGTERM`, `SIGINT`, or `SIGKILL` to remote background job.

---

## TUI Extension

The plugin also includes OpenCode CLI/TUI hooks (`src/tui.ts`):
- `/ssh-profiles`: Quick slash command to check configured profiles.
- `/ssh-disconnect-all`: Fast dialog to disconnect all active remote sessions.
- Status bar indicator on the OpenCode TUI footer.
