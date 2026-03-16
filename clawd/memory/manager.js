import { existsSync, copyFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import path from 'path'
import { getClaudeProjectDir } from '../utils.js'
import { installSkillsFromRepo } from '../utils/skill-installer.js'

export default class MemoryManager {
  constructor(workspace, srcRoot) {
    this.workspace = workspace
    this.srcRoot = srcRoot
    this.memoryDir = getClaudeProjectDir(workspace) + '/memory'
    this.syncProcess = null
  }

  seed() {
    this.seedClaudeMd()
  }

  seedClaudeMd() {
    const dest = path.join(this.workspace, 'CLAUDE.md')
    const src = path.join(this.srcRoot, 'CLAUDE.md')
    if (existsSync(dest) || !existsSync(src)) return
    copyFileSync(src, dest)
    console.log('[Memory] Seeded CLAUDE.md in workspace')
  }

  async seedSkills() {
    const destDir = path.join(this.workspace, '.claude', 'skills')
    installSkillsFromRepo('anthropics/skills', destDir, { label: 'anthropic' })
  }

  startHeadlessSync() {
    const token = process.env.OBSIDIAN_AUTH_TOKEN
    const vault = process.env.OBSIDIAN_VAULT_NAME
    if (!token || !vault) return

    let obPath
    try {
      obPath = execFileSync('which', ['ob'], { encoding: 'utf8' }).trim()
    } catch {
      console.log('[Memory] obsidian-headless not installed, skipping sync')
      return
    }

    if (!existsSync(path.join(this.memoryDir, '.obsidian'))) {
      try {
        execFileSync(obPath, [
          'sync-setup',
          '--vault', vault,
          '--path', this.memoryDir,
        ], {
          env: { ...process.env, OBSIDIAN_AUTH_TOKEN: token },
          stdio: 'inherit',
        })
      } catch (err) {
        console.error('[Memory] Failed to setup Obsidian sync:', err.message)
        return
      }
    }

    this.syncProcess = spawn(obPath, ['sync', '--continuous', '--path', this.memoryDir], {
      env: { ...process.env, OBSIDIAN_AUTH_TOKEN: token },
      stdio: 'ignore',
      detached: true,
    })
    this.syncProcess.unref()
    console.log(`[Memory] Headless sync started (pid: ${this.syncProcess.pid})`)
  }

  stopHeadlessSync() {
    if (this.syncProcess) {
      this.syncProcess.kill()
      this.syncProcess = null
      console.log('[Memory] Headless sync stopped')
    }
  }
}
