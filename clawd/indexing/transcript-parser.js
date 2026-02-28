import fs from 'fs'
import path from 'path'

const TOOL_OUTPUT_LIMIT = 500

/**
 * Parse a Claude Code .jsonl session file into readable markdown.
 */
export async function parseTranscriptFile(filePath) {
  const raw = await fs.promises.readFile(filePath, 'utf-8')
  const entries = []

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // skip malformed lines
    }
  }

  const toolResultMap = buildToolResultMap(entries)
  const metadata = {
    sessionId: path.basename(filePath, '.jsonl'),
    cwd: null,
    gitBranch: null,
    model: null,
    startTime: null,
    endTime: null,
  }
  const messages = []

  for (const entry of entries) {
    processEntry(entry, messages, metadata, toolResultMap)
  }

  if (messages.length === 0) return null
  return formatSession(metadata, messages)
}

/**
 * Pre-pass: build a map of tool_use_id → { text, isError }
 */
function buildToolResultMap(entries) {
  const map = new Map()

  for (const entry of entries) {
    if (entry.type !== 'user') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (block?.type !== 'tool_result') continue
      const tid = block.tool_use_id
      if (!tid) continue

      let text = ''
      const c = block.content
      if (typeof c === 'string') {
        text = c
      } else if (Array.isArray(c)) {
        text = c
          .filter(p => p?.type === 'text')
          .map(p => p.text || '')
          .join('\n')
      }

      map.set(tid, {
        text: text.trim(),
        isError: !!block.is_error,
      })
    }
  }

  return map
}

/**
 * Process a single JSONL entry into the messages array.
 */
function processEntry(entry, messages, metadata, toolResultMap) {
  const ts = entry.timestamp || null

  // Capture metadata from first entry that has it
  if (!metadata.cwd && entry.cwd) {
    metadata.cwd = entry.cwd
    metadata.gitBranch = entry.gitBranch || null
    metadata.sessionId = entry.sessionId || metadata.sessionId
  }

  if (entry.type === 'user') {
    const text = extractUserText(entry)
    if (text) {
      messages.push({ role: 'user', text, ts })
      updateTimeBounds(metadata, ts)
    }
  } else if (entry.type === 'assistant') {
    const msg = extractAssistantContent(entry, toolResultMap)
    if (msg) {
      if (!metadata.model) {
        metadata.model = entry.message?.model || null
      }
      msg.ts = ts
      messages.push(msg)
      updateTimeBounds(metadata, ts)
    }
  }
}

/**
 * Extract text from a user entry. Returns null if only tool_result blocks.
 */
function extractUserText(entry) {
  const content = entry.message?.content
  if (typeof content === 'string') return content.trim() || null

  if (Array.isArray(content)) {
    const texts = content
      .filter(b => b?.type === 'text')
      .map(b => b.text?.trim())
      .filter(Boolean)
    return texts.length > 0 ? texts.join('\n') : null
  }

  return null
}

/**
 * Extract text, tool uses from an assistant entry.
 */
function extractAssistantContent(entry, toolResultMap) {
  const content = entry.message?.content
  if (!Array.isArray(content)) return null

  const textParts = []
  const toolUses = []

  for (const block of content) {
    if (block?.type === 'text' && block.text?.trim()) {
      textParts.push(block.text.trim())
    } else if (block?.type === 'tool_use') {
      const tu = {
        tool: block.name,
        input: summarizeToolInput(block.name, block.input || {}),
      }
      const result = toolResultMap.get(block.id)
      if (result) {
        tu.output = truncate(result.text, TOOL_OUTPUT_LIMIT)
        tu.isError = result.isError
      }
      toolUses.push(tu)
    }
  }

  if (textParts.length === 0 && toolUses.length === 0) return null

  return {
    role: 'assistant',
    text: textParts.join('\n\n') || null,
    toolUses: toolUses.length > 0 ? toolUses : null,
  }
}

/**
 * Summarize tool input to a short human-readable string.
 */
function summarizeToolInput(toolName, input) {
  switch (toolName) {
    case 'Read':
      return input.file_path || ''
    case 'Write':
      return input.file_path || ''
    case 'Edit':
      return input.file_path || ''
    case 'Bash':
      return input.command ? truncate(input.command, 200) : ''
    case 'Glob':
      return input.pattern || ''
    case 'Grep':
      return input.pattern ? `/${input.pattern}/` : ''
    case 'WebSearch':
      return input.query || ''
    case 'WebFetch':
      return input.url || ''
    case 'Task':
      return input.prompt ? truncate(input.prompt, 100) : ''
    default:
      // For MCP tools and others, show first meaningful string value
      for (const [k, v] of Object.entries(input)) {
        if (typeof v === 'string' && v.length > 0) {
          return truncate(v, 100)
        }
      }
      return ''
  }
}

/**
 * Format session metadata + messages into readable markdown.
 */
function formatSession(metadata, messages) {
  const lines = []

  lines.push(`# Session: ${metadata.sessionId}`)
  const meta = []
  if (metadata.model) meta.push(`Model: ${metadata.model}`)
  if (metadata.gitBranch) meta.push(`Branch: ${metadata.gitBranch}`)
  if (metadata.cwd) meta.push(`CWD: ${metadata.cwd}`)
  if (meta.length) lines.push(meta.join(' | '))

  if (metadata.startTime || metadata.endTime) {
    const start = metadata.startTime ? new Date(metadata.startTime).toLocaleString() : '?'
    const end = metadata.endTime ? new Date(metadata.endTime).toLocaleString() : '?'
    lines.push(`Time: ${start} → ${end}`)
  }

  lines.push('', '---', '')

  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push(`**User:**`)
      lines.push(msg.text)
      lines.push('')
    } else if (msg.role === 'assistant') {
      lines.push(`**Assistant:**`)
      if (msg.text) {
        lines.push(msg.text)
      }
      if (msg.toolUses) {
        for (const tu of msg.toolUses) {
          const inputSummary = tu.input ? ` → \`${tu.input}\`` : ''
          lines.push(``)
          lines.push(`**Tool: ${tu.tool}**${inputSummary}`)
          if (tu.output) {
            const prefix = tu.isError ? '[ERROR] ' : ''
            lines.push('```')
            lines.push(prefix + tu.output)
            lines.push('```')
          }
        }
      }
      lines.push('')
      lines.push('---')
      lines.push('')
    }
  }

  return lines.join('\n')
}

function updateTimeBounds(metadata, ts) {
  if (!ts) return
  if (!metadata.startTime || ts < metadata.startTime) metadata.startTime = ts
  if (!metadata.endTime || ts > metadata.endTime) metadata.endTime = ts
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str
  return str.slice(0, maxLen) + '...'
}
