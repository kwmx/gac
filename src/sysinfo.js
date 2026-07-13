import fs from "fs";
import os from "os";
import process from "process";

export function parseOsRelease(contents) {
  const result = {};
  const lines = contents.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    let value = rest.join("=").trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (value) {
      result[key] = value;
    }
  }
  return result;
}

function readLinuxOsRelease() {
  try {
    const contents = fs.readFileSync("/etc/os-release", "utf8");
    return parseOsRelease(contents);
  } catch (err) {
    return null;
  }
}

export function getOSVersion() {
  const platform = os.platform();
  if (platform === "win32") {
    // Which version of Windows?
    if (process.env.OS_VERSION) {
      return `${platform}: ${process.env.OS_VERSION}`;
    } else if (process.env.OS_RELEASE) {
      return `${platform}: ${process.env.OS_RELEASE}`;
    } else if (process.env.OS) {
      return `${platform}: ${process.env.OS}`;
    } else {
      return "Windows";
    }
  } else if (platform === "darwin") {
    if (process.env.OS_VERSION) {
      return `${platform}: ${process.env.OS_VERSION}`;
    }
    if (process.env.OS_RELEASE) {
      return `${platform}: ${process.env.OS_RELEASE}`;
    }
    if (process.env.OS) {
      return `${platform}: ${process.env.OS}`;
    }
    return "macOS";
  }
  if (platform === "linux") {
    const osRelease = readLinuxOsRelease();
    if (osRelease && (osRelease.PRETTY_NAME || osRelease.NAME)) {
      const pretty = osRelease.PRETTY_NAME || osRelease.NAME;
      const id = osRelease.ID ? `; id=${osRelease.ID}` : "";
      const idLike = osRelease.ID_LIKE ? `; id_like=${osRelease.ID_LIKE}` : "";
      return `Linux (${pretty}${id}${idLike})`;
    }
    // Find which distro (fallbacks)
    if (process.env.OS_RELEASE) {
      return `${platform}: ${process.env.OS_RELEASE}`;
    } else if (process.env.OS) {
      return `${platform}: ${process.env.OS}`;
    } else if (process.env.LINUX_DISTRO) {
      return `${platform}: ${process.env.LINUX_DISTRO}`;
    }
    return `Linux`;
  }
  if (platform === "freebsd") {
    return "FreeBSD";
  }
  if (platform === "sunos") {
    return "SunOS";
  }
  if (platform === "aix") {
    return "AIX";
  }
  return "Unknown OS";
}

export function getOsGuidance() {
  const osInfo = getOSVersion();
  return `The user is using a system with the following OS: ${osInfo}. When providing commands or package install steps, use the native tooling for that OS (e.g., dnf for Fedora, apt for Debian/Ubuntu). Avoid giving instructions for other distros unless explicitly requested.`;
}

export function formatDirectoryListing(entries) {
  if (!entries.length) return "(empty)";
  return entries
    .map((entry) => {
      if (entry.isDirectory()) return `${entry.name}/`;
      if (entry.isSymbolicLink()) return `${entry.name}@`;
      return entry.name;
    })
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))
    .join("\n");
}

export function buildDirectoryContext() {
  const cwd = process.cwd();
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    const listing = formatDirectoryListing(entries);
    return `Current directory: ${cwd}\nls:\n${listing}`;
  } catch (err) {
    return `Current directory: ${cwd}\nls: (unavailable: ${err.message})`;
  }
}

export function buildRunbookContext() {
  const shell =
    os.platform() === "win32" ? "powershell.exe" : process.env.SHELL || "bash";
  const user = os.userInfo().username;
  return [
    buildDirectoryContext(),
    `Shell: ${shell}`,
    `Node.js: ${process.version}`,
    `User: ${user}`,
  ].join("\n");
}
