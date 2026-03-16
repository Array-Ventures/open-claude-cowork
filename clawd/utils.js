import path from 'path'
import os from 'os'

/**
 * Convert a workspace path to Claude Code's project directory name.
 * e.g. /Users/parthmodi/clawd → -Users-parthmodi-clawd
 */
export function workspaceToProjectDir(workspace) {
  const resolved = path.resolve(workspace)
  return resolved.replace(/\//g, '-')
}

/**
 * Get the Claude Code project directory for a workspace.
 * e.g. /Users/parthmodi/clawd → ~/.claude/projects/-Users-parthmodi-clawd
 */
export function getClaudeProjectDir(workspace) {
  return path.join(os.homedir(), '.claude', 'projects', workspaceToProjectDir(workspace))
}
