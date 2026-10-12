/**
 * Helpers for Claude Code SSH mod
 * @typedef {Object} ParsedProfile
 * @property {string} name
 * @property {string} hostName
 * @property {string} [user]
 * @property {number} [port]
 * @property {string} [identityFile]
 */

export function parseSshConfigFile(content) {
  if (!content || typeof content !== 'string') return []

  const lines = content.split(/\r?\n/)
  const profiles = []
  let current = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const match = line.match(/^(\w+)\s+(.+)$/)
    if (!match) continue

    const key = match[1].toLowerCase()
    const value = match[2].trim()

    if (key === 'host') {
      if (current && current.name) {
        profiles.push({
          name: current.name,
          hostName: current.hostName || current.name,
          user: current.user,
          port: current.port || 22,
          identityFile: current.identityFile,
        })
      }

      // Ignore wildcard Host entries like *
      if (value === '*' || value.includes('*') || value.includes('?')) {
        current = null
        continue
      }

      current = { name: value, hostName: value }
    } else if (current) {
      if (key === 'hostname') {
        current.hostName = value
      } else if (key === 'user') {
        current.user = value
      } else if (key === 'port') {
        const p = parseInt(value, 10)
        if (!isNaN(p)) current.port = p
      } else if (key === 'identityfile') {
        current.identityFile = value
      }
    }
  }

  if (current && current.name) {
    profiles.push({
      name: current.name,
      hostName: current.hostName || current.name,
      user: current.user,
      port: current.port || 22,
      identityFile: current.identityFile,
    })
  }

  return profiles
}

export function formatProfileList(profiles, configPath) {
  if (!profiles || profiles.length === 0) {
    return [
      '### Configured SSH Profiles',
      '',
      configPath ? `Checked \`${configPath}\`: No specific host configurations found.` : 'No SSH profiles found.',
      '',
      '_To connect to a remote host, provide connection details to Claude (e.g., `connect to root@192.168.1.50`)._',
    ].join('\n')
  }

  const rows = profiles.map((p) => {
    const userStr = p.user ? `${p.user}@` : ''
    const portStr = p.port && p.port !== 22 ? `:${p.port}` : ''
    const target = `${userStr}${p.hostName}${portStr}`
    const key = p.identityFile ? ` (key: \`${p.identityFile}\`)` : ''
    return `• **\`${p.name}\`** -> \`${target}\`${key}`
  })

  return [
    `### Configured SSH Profiles (${profiles.length})`,
    configPath ? `_Loaded from \`${configPath}\`_` : '',
    '',
    ...rows,
    '',
    'To connect or run commands on any host, ask Claude, e.g.:',
    `> "Connect to ${profiles[0].name} and inspect uptime"`,
  ].filter(Boolean).join('\n')
}

export function getHelpText() {
  return `### SSH Tools & Claude Code Mod Cheatsheet

**Commands**:
• \`/ssh-profiles\` - List configured SSH hosts from ~/.ssh/config
• \`/ssh-status\` - Show active SSH tool status and execution history
• \`/ssh-help\` - Show this help guide

**Available MCP Tools for Claude**:
• \`ssh_connect\` - Open persistent authenticated SSH connection
• \`ssh_exec\` - Run discrete shell command with stdout/stderr
• \`ssh_interactive_cmd\` - Run command in persistent shell preserving cd/env
• \`ssh_switch_user\` - Switch user to root via sudo/su in PTY
• \`ssh_scp\` - Fast chunked file/directory transfer (upload/download/remote-to-remote)
• \`ssh_read_file\` / \`ssh_write_file\` / \`ssh_edit_file\` - SFTP file management
• \`ssh_list_dir\` / \`ssh_stat\` / \`ssh_mkdir\` / \`ssh_rm\` - Remote filesystem operations
• \`ssh_job_spawn\` / \`ssh_job_logs\` / \`ssh_job_status\` - Detached background jobs
• \`ssh_system_inspect\` - Single-call OS, CPU, RAM, disk, and runtimes audit
• \`ssh_broadcast\` - Concurrently execute across multiple active sessions
`
}
