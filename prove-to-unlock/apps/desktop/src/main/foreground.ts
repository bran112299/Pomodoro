// Which app is in front right now, per OS, without native modules or special permissions:
//   macOS   `lsappinfo` (ships with macOS, no Accessibility/Screen Recording permission needed)
//   Windows one long-lived PowerShell process calling user32!GetForegroundWindow
//   Linux   `xdotool` when available (X11); otherwise detection is unavailable

import { type ChildProcess, execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface ForegroundApp {
  pid: number;
  /** Display name, e.g. "Safari" or "chrome". */
  name: string;
  /** macOS bundle id or Windows/Linux executable path, when known. */
  id: string;
}

// ---------------------------------------------------------------------------------- parsers

/** Parse `lsappinfo front` output: "ASN:0x0-0x1a01a:" */
export function parseLsappinfoFront(out: string): string | null {
  const m = /(ASN:0x[0-9a-f]+-0x[0-9a-f]+:)/i.exec(out);
  return m ? m[1]! : null;
}

/** Parse `lsappinfo info <ASN>` output. */
export function parseLsappinfoInfo(out: string): ForegroundApp | null {
  const name = /^\s*"([^"]+)"\s+ASN:/m.exec(out)?.[1];
  const bundle = /bundleID="([^"]*)"/.exec(out)?.[1];
  const pid = Number(/\bpid\s*=\s*(\d+)/.exec(out)?.[1]);
  if (!name || !Number.isFinite(pid)) return null;
  return { pid, name, id: bundle ?? "" };
}

/** Parse one JSON line from the Windows watcher. */
export function parseWindowsLine(line: string): ForegroundApp | null {
  try {
    const o = JSON.parse(line) as { pid?: number; name?: string; path?: string | null };
    if (!o || typeof o.pid !== "number" || o.pid <= 0) return null;
    return { pid: o.pid, name: o.name ?? "", id: o.path ?? "" };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------- watchers

export interface ForegroundWatcher {
  readonly supported: boolean;
  current(): ForegroundApp | null;
  stop(): void;
}

class MacWatcher implements ForegroundWatcher {
  readonly supported = true;
  private last: ForegroundApp | null = null;
  private timer: NodeJS.Timeout;
  private busy = false;

  constructor(intervalMs: number) {
    this.timer = setInterval(() => void this.poll(), intervalMs);
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const { stdout } = await execFileP("/usr/bin/lsappinfo", ["front"], { timeout: 2000 });
      const asn = parseLsappinfoFront(stdout);
      if (!asn) return;
      const info = await execFileP("/usr/bin/lsappinfo", ["info", asn], { timeout: 2000 });
      this.last = parseLsappinfoInfo(info.stdout);
    } catch {
      /* transient; keep last */
    } finally {
      this.busy = false;
    }
  }

  current() {
    return this.last;
  }
  stop() {
    clearInterval(this.timer);
  }
}

const WIN_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PtuFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
while ($true) {
  $h = [PtuFg]::GetForegroundWindow()
  $p = [uint32]0
  [void][PtuFg]::GetWindowThreadProcessId($h, [ref]$p)
  $proc = Get-Process -Id $p
  $o = @{ pid = [int]$p; name = if ($proc) { $proc.ProcessName } else { '' }; path = if ($proc) { $proc.Path } else { $null } }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds INTERVAL
}
`;

class WindowsWatcher implements ForegroundWatcher {
  readonly supported = true;
  private last: ForegroundApp | null = null;
  private child: ChildProcess | null = null;
  private stopped = false;
  private buf = "";

  constructor(private intervalMs: number) {
    this.start();
  }

  private start() {
    const script = WIN_SCRIPT.replace("INTERVAL", String(this.intervalMs));
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    this.child = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        const app = parseWindowsLine(line);
        if (app) this.last = app;
      }
    });
    child.on("exit", () => {
      this.child = null;
      if (!this.stopped) setTimeout(() => !this.stopped && this.start(), 3000);
    });
    child.on("error", () => undefined);
  }

  current() {
    return this.last;
  }
  stop() {
    this.stopped = true;
    this.child?.kill();
  }
}

class LinuxWatcher implements ForegroundWatcher {
  supported = true;
  private last: ForegroundApp | null = null;
  private timer: NodeJS.Timeout;

  constructor(intervalMs: number) {
    this.timer = setInterval(() => void this.poll(), intervalMs);
    void this.poll();
  }

  private async poll() {
    try {
      const { stdout } = await execFileP("xdotool", ["getactivewindow", "getwindowpid"], { timeout: 2000 });
      const pid = Number(stdout.trim());
      if (!pid) return;
      const exe = await import("node:fs").then((fs) => fs.promises.readlink(`/proc/${pid}/exe`).catch(() => ""));
      this.last = { pid, name: path.basename(exe), id: exe };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.supported = false;
        clearInterval(this.timer);
      }
    }
  }

  current() {
    return this.last;
  }
  stop() {
    clearInterval(this.timer);
  }
}

export function createForegroundWatcher(intervalMs = 1000): ForegroundWatcher {
  if (process.platform === "darwin") return new MacWatcher(intervalMs);
  if (process.platform === "win32") return new WindowsWatcher(intervalMs);
  return new LinuxWatcher(intervalMs);
}

// ---------------------------------------------------------------------------------- essentials

const ALWAYS_ESSENTIAL: Record<string, string[]> = {
  darwin: [
    "com.apple.finder",
    "com.apple.loginwindow",
    "com.apple.systempreferences",
    "com.apple.ActivityMonitor",
    "com.apple.dock",
    "com.apple.controlcenter",
    "com.apple.Spotlight",
    "com.apple.notificationcenterui",
    "com.apple.SecurityAgent",
    "com.apple.UserNotificationCenter",
    "com.apple.ScreenSaver.Engine",
    "com.apple.coreservices.uiagent",
    "com.apple.Passwords",
  ],
  win32: ["explorer", "searchhost", "searchapp", "startmenuexperiencehost", "shellexperiencehost", "lockapp", "logonui", "taskmgr", "consent", "textinputhost", "ctfmon", "systemsettings"],
  linux: ["gnome-shell", "plasmashell", "xfce4-panel", "nautilus", "dolphin"],
};

const BROWSERS: Record<string, string[]> = {
  darwin: ["com.google.Chrome", "org.mozilla.firefox", "com.apple.Safari", "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser", "com.operasoftware.Opera", "com.vivaldi.Vivaldi"],
  win32: ["chrome", "firefox", "msedge", "brave", "opera", "vivaldi", "arc"],
  linux: ["chrome", "chromium", "firefox", "brave", "msedge", "opera", "vivaldi-bin"],
};

function norm(s: string): string {
  return path
    .basename(s.replace(/\\/g, "/"))
    .replace(/\.(exe|app)$/i, "")
    .toLowerCase();
}

/**
 * Is this foreground app allowed while locked? Matches user entries against the bundle id,
 * executable name or display name (case-insensitive).
 */
export function isEssential(
  app: ForegroundApp,
  opts: { userApps: string[]; browsersEssential: boolean; selfPid: number; selfNames: string[]; platform?: string },
): boolean {
  const platform = opts.platform ?? process.platform;
  if (app.pid === opts.selfPid) return true;
  const candidates = new Set([app.name.toLowerCase(), norm(app.name), app.id.toLowerCase(), norm(app.id)].filter(Boolean));
  const allowed = [
    ...(ALWAYS_ESSENTIAL[platform] ?? []),
    ...(opts.browsersEssential ? (BROWSERS[platform] ?? []) : []),
    ...opts.userApps,
    ...opts.selfNames,
  ].map((s) => s.toLowerCase().trim());
  return allowed.some((a) => a && (candidates.has(a) || candidates.has(norm(a))));
}

/** Ask an app to quit the polite way (it can still prompt to save documents). */
export async function quitApp(app: ForegroundApp): Promise<void> {
  if (process.platform === "darwin" && app.id) {
    await execFileP("/usr/bin/osascript", ["-e", `tell application id "${app.id.replace(/"/g, "")}" to quit`], { timeout: 5000 });
  } else if (process.platform === "win32") {
    await execFileP("taskkill", ["/PID", String(app.pid)], { timeout: 5000, windowsHide: true });
  } else {
    process.kill(app.pid, "SIGTERM");
  }
}
