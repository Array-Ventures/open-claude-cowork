import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { syncTranscripts, watchTranscripts } from './transcript-sync.js'

const execFileAsync = promisify(execFile)
const BUILD_TIMEOUT = 5 * 60 * 1000 // 5 minutes
const WATCH_INTERVAL = 10 // seconds

/**
 * Workspace Indexer for Clawd
 * Manages LEANN-based semantic indexing of workspace and other sources.
 * Extensible via config.sources for transcripts, conversations, app integrations.
 *
 * Flow per source: build index (if not exists) → spawn `leann watch` if available.
 */
export default class WorkspaceIndexer {
  constructor(workspace, config = {}) {
    this.workspace = workspace
    this.enabled = config.enabled || false
    this.sources = config.sources || [
      { name: 'workspace', type: 'workspace' }
    ]
    this.installed = null // null = unchecked, true/false after check
    this.hasWatch = null // null = unchecked, true/false
    this.watchers = new Map() // source.name → child process
    this.syncWatchers = new Map() // source.name → FSWatcher
  }

  /**
   * Check if leann is installed (caches result, auto-installs if missing)
   */
  async checkInstalled() {
    if (this.installed !== null) return this.installed

    try {
      // leann has no --version flag; use `leann list` as a quick check
      await execFileAsync('leann', ['list'], { timeout: 10000, cwd: this.workspace })
      this.installed = true
      console.log('[Indexing] LEANN is installed')
    } catch {
      console.log('[Indexing] LEANN not found, attempting install...')
      this.installed = await this.install()
    }

    // Check if watch command is available (not in all versions)
    if (this.installed) {
      try {
        const { stderr } = await execFileAsync('leann', ['watch', '--help'], { timeout: 5000, cwd: this.workspace })
        this.hasWatch = true
      } catch {
        this.hasWatch = false
      }
    }

    return this.installed
  }

  /**
   * Auto-install LEANN via uv tool install
   */
  async install() {
    try {
      await execFileAsync('uv', ['tool', 'install', 'leann-core', '--with', 'leann'], {
        timeout: 120000,
      })
      console.log('[Indexing] LEANN installed successfully')
      return true
    } catch (err) {
      console.warn('[Indexing] Failed to install LEANN:', err.message)
      console.warn('[Indexing] Install manually with: uv tool install leann-core --with leann')
      return false
    }
  }

  /**
   * Get the --docs argument for leann build based on source type
   */
  getDocsArgs(source) {
    switch (source.type) {
      case 'workspace':
        return [this.workspace]
      case 'directory':
        return [source.path]
      case 'transcripts':
        return [path.join(os.homedir(), '.clawd', 'transcripts')]
      default:
        return [this.workspace]
    }
  }

  /**
   * Check if an index already exists for a source.
   * LEANN stores indexes in .leann/<name>/ relative to where build was run (process cwd).
   */
  indexExists(sourceName) {
    const indexDir = path.join(this.workspace, '.leann', sourceName)
    return fs.existsSync(indexDir)
  }

  /**
   * Build index for a single source (one-shot, used by /reindex and startWatcher)
   */
  async buildIndex(source, options = {}) {
    const installed = await this.checkInstalled()
    if (!installed) {
      return { success: false, reason: 'not_installed' }
    }

    // Skip if index exists and not forcing
    if (!options.force && this.indexExists(source.name)) {
      console.log(`[Indexing] Index "${source.name}" already exists, skipping build`)
      return { success: true, source: source.name, skipped: true }
    }

    // For transcripts, sync .jsonl → .md before building
    if (source.type === 'transcripts') {
      const outputDir = path.join(os.homedir(), '.clawd', 'transcripts')
      console.log(`[Indexing] Syncing transcripts to ${outputDir}...`)
      const syncStats = await syncTranscripts(outputDir, { force: options.force, workspace: this.workspace })
      console.log(`[Indexing] Transcripts synced: ${syncStats.parsed} new, ${syncStats.skipped} skipped, ${syncStats.failed} failed`)
    }

    const startTime = Date.now()

    try {
      const args = ['build', source.name, '--docs', ...this.getDocsArgs(source)]

      // Hidden dirs (e.g. ~/.clawd/transcripts) need --include-hidden
      const docsArgs = this.getDocsArgs(source)
      if (docsArgs.some(p => p.split('/').some(seg => seg.startsWith('.')))) {
        args.push('--include-hidden')
      }

      if (options.force) {
        args.push('--force')
      }

      console.log(`[Indexing] Building: leann ${args.join(' ')}`)

      const { stdout, stderr } = await execFileAsync('leann', args, {
        timeout: BUILD_TIMEOUT,
        cwd: this.workspace,
      })

      if (stdout) console.log(`[Indexing] ${stdout.trim()}`)
      if (stderr) console.log(`[Indexing] ${stderr.trim()}`)

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`[Indexing] Built "${source.name}" in ${elapsed}s`)

      return { success: true, source: source.name, elapsed }
    } catch (err) {
      console.error(`[Indexing] Failed to build "${source.name}":`, err.message)
      return { success: false, reason: 'build_failed', error: err.message }
    }
  }

  /**
   * Build all enabled sources (used by /reindex)
   */
  async buildAll(options = {}) {
    const results = []
    for (const source of this.sources) {
      const result = await this.buildIndex(source, options)
      results.push(result)
    }
    return results
  }

  /**
   * Start watcher for a single source: build if needed, then spawn leann watch
   */
  async startWatcher(source) {
    // Build if index doesn't exist yet
    const buildResult = await this.buildIndex(source)
    if (!buildResult.success) return buildResult

    // For transcripts, start fs.watch to sync new .jsonl → .md regardless of LEANN watch
    if (source.type === 'transcripts') {
      const fsWatcher = watchTranscripts(undefined, this.workspace)
      if (fsWatcher) this.syncWatchers.set(source.name, fsWatcher)
    }

    // Spawn leann watch if available
    if (!this.hasWatch) {
      console.log(`[Indexing] Watch not available in this LEANN version, index built once`)
      return { success: true, source: source.name, watching: false }
    }

    const args = ['watch', source.name, '--interval', String(WATCH_INTERVAL)]
    console.log(`[Indexing] Watching "${source.name}" (interval=${WATCH_INTERVAL}s)`)

    const child = spawn('leann', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: this.workspace,
    })

    child.stdout.on('data', (data) => {
      const msg = data.toString().trim()
      if (msg) console.log(`[Indexing:${source.name}] ${msg}`)
    })

    child.stderr.on('data', (data) => {
      const msg = data.toString().trim()
      if (msg) console.log(`[Indexing:${source.name}] ${msg}`)
    })

    child.on('exit', (code) => {
      this.watchers.delete(source.name)
      if (code !== null && code !== 0) {
        console.error(`[Indexing] Watcher "${source.name}" exited with code ${code}`)
      }
    })

    this.watchers.set(source.name, child)
    return { success: true, source: source.name, watching: true }
  }

  /**
   * Start watchers for all sources
   */
  async startWatchers() {
    const installed = await this.checkInstalled()
    if (!installed) return

    for (const source of this.sources) {
      await this.startWatcher(source)
    }
  }

  /**
   * Stop all watchers (for clean shutdown)
   */
  stopWatchers() {
    for (const [name, child] of this.watchers) {
      console.log(`[Indexing] Stopping watcher "${name}"`)
      child.kill()
    }
    this.watchers.clear()

    for (const [name, watcher] of this.syncWatchers) {
      watcher.close()
    }
    this.syncWatchers.clear()
  }

  /**
   * Get status info
   */
  async getStatus() {
    const installed = await this.checkInstalled()
    return {
      enabled: this.enabled,
      installed,
      hasWatch: this.hasWatch,
      sources: this.sources.map(s => ({
        name: s.name,
        type: s.type,
        watching: this.watchers.has(s.name),
        indexed: this.indexExists(s.name),
      })),
    }
  }

  /**
   * Get LEANN MCP server config for the agent SDK
   * Returns null if not enabled
   */
  getLeannMcpServerConfig() {
    if (!this.enabled) return null

    return {
      type: 'stdio',
      command: 'leann_mcp',
    }
  }
}
