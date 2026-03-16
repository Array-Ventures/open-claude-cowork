import { loadEnvFile } from 'node:process'
try { loadEnvFile() } catch {}

import config from './config.js'
import WhatsAppAdapter from './adapters/whatsapp.js'
import iMessageAdapter from './adapters/imessage.js'
import TelegramAdapter from './adapters/telegram.js'
import SignalAdapter from './adapters/signal.js'
import SessionManager from './sessions/manager.js'
import AgentRunner from './agent/runner.js'
import CommandHandler from './commands/handler.js'
import { Composio } from '@composio/core'
import { ClaudeAgentSDKProvider } from '@composio/claude-agent-sdk'
import { BrowserServer } from './browser/index.js'
import { HITLApproval } from './auth/hitl.js'
import { getGatewayContext } from './tools/gateway.js'

/**
 * Clawd Gateway - Routes messages between messaging platforms and Claude agent
 */
class Gateway {
  constructor() {
    this.sessionManager = new SessionManager()
    this.hitl = config.handoff?.enabled ? new HITLApproval(config.handoff) : null
    if (this.hitl) console.log('[HITL] Handoff approval enabled')

    this.agentRunner = new AgentRunner(this.sessionManager, {
      workspace: config.agent?.workspace,
      allowedTools: config.agent?.allowedTools || [],
      maxTurns: config.agent?.maxTurns || 50,
      indexing: config.indexing,
      hitl: this.hitl,
    })
    this.commandHandler = new CommandHandler(this)
    this.adapters = new Map()
    this.composio = new Composio({ provider: new ClaudeAgentSDKProvider() })
    this.composioSession = null
    this.browserServer = null
    this.mcpServers = {}
    this.setupQueueMonitoring()
    this.setupAgentMonitoring()
    this.setupCronExecution()
  }

  async initMcpServers() {
    const userId = config.agentId || 'clawd-user'
    console.log('[Composio] Initializing session for:', userId)
    try {
      this.composioSession = await this.composio.create(userId)

      const sensitiveActions = config.agent?.sensitiveActions || []
      const hitl = this.hitl

      const tools = await this.composioSession.tools({
        beforeExecute: async ({ toolSlug, sessionId, params }) => {
          console.log(`[Composio:beforeExecute] toolSlug=${toolSlug} sessionId=${sessionId}`)
          console.log(`[Composio:beforeExecute] params:`, JSON.stringify(params, null, 2)?.substring(0, 500))
          // session.tools() returns meta tools — beforeExecute fires per meta tool slug.
          // Parse meta tool params to find sensitive individual tool slugs.
          if (toolSlug === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
            const blocked = (params?.tools || [])
              .map(t => t.tool_slug)
              .filter(slug => slug && sensitiveActions.includes(slug))
            if (blocked.length) {
              if (hitl) {
                console.log(`[HITL] Requesting approval for: ${blocked.join(', ')}`)
                const ctx = getGatewayContext()
                const result = await hitl.requestApproval(blocked, {
                  platform: ctx.currentPlatform,
                  sessionKey: ctx.currentSessionKey,
                  chatId: ctx.currentChatId,
                  toolParams: params,
                })
                if (result.approved) {
                  console.log(`[HITL] Approved: ${blocked.join(', ')}`)
                  return params
                }
                throw new Error(`User denied: ${blocked.join(', ')}`)
              }
              throw new Error(`Blocked sensitive actions: ${blocked.join(', ')}`)
            }
          }
          return params
        }
      })

      // Store raw tools array — MCP server is created per query() call to avoid
      // "Already connected to a transport" crash with concurrent sessions
      this.mcpServers.composioTools = tools
      console.log(`[Composio] Session ready with ${tools.length} tools`)
    } catch (err) {
      console.error('[Composio] Failed to initialize:', err.message)
    }

    if (config.browser?.enabled) {
      console.log('[Browser] Mode:', config.browser.mode || 'clawd')

      try {
        this.browserServer = new BrowserServer(config.browser)
        // Store ref — MCP server created per query() call
        this.mcpServers.browserServer = this.browserServer
        console.log('[Browser] Ready')
      } catch (err) {
        console.error('[Browser] Failed to initialize:', err.message)
        if (config.browser.mode === 'chrome') {
          console.error('[Browser] Make sure Chrome is running with --remote-debugging-port=' + (config.browser.chrome?.cdpPort || 9222))
        }
      }
    }

    // LinkedIn messaging via Unipile
    if (config.unipile?.enabled) {
      let accountName = null
      try {
        const res = await fetch(
          `${config.unipile.baseUrl}/api/v1/accounts/${config.unipile.accountId}`,
          { headers: { 'X-API-KEY': config.unipile.apiKey, 'Accept': 'application/json' } }
        )
        if (res.ok) {
          const data = await res.json()
          accountName = data.name || null
        }
      } catch (err) {
        console.warn('[LinkedIn] Failed to fetch account name:', err.message)
      }
      this.mcpServers.linkedin = {
        baseUrl: config.unipile.baseUrl,
        apiKey: config.unipile.apiKey,
        accountId: config.unipile.accountId,
        accountName,
      }
      console.log(`[LinkedIn] Unipile MCP server enabled${accountName ? ` (${accountName})` : ''}`)
    }

    // Agency CRM MCP (API key auth)
    if (process.env.AGENCY_API_KEY) {
      this.mcpServers.agency = {
        type: 'http',
        url: 'https://mcp.agency.inc/',
        headers: {
          Authorization: `Bearer ${process.env.AGENCY_API_KEY}`
        }
      }
      console.log('[Agency] MCP server configured')
    }
  }

  setupQueueMonitoring() {
    this.agentRunner.on('queued', ({ runId, sessionKey, position, queueLength }) => {
      if (position > 0) {
        console.log(`[Queue] 📥 Queued: position ${position + 1}, ${queueLength} pending`)
      }
    })

    this.agentRunner.on('processing', ({ runId, waitTimeMs, remainingInQueue }) => {
      if (waitTimeMs > 100) {
        console.log(`[Queue] ⚙️  Processing (waited ${Math.round(waitTimeMs)}ms, ${remainingInQueue} remaining)`)
      }
    })

    this.agentRunner.on('completed', ({ runId, processingTimeMs }) => {
      console.log(`[Queue] ✓ Completed in ${Math.round(processingTimeMs)}ms`)
    })

    this.agentRunner.on('failed', ({ runId, error }) => {
      console.log(`[Queue] ✗ Failed: ${error}`)
    })
  }

  setupAgentMonitoring() {
    this.agentRunner.on('agent:tool', ({ sessionKey, name }) => {
      console.log(`[Agent] 🔧 Using tool: ${name}`)
    })
  }

  async setupTriggerSubscription() {
    if (!this.composio || !config.triggers?.length) {
      console.log(`[Triggers] Skipped: composio=${!!this.composio}, triggers=${config.triggers?.length || 0}`)
      return
    }

    const scheduler = this.agentRunner.agent.cronScheduler
    const userId = config.agentId || 'clawd-user'

    // Helper: register a trigger with Composio and store the instance ID on the job
    const registerTrigger = async (job) => {
      const result = await this.composio.triggers.create(userId, job.slug, { triggerConfig: job.triggerConfig })
      // Store Composio's trigger instance ID for later disable/delete
      job.composioTriggerId = result.triggerId
      scheduler.saveJobs()
      console.log(`[Triggers] Synced with Composio: ${job.slug} (id: ${result.triggerId})`)
    }

    // Register active trigger jobs with Composio
    const activeTriggers = Array.from(scheduler.jobs.values()).filter(j => j.type === 'trigger')
    for (const job of activeTriggers) {
      try {
        await registerTrigger(job)
      } catch (err) {
        console.error(`[Triggers] Failed to register ${job.slug}:`, err.message)
      }
    }

    // Listen for runtime trigger creation/cancellation
    scheduler.on('trigger:created', async (job) => {
      try {
        await registerTrigger(job)
      } catch (err) {
        console.error(`[Triggers] Failed to register ${job.slug}:`, err.message)
      }
    })

    scheduler.on('trigger:cancelled', async (job) => {
      const composioId = job.composioTriggerId
      if (!composioId) {
        console.log(`[Triggers] No Composio ID stored for ${job.slug}, skipping disable`)
        return
      }
      try {
        await this.composio.triggers.disable(composioId)
        console.log(`[Triggers] Disabled on Composio: ${job.slug} (id: ${composioId})`)
      } catch (err) {
        if (err.message?.includes('410') || err.message?.includes('not found')) {
          console.log(`[Triggers] Already removed on Composio: ${job.slug}`)
        } else {
          console.error(`[Triggers] Failed to disable ${job.slug}:`, err.message)
        }
      }
    })

    // Subscribe to all trigger events via Pusher
    await this.composio.triggers.subscribe((data) => {
      const triggerSlug = data.triggerSlug
      const job = Array.from(scheduler.jobs.values()).find(j => j.type === 'trigger' && j.slug === triggerSlug)
      if (!job) {
        console.log(`[Triggers] Ignoring event for unregistered trigger: ${triggerSlug}`)
        return
      }
      console.log(`[Triggers] Event: ${triggerSlug}`)
      const enrichedMessage = `${job.message}\n\nTrigger: ${triggerSlug}\nPayload:\n${JSON.stringify(data.payload, null, 2)}`
      scheduler.executeJob(job, enrichedMessage)
    }, { userId })

    console.log(`[Triggers] Pusher subscription active (${activeTriggers.length} triggers registered)`)
  }

  setupCronExecution() {
    // Handle cron job execution - send scheduled messages or invoke agent
    this.agentRunner.agent.cronScheduler.on('execute', async ({ jobId, platform, chatId, sessionKey, message, invokeAgent, silent }) => {
      console.log(`[Cron] ⏰ Executing job ${jobId}${invokeAgent ? ' (invoking agent)' : ''}${silent ? ' (silent)' : ''}`)

      const adapter = platform ? this.adapters.get(platform) : null
      if (!adapter && !invokeAgent) {
        console.error(`[Cron] No adapter for platform: ${platform}`)
        return
      }

      try {
        if (invokeAgent) {
          // Run the agent with the message
          // Silent mode: agent uses gateway tools to send messages explicitly
          const isSilent = silent || !chatId
          // Fresh session per execution — never resume a user's chat session
          const cronSessionKey = `cron:${jobId}:${Date.now()}`
          console.log(`[Cron] Invoking agent with: ${message} (${isSilent ? 'silent' : 'interactive'}, session: ${cronSessionKey})`)
          const response = await this.agentRunner.agent.runAndCollect({
            message,
            sessionKey: cronSessionKey,
            platform,
            chatId,
            mcpServers: this.mcpServers,
            outputMode: isSilent ? 'silent' : 'interactive'
          })
          // Clean up ephemeral cron session
          this.agentRunner.agent.sessions.delete(cronSessionKey)

          if (response && !isSilent) {
            await adapter.sendMessage(chatId, response)
            console.log(`[Cron] Agent response sent for job ${jobId}`)
          }
        } else if (adapter) {
          // Just send the message directly
          await adapter.sendMessage(chatId, message)
          console.log(`[Cron] Message sent for job ${jobId}`)
        } else {
          console.error(`[Cron] Cannot send message — no adapter for platform: ${platform}`)
        }
      } catch (err) {
        console.error(`[Cron] Failed to execute job:`, err.message)
      }
    })
  }

  async start() {
    console.log('='.repeat(50))
    console.log('Clawd Gateway Starting')
    console.log('='.repeat(50))
    console.log(`Agent ID: ${config.agentId}`)
    console.log(`Workspace: ${config.agent?.workspace || '~/clawd'}`)
    console.log('')

    await this.initMcpServers()
    this.agentRunner.setMcpServers(this.mcpServers)

    this.agentRunner.agent.gateway = this

    // Initialize workspace indexing
    if (config.indexing?.enabled) {
      const indexer = this.agentRunner.agent.indexer
      const installed = await indexer.checkInstalled()

      if (installed) {
        const leannConfig = indexer.getLeannMcpServerConfig()
        if (leannConfig) {
          this.mcpServers.knowledge = leannConfig
          this.agentRunner.setMcpServers(this.mcpServers)
          console.log('[Indexing] LEANN MCP server registered')
        }

        // Build + watch all sources (fire and forget)
        indexer.startWatchers().catch(err => {
          console.error('[Indexing] Failed to start watchers:', err.message)
        })
      }
    }

    // Initialize WhatsApp adapter
    if (config.whatsapp.enabled) {
      console.log('[Gateway] Initializing WhatsApp adapter...')
      const whatsapp = new WhatsAppAdapter(config.whatsapp)
      this.setupAdapter(whatsapp, 'whatsapp', config.whatsapp)
      this.adapters.set('whatsapp', whatsapp)

      try {
        await whatsapp.start()
      } catch (err) {
        console.error('[Gateway] WhatsApp adapter failed to start:', err.message)
      }
    }

    // Initialize iMessage adapter
    if (config.imessage.enabled) {
      console.log('[Gateway] Initializing iMessage adapter...')
      const imessage = new iMessageAdapter(config.imessage)
      this.setupAdapter(imessage, 'imessage', config.imessage)
      this.adapters.set('imessage', imessage)

      try {
        await imessage.start()
      } catch (err) {
        console.error('[Gateway] iMessage adapter failed to start:', err.message)
      }
    }


    if (config.telegram?.enabled) {
      console.log('[Gateway] Initializing Telegram adapter...')
      const telegram = new TelegramAdapter(config.telegram)
      this.setupAdapter(telegram, 'telegram', config.telegram)
      this.adapters.set('telegram', telegram)

      try {
        await telegram.start()
      } catch (err) {
        console.error('[Gateway] Telegram adapter failed to start:', err.message)
      }
    }

    // Initialize Signal adapter
    if (config.signal?.enabled) {
      console.log('[Gateway] Initializing Signal adapter...')
      const signal = new SignalAdapter(config.signal)
      this.setupAdapter(signal, 'signal', config.signal)
      this.adapters.set('signal', signal)

      try {
        await signal.start()
      } catch (err) {
        console.error('[Gateway] Signal adapter failed to start:', err.message)
      }
    }

    // Register heartbeat cron job (silent mode — agent uses gateway tools to send)
    if (config.heartbeat?.enabled) {
      const scheduler = this.agentRunner.agent.cronScheduler
      scheduler.scheduleCron({
        id: 'heartbeat',
        platform: null,
        chatId: null,
        sessionKey: 'cron:heartbeat',
        message: config.heartbeat.prompt,
        cron: config.heartbeat.cron,
        description: 'Heartbeat — silent agent check-in',
        invokeAgent: true,
        silent: true
      })
      console.log(`[Heartbeat] Registered: ${config.heartbeat.cron}`)
    }

    // Setup Composio trigger subscription
    await this.setupTriggerSubscription()

    // Handle shutdown
    process.on('SIGINT', () => this.stop())
    process.on('SIGTERM', () => this.stop())

    console.log('')
    console.log('[Gateway] Ready and listening for messages')
    console.log('[Gateway] Using Claude Agent SDK with memory + cron + Composio + Browser')
    console.log('[Gateway] Commands: /help, /new, /status, /stop')
  }

  setupAdapter(adapter, platform, platformConfig) {
    adapter.onMessage(async (message) => {
      const sessionKey = adapter.generateSessionKey(config.agentId, platform, message)

      console.log('')
      console.log(`[${platform.toUpperCase()}] Incoming message:`)
      console.log(`  Session: ${sessionKey}`)
      console.log(`  From: ${message.sender}`)
      console.log(`  Group: ${message.isGroup}`)
      console.log(`  Text: ${message.text.substring(0, 100)}${message.text.length > 100 ? '...' : ''}`)
      if (message.image) {
        console.log(`  Image: ${Math.round(message.image.data.length / 1024)}KB`)
      }

      try {
        // Check for slash commands first
        const commandResult = await this.commandHandler.execute(
          message.text,
          sessionKey,
          adapter,
          message.chatId
        )

        if (commandResult.handled) {
          console.log(`[${platform.toUpperCase()}] Command handled: ${message.text.split(' ')[0]}`)
          await adapter.sendMessage(message.chatId, commandResult.response)
          return
        }

        // Check queue status and show typing indicator
        const queueStatus = this.agentRunner.getQueueStatus(sessionKey)

        if (adapter.sendTyping) {
          await adapter.sendTyping(message.chatId)
        }

        if (queueStatus.pending > 0 && adapter.react && message.raw?.key?.id) {
          await adapter.react(message.chatId, message.raw.key.id, '⏳')
        }

        // Enqueue agent run with optional image
        console.log(`[${platform.toUpperCase()}] Processing...`)
        const response = await this.agentRunner.enqueueRun(
          sessionKey,
          message.text,
          adapter,
          message.chatId,
          message.image,  // Pass image if present
          { sender: message.sender, senderName: message.senderName, isGroup: message.isGroup, groupName: message.groupName, platform }
        )

        if (adapter.stopTyping) {
          await adapter.stopTyping(message.chatId)
        }

        console.log(`[${platform.toUpperCase()}] Done`)
      } catch (error) {
        console.error(`[${platform.toUpperCase()}] Error:`, error.message)

        if (adapter.stopTyping) {
          await adapter.stopTyping(message.chatId)
        }

        try {
          await adapter.sendMessage(
            message.chatId,
            "Sorry, I encountered an error. Please try again."
          )
        } catch (sendErr) {
          console.error(`[${platform.toUpperCase()}] Failed to send error message:`, sendErr.message)
        }
      }
    })
  }

  async stop() {
    console.log('\n[Gateway] Shutting down...')

    // Stop cron scheduler and indexing watchers
    this.agentRunner.agent.stopCron()
    this.agentRunner.agent.indexer.stopWatchers()

    // Stop browser server
    if (this.browserServer) {
      try {
        await this.browserServer.stop()
        console.log('[Gateway] Browser server stopped')
      } catch (err) {
        console.error('[Gateway] Error stopping browser:', err.message)
      }
    }

    for (const adapter of this.adapters.values()) {
      try {
        await adapter.stop()
      } catch (err) {
        console.error('[Gateway] Error stopping adapter:', err.message)
      }
    }

    console.log('[Gateway] Goodbye!')
    process.exit(0)
  }
}

// Start the gateway
const gateway = new Gateway()
gateway.start().catch((err) => {
  console.error('[Gateway] Fatal error:', err)
  process.exit(1)
})
