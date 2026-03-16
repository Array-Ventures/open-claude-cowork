import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'path'
import os from 'os'

const execAsync = promisify(exec)

/**
 * Create Obsidian MCP server — single pass-through tool wrapping the CLI.
 * Runs in the gateway process (unsandboxed), so XPC/IPC works fine.
 * The agent already knows CLI syntax from MEMORY.md and obsidian-cli skill.
 */
export function createObsidianMcpServer() {
  const obsidianPath = path.join(os.homedir(), '.local', 'bin', 'obsidian')
  const text = (str) => ({ content: [{ type: 'text', text: str }] })

  return createSdkMcpServer({
    name: 'obsidian',
    version: '1.0.0',
    tools: [
      tool(
        'cli',
        'Run an Obsidian CLI command. Pass the full argument string after "obsidian". Examples: search query="term" format=json, read file="Note Name", base:query path="pipeline/board.base" format=json, append file="Note" content="text", property:set name="status" value="done" file="Note", tasks todo, tags counts, backlinks file="Note"',
        { args: z.string().describe('CLI arguments, e.g. search query="term" format=json') },
        async ({ args }) => {
          try {
            const { stdout, stderr } = await execAsync(
              `"${obsidianPath}" ${args}`,
              { timeout: 15000 }
            )
            return text(stdout || stderr || '(no output)')
          } catch (err) {
            if (err.killed) {
              return text(`Error: command timed out after 15s\n${err.stdout || ''}`)
            }
            return text(`Error: ${err.message}\n${err.stdout || ''}${err.stderr || ''}`)
          }
        }
      ),
    ]
  })
}
