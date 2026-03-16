import { existsSync, cpSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'path'
import os from 'os'

/**
 * Install skills from a GitHub repo's skills/ subdirectory.
 * Shallow-clones the repo, copies skills/ to destDir, cleans up.
 *
 * @param {string} repo - GitHub repo URL or shorthand (e.g. "anthropics/skills")
 * @param {string} destDir - Destination directory (e.g. "{workspace}/.claude/skills")
 * @param {object} [opts]
 * @param {string} [opts.subdir] - Subdirectory within repo to copy from (default: "skills")
 * @param {string} [opts.label] - Label for logging (default: repo name)
 */
export function installSkillsFromRepo(repo, destDir, opts = {}) {
  const { subdir = 'skills', label } = opts
  const repoUrl = repo.startsWith('http') ? repo : `https://github.com/${repo}.git`
  const name = label || repo.split('/').pop()
  const tmpDir = path.join(os.tmpdir(), `skills-${name}-${Date.now()}`)

  try {
    execFileSync('git', ['clone', '--depth', '1', repoUrl, tmpDir], { stdio: 'ignore' })
    const srcSkills = path.join(tmpDir, subdir)
    if (existsSync(srcSkills)) {
      cpSync(srcSkills, destDir, { recursive: true })
      console.log(`[Skills] Installed ${name} from GitHub`)
    }
  } catch (err) {
    console.log(`[Skills] Could not fetch ${name}:`, err.message)
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}
