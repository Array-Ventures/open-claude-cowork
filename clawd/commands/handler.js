/**
 * Slash command handler for Clawd
 * Processes commands like /new, /reset, /status
 */
export default class CommandHandler {
  constructor(gateway) {
    this.gateway = gateway
  }

  /**
   * Check if message is a command
   */
  isCommand(text) {
    return text.trim().startsWith('/')
  }

  /**
   * Parse command and arguments
   */
  parse(text) {
    const trimmed = text.trim()
    const spaceIndex = trimmed.indexOf(' ')
    if (spaceIndex === -1) {
      return { command: trimmed.slice(1).toLowerCase(), args: '' }
    }
    return {
      command: trimmed.slice(1, spaceIndex).toLowerCase(),
      args: trimmed.slice(spaceIndex + 1).trim()
    }
  }

  /**
   * Execute a command
   * @returns {Object} { handled: boolean, response?: string }
   */
  async execute(text, sessionKey, adapter, chatId) {
    if (!this.isCommand(text)) {
      return { handled: false }
    }

    const { command, args } = this.parse(text)

    switch (command) {
      case 'new':
      case 'reset':
        return this.handleReset(sessionKey, adapter, chatId)

      case 'status':
        return this.handleStatus(sessionKey)

      case 'queue':
        return this.handleQueue()

      case 'help':
        return this.handleHelp()

      case 'stop':
        return this.handleStop(sessionKey)

      case 'reindex':
        return this.handleReindex(args)

      default:
        // Unknown command, pass to agent
        return { handled: false }
    }
  }

  async handleReset(sessionKey, adapter, chatId) {
    // Clear the session
    const sessionManager = this.gateway.sessionManager
    const agentRunner = this.gateway.agentRunner

    // Delete session from agent (SessionStore auto-saves on delete)
    if (agentRunner.agent.sessions.has(sessionKey)) {
      agentRunner.agent.sessions.delete(sessionKey)
    }

    // Clear transcript
    if (sessionManager.sessions.has(sessionKey)) {
      sessionManager.sessions.delete(sessionKey)
    }

    return {
      handled: true,
      response: '🔄 Session reset. Starting fresh!'
    }
  }

  handleStatus(sessionKey) {
    const sessionManager = this.gateway.sessionManager
    const agentRunner = this.gateway.agentRunner

    const session = sessionManager.sessions.get(sessionKey)
    const agentSession = agentRunner.agent.sessions.get(sessionKey)
    const queueStatus = agentRunner.getQueueStatus(sessionKey)
    const globalStats = agentRunner.getGlobalStats()

    const lines = [
      '📊 *Status*',
      '',
      `*Session:* ${sessionKey.split(':').slice(-2).join(':')}`,
      `*Messages:* ${agentSession?.messageCount || 0}`,
      `*Queue:* ${queueStatus.pending} pending${queueStatus.processing ? ' (processing)' : ''}`,
      '',
      `*Global:* ${globalStats.totalProcessed} processed, ${globalStats.totalFailed} failed`
    ]

    return {
      handled: true,
      response: lines.join('\n')
    }
  }

  handleQueue() {
    const stats = this.gateway.agentRunner.getGlobalStats()

    const lines = [
      '📋 *Queue Status*',
      '',
      `*Pending:* ${stats.totalPending}`,
      `*Active sessions:* ${stats.activeSessions}`,
      `*Total sessions:* ${stats.totalSessions}`,
      '',
      `*Processed:* ${stats.totalProcessed}`,
      `*Failed:* ${stats.totalFailed}`
    ]

    return {
      handled: true,
      response: lines.join('\n')
    }
  }

  handleStop(sessionKey) {
    const aborted = this.gateway.agentRunner.abort(sessionKey)
    return {
      handled: true,
      response: aborted ? '⏹️ Stopped current operation' : '⏹️ Nothing to stop'
    }
  }

  async handleReindex(args) {
    const indexer = this.gateway.agentRunner.agent.indexer

    if (!indexer.enabled) {
      return { handled: true, response: 'Indexing is not enabled. Set indexing.enabled: true in config.js' }
    }

    const installed = await indexer.checkInstalled()
    if (!installed) {
      return { handled: true, response: 'LEANN not found. Install with: uv tool install leann-core --with leann' }
    }

    if (indexer.indexing) {
      return { handled: true, response: '⏳ Index build already in progress' }
    }

    const force = args.includes('--force')
    const sourceName = args.replace('--force', '').trim()

    if (sourceName) {
      const source = indexer.sources.find(s => s.name === sourceName)
      if (!source) {
        const available = indexer.sources.map(s => s.name).join(', ')
        return { handled: true, response: `Source "${sourceName}" not found. Available: ${available}` }
      }

      const result = await indexer.buildIndex(source, { force })
      if (result.success) {
        return { handled: true, response: `✅ Rebuilt "${source.name}" in ${result.elapsed}s` }
      }
      return { handled: true, response: `❌ Failed to build "${source.name}": ${result.error || result.reason}` }
    }

    // Build all
    const results = await indexer.buildAll({ force })
    const success = results.filter(r => r.success)
    const failed = results.filter(r => !r.success)

    const lines = [`🔄 Reindex complete: ${success.length}/${results.length} sources`]
    for (const r of success) {
      lines.push(`  ✅ ${r.source} (${r.elapsed}s)`)
    }
    for (const r of failed) {
      lines.push(`  ❌ ${r.reason}`)
    }

    return { handled: true, response: lines.join('\n') }
  }

  handleHelp() {
    const lines = [
      '📖 *Commands*',
      '',
      '`/new` or `/reset` - Start fresh session',
      '`/status` - Show session status',
      '`/queue` - Show queue status',
      '`/stop` - Stop current operation',
      '`/reindex` - Rebuild workspace index',
      '`/reindex <source> --force` - Force rebuild a source',
      '`/help` - Show this help'
    ]

    return {
      handled: true,
      response: lines.join('\n')
    }
  }
}
