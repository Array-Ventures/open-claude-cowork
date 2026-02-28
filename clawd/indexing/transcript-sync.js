import fs from 'fs'
import path from 'path'
import os from 'os'
import { parseTranscriptFile } from './transcript-parser.js'

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
const DEBOUNCE_MS = 30_000 // 30s — sessions write constantly, no need to re-parse every keystroke

/**
 * Convert a workspace path to Claude Code's project directory name.
 * e.g. /Users/parthmodi/clawd → -Users-parthmodi-clawd
 */
function workspaceToProjectDir(workspace) {
  const resolved = path.resolve(workspace)
  return resolved.replace(/\//g, '-')
}

/**
 * Discover Claude Code session .jsonl files for a specific workspace.
 * Only scans the project directory matching the workspace path.
 * Skips subagent files — they're only useful in context of parent session.
 */
export async function discoverSessions(workspace) {
  const sessions = []

  if (!workspace) return sessions

  const project = workspaceToProjectDir(workspace)
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, project)

  const stat = await fs.promises.stat(projectDir).catch(() => null)
  if (!stat?.isDirectory()) return sessions

  const entries = await fs.promises.readdir(projectDir)
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue
    const fullPath = path.join(projectDir, entry)
    const entryStat = await fs.promises.stat(fullPath).catch(() => null)
    if (!entryStat?.isFile()) continue

    sessions.push({
      path: fullPath,
      project,
      sessionId: path.basename(entry, '.jsonl'),
      mtime: entryStat.mtimeMs,
      size: entryStat.size,
    })
  }

  return sessions
}

/**
 * Sync transcripts: parse new/modified sessions and write .md files.
 * Returns stats: { total, parsed, skipped, failed }
 */
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), '.clawd', 'transcripts')

export async function syncTranscripts(outputDir = DEFAULT_OUTPUT_DIR, options = {}) {
  await fs.promises.mkdir(outputDir, { recursive: true })

  const sessions = await discoverSessions(options.workspace)
  const stats = { total: sessions.length, parsed: 0, skipped: 0, failed: 0 }

  for (const session of sessions) {
    const outFile = path.join(outputDir, `${session.project}__${session.sessionId}.md`)

    // Skip if output exists and source hasn't changed (unless forcing)
    if (!options.force) {
      const outStat = await fs.promises.stat(outFile).catch(() => null)
      if (outStat && outStat.mtimeMs >= session.mtime) {
        stats.skipped++
        continue
      }
    }

    try {
      const markdown = await parseTranscriptFile(session.path)
      if (markdown) {
        await fs.promises.writeFile(outFile, markdown, 'utf-8')
        stats.parsed++
      } else {
        stats.skipped++
      }
    } catch (err) {
      console.error(`[Transcripts] Failed to parse ${session.sessionId}:`, err.message)
      stats.failed++
    }
  }

  return stats
}

/**
 * Watch ~/.claude/projects/ for .jsonl changes and re-parse on change.
 * Debounces per file (30s) since active sessions write constantly.
 * Returns the FSWatcher for cleanup.
 */
export function watchTranscripts(outputDir = DEFAULT_OUTPUT_DIR, workspace) {
  if (!workspace) return null

  const project = workspaceToProjectDir(workspace)
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, project)

  if (!fs.existsSync(projectDir)) return null

  fs.mkdirSync(outputDir, { recursive: true })

  const timers = new Map() // filePath → timeout

  // Watch only the workspace's project directory
  const watcher = fs.watch(projectDir, {}, (eventType, filename) => {
    if (!filename || !filename.endsWith('.jsonl')) return

    const fullPath = path.join(projectDir, filename)

    // Clear existing timer for this file
    const existing = timers.get(fullPath)
    if (existing) clearTimeout(existing)

    // Debounce: wait 30s after last write before parsing
    timers.set(fullPath, setTimeout(async () => {
      timers.delete(fullPath)
      try {
        const stat = await fs.promises.stat(fullPath).catch(() => null)
        if (!stat?.isFile()) return

        const sessionId = path.basename(filename, '.jsonl')
        const outFile = path.join(outputDir, `${project}__${sessionId}.md`)

        const markdown = await parseTranscriptFile(fullPath)
        if (markdown) {
          await fs.promises.writeFile(outFile, markdown, 'utf-8')
          console.log(`[Transcripts] Synced ${sessionId}`)
        }
      } catch (err) {
        console.error(`[Transcripts] Watch sync failed:`, err.message)
      }
    }, DEBOUNCE_MS))
  })

  watcher.on('error', (err) => {
    console.error('[Transcripts] Watch error:', err.message)
  })

  console.log(`[Transcripts] Watching ${project} for changes`)
  return watcher
}
