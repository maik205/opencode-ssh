import type { SSHSession } from "./ssh-session.js"

export interface SystemInspectionReport {
  os: string
  kernel: string
  hostname: string
  arch: string
  uptime: string
  loadAverage: string
  cpuCount: string
  memory: {
    total: string
    used: string
    free: string
    available: string
  }
  disk: Array<{
    filesystem: string
    size: string
    used: string
    avail: string
    usePercent: string
    mountedOn: string
  }>
  packageManagers: string[]
  runtimes: Record<string, string>
  listeningPorts: string[]
  currentCwd: string
  gitRepo?: {
    isRepo: boolean
    branch?: string
    status?: string
  }
}

export async function inspectSystem(session: SSHSession): Promise<SystemInspectionReport> {
  // A compact multi-line probe script that executes in a single round-trip
  const probeScript = `
echo "===SECTION:OS==="
cat /etc/os-release 2>/dev/null || uname -a
echo "===SECTION:UNAME==="
uname -s -r -m -n
echo "===SECTION:UPTIME==="
uptime
echo "===SECTION:NPROC==="
nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo "1"
echo "===SECTION:FREE==="
free -h 2>/dev/null || vm_stat 2>/dev/null
echo "===SECTION:DF==="
df -h -P 2>/dev/null
echo "===SECTION:RUNTIMES==="
which node >/dev/null 2>&1 && node -v || true
which python3 >/dev/null 2>&1 && python3 --version || true
which python >/dev/null 2>&1 && python --version || true
which docker >/dev/null 2>&1 && docker -v || true
which go >/dev/null 2>&1 && go version || true
which rustc >/dev/null 2>&1 && rustc --version || true
which java >/dev/null 2>&1 && java -version 2>&1 | head -n 1 || true
which git >/dev/null 2>&1 && git --version || true
echo "===SECTION:PKG==="
which apt >/dev/null 2>&1 && echo "apt" || true
which apk >/dev/null 2>&1 && echo "apk" || true
which dnf >/dev/null 2>&1 && echo "dnf" || true
which yum >/dev/null 2>&1 && echo "yum" || true
which pacman >/dev/null 2>&1 && echo "pacman" || true
which brew >/dev/null 2>&1 && echo "brew" || true
which nix >/dev/null 2>&1 && echo "nix" || true
echo "===SECTION:PORTS==="
(ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null || lsof -i -P -n 2>/dev/null) | grep -E "LISTEN" | awk '{print $4, $5, $1}' | head -n 20
echo "===SECTION:GIT==="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "GIT:YES"
  git branch --show-current 2>/dev/null || git rev-parse --short HEAD
  git status --short 2>/dev/null | head -n 10
else
  echo "GIT:NO"
fi
echo "===SECTION:CWD==="
pwd
`

  const res = await session.exec(probeScript, 15000)
  const sections = parseSections(res.stdout)

  // Parse OS
  let osName = "Unknown"
  const osRaw = sections["OS"] || ""
  const prettyMatch = osRaw.match(/PRETTY_NAME="([^"]+)"/)
  if (prettyMatch) {
    osName = prettyMatch[1]
  } else {
    osName = osRaw.split("\n")[0] || "Linux"
  }

  // Parse Uname
  const unameParts = (sections["UNAME"] || "").trim().split(/\s+/)
  const kernel = unameParts.slice(0, 2).join(" ")
  const hostname = unameParts[2] || ""
  const arch = unameParts[3] || ""

  // Parse Uptime
  const uptimeRaw = (sections["UPTIME"] || "").trim()

  // Parse Memory
  const freeRaw = sections["FREE"] || ""
  const memLines = freeRaw.split("\n").filter((l) => l.toLowerCase().startsWith("mem:"))
  let memInfo = { total: "N/A", used: "N/A", free: "N/A", available: "N/A" }
  if (memLines.length > 0) {
    const parts = memLines[0].split(/\s+/)
    memInfo = {
      total: parts[1] || "N/A",
      used: parts[2] || "N/A",
      free: parts[3] || "N/A",
      available: parts[6] || parts[3] || "N/A",
    }
  }

  // Parse Disk (df)
  const dfRaw = sections["DF"] || ""
  const dfLines = dfRaw.split("\n").slice(1)
  const diskList: SystemInspectionReport["disk"] = []
  for (const line of dfLines) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 6) {
      diskList.push({
        filesystem: parts[0],
        size: parts[1],
        used: parts[2],
        avail: parts[3],
        usePercent: parts[4],
        mountedOn: parts[5],
      })
    }
  }

  // Parse Package Managers
  const pkgList = (sections["PKG"] || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)

  // Parse Runtimes
  const runtimes: Record<string, string> = {}
  for (const line of (sections["RUNTIMES"] || "").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("v") || trimmed.startsWith("node")) runtimes["node"] = trimmed
    else if (trimmed.toLowerCase().includes("python 3")) runtimes["python3"] = trimmed
    else if (trimmed.toLowerCase().includes("python 2")) runtimes["python"] = trimmed
    else if (trimmed.toLowerCase().includes("docker version")) runtimes["docker"] = trimmed
    else if (trimmed.toLowerCase().includes("go version")) runtimes["go"] = trimmed
    else if (trimmed.toLowerCase().includes("rustc")) runtimes["rustc"] = trimmed
    else if (trimmed.toLowerCase().includes("openjdk") || trimmed.toLowerCase().includes("java"))
      runtimes["java"] = trimmed
    else if (trimmed.toLowerCase().includes("git version")) runtimes["git"] = trimmed
  }

  // Parse Listening Ports
  const listening = (sections["PORTS"] || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)

  // Parse Git
  const gitRaw = sections["GIT"] || ""
  let gitRepo: SystemInspectionReport["gitRepo"] = undefined
  if (gitRaw.includes("GIT:YES")) {
    const gitLines = gitRaw.split("\n").map((l) => l.trim()).filter((l) => l && l !== "GIT:YES")
    gitRepo = {
      isRepo: true,
      branch: gitLines[0] || "HEAD",
      status: gitLines.slice(1).join("\n"),
    }
  }

  return {
    os: osName,
    kernel,
    hostname,
    arch,
    uptime: uptimeRaw,
    loadAverage: uptimeRaw.split("load average:")[1]?.trim() || "N/A",
    cpuCount: (sections["NPROC"] || "1").trim(),
    memory: memInfo,
    disk: diskList,
    packageManagers: pkgList,
    runtimes,
    listeningPorts: listening,
    currentCwd: (sections["CWD"] || "").trim(),
    gitRepo,
  }
}

function parseSections(raw: string): Record<string, string> {
  const map: Record<string, string> = {}
  const regex = /===SECTION:([A-Z_]+)===\n([\s\S]*?)(?=(===SECTION:|$))/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(raw)) !== null) {
    const name = match[1]
    const content = match[2]
    map[name] = content
  }

  return map
}
