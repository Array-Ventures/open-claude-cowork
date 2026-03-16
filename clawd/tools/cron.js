import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { EventEmitter } from 'events'
import { Cron } from 'croner'
import config from '../config.js'

const JOBS_FILE = path.join(os.homedir(), '.clawd', 'cron-jobs.json')

/**
 * Cron scheduler state management
 */
class CronScheduler extends EventEmitter {
  constructor() {
    super()
    this.jobs = new Map()
    this.timers = new Map()
    this.ensureDir()
    this.loadJobs()
  }

  ensureDir() {
    const dir = path.dirname(JOBS_FILE)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  loadJobs() {
    try {
      if (fs.existsSync(JOBS_FILE)) {
        const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'))
        for (const job of data) {
          this.jobs.set(job.id, job)
          this.scheduleJob(job)
        }
        console.log(`[Cron] Loaded ${this.jobs.size} jobs`)
      }
    } catch (err) {
      console.error('[Cron] Failed to load jobs:', err.message)
    }
  }

  saveJobs() {
    try {
      const data = Array.from(this.jobs.values())
      fs.writeFileSync(JOBS_FILE, JSON.stringify(data, null, 2))
    } catch (err) {
      console.error('[Cron] Failed to save jobs:', err.message)
    }
  }

  generateId() {
    return `cron_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
  }

  scheduleDelayed(params) {
    const { platform, chatId, message, delaySeconds, description, sessionKey, invokeAgent, silent } = params
    const id = this.generateId()
    const executeAt = Date.now() + (delaySeconds * 1000)

    const job = {
      id, type: 'delayed', platform, chatId, sessionKey, message, executeAt,
      description: description || `Send in ${delaySeconds}s`,
      invokeAgent: invokeAgent || false,
      silent: silent || false,
      createdAt: Date.now(), lastRun: null, runCount: 0
    }

    this.jobs.set(id, job)
    this.saveJobs()
    this.scheduleJob(job)

    return { success: true, jobId: id, executeAt: new Date(executeAt).toISOString() }
  }

  scheduleRecurring(params) {
    const { platform, chatId, message, intervalSeconds, description, sessionKey, invokeAgent, silent } = params
    const id = this.generateId()

    const job = {
      id, type: 'recurring', platform, chatId, sessionKey, message,
      intervalMs: intervalSeconds * 1000,
      description: description || `Every ${intervalSeconds}s`,
      invokeAgent: invokeAgent || false,
      silent: silent || false,
      createdAt: Date.now(), lastRun: null, runCount: 0
    }

    this.jobs.set(id, job)
    this.saveJobs()
    this.scheduleJob(job)

    return { success: true, jobId: id, intervalSeconds }
  }

  scheduleCron(params) {
    const { platform, chatId, message, cron, description, sessionKey, invokeAgent, silent, id: explicitId } = params
    const id = explicitId || this.generateId()

    const job = {
      id, type: 'cron', platform, chatId, sessionKey, message, cron,
      description: description || `Cron: ${cron}`,
      invokeAgent: invokeAgent || false,
      silent: silent || false,
      createdAt: Date.now(), lastRun: null, runCount: 0
    }

    this.jobs.set(id, job)
    this.saveJobs()
    this.scheduleJob(job)

    return { success: true, jobId: id, cron, nextRun: this.getNextCronRun(cron)?.toISOString() }
  }

  scheduleTrigger(params) {
    const { slug, triggerConfig, platform, chatId, message, description, sessionKey, invokeAgent, silent } = params
    const id = `trigger_${slug}`  // deterministic — re-enabling replaces old one

    const job = {
      id, type: 'trigger', slug, triggerConfig, platform, chatId, sessionKey, message,
      description: description || `Trigger: ${slug}`,
      invokeAgent: invokeAgent ?? true,
      silent: silent ?? true,
      createdAt: Date.now(), lastRun: null, runCount: 0
    }

    this.jobs.set(id, job)
    this.saveJobs()
    // No local timer — execution comes from Pusher via gateway
    this.emit('trigger:created', job)
    return { success: true, jobId: id, slug }
  }

  list() {
    return Array.from(this.jobs.values()).map(job => ({
      id: job.id, type: job.type, platform: job.platform,
      chatId: job.chatId || null,
      description: job.description,
      invokeAgent: job.invokeAgent || false,
      silent: job.silent || false,
      createdAt: new Date(job.createdAt).toISOString(),
      lastRun: job.lastRun ? new Date(job.lastRun).toISOString() : null,
      runCount: job.runCount || 0,
      ...(job.type === 'delayed' && { executeAt: new Date(job.executeAt).toISOString() }),
      ...(job.type === 'recurring' && { intervalSeconds: job.intervalMs / 1000 }),
      ...(job.type === 'cron' && { cron: job.cron }),
      ...(job.type === 'trigger' && { slug: job.slug })
    }))
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId)
    if (!job) return { success: false, error: 'Job not found' }

    if (this.timers.has(jobId)) {
      const timer = this.timers.get(jobId)
      if (timer?.stop) timer.stop()
      else { clearTimeout(timer); clearInterval(timer) }
      this.timers.delete(jobId)
    }

    if (job.type === 'trigger') this.emit('trigger:cancelled', job)
    this.jobs.delete(jobId)
    this.saveJobs()
    return { success: true, message: `Cancelled job ${jobId}` }
  }

  scheduleJob(job) {
    if (this.timers.has(job.id)) {
      const existing = this.timers.get(job.id)
      if (existing?.stop) existing.stop()
      else { clearTimeout(existing); clearInterval(existing) }
    }

    if (job.type === 'delayed') {
      const delay = job.executeAt - Date.now()
      if (delay > 0) {
        this.timers.set(job.id, setTimeout(() => this.executeJob(job), delay))
      } else {
        this.executeJob(job)
      }
    } else if (job.type === 'recurring') {
      this.timers.set(job.id, setInterval(() => this.executeJob(job), job.intervalMs))
    } else if (job.type === 'cron') {
      this.scheduleCronRun(job)
    } else if (job.type === 'trigger') {
      // Triggers are Pusher-driven, no local timer needed
    }
  }

  scheduleCronRun(job) {
    try {
      const cronJob = new Cron(job.cron, () => this.executeJob(job))
      this.timers.set(job.id, cronJob)
    } catch (err) {
      console.error(`[Cron] Invalid cron expression for job ${job.id}: ${err.message}`)
    }
  }

  getNextCronRun(cronExpr) {
    try {
      return new Cron(cronExpr, { paused: true }).nextRun()
    } catch {
      return null
    }
  }

  executeJob(job, messageOverride) {
    console.log(`[Cron] Executing job ${job.id}: ${job.description}`)
    job.lastRun = Date.now()
    job.runCount = (job.runCount || 0) + 1
    this.saveJobs()

    this.emit('execute', {
      jobId: job.id,
      platform: job.platform,
      chatId: job.chatId,
      sessionKey: job.sessionKey,
      message: messageOverride || job.message,
      invokeAgent: job.invokeAgent || false,
      silent: job.silent || false
    })

    if (job.type === 'delayed') this.cancel(job.id)
  }

  stop() {
    for (const timer of this.timers.values()) {
      if (timer?.stop) timer.stop()
      else { clearTimeout(timer); clearInterval(timer) }
    }
    this.timers.clear()
  }
}

// Global scheduler instance
const scheduler = new CronScheduler()
console.log(`[Cron] Module loaded, scheduler ready with ${scheduler.jobs.size} jobs`)

// Context holder for current session info
let currentContext = { platform: 'unknown', chatId: null, sessionKey: null }

/**
 * Set the current context for tool calls
 */
export function setContext(ctx) {
  currentContext = { ...currentContext, ...ctx }
}

/**
 * Get the scheduler instance (for event subscription)
 */
export function getScheduler() {
  return scheduler
}

/**
 * Create the Cron MCP Server with tools
 */
export function createCronMcpServer() {
  return createSdkMcpServer({
    name: 'cron',
    version: '1.0.0',
    tools: [
      tool(
        'schedule_delayed',
        'Schedule a one-time task after a delay. Use for reminders like "remind me in 30 minutes". Set invoke_agent=true to have the agent process the message and respond.',
        {
          message: z.string().describe('Message to send, or task for the agent if invoke_agent is true'),
          delay_seconds: z.number().positive().describe('Delay in seconds before sending'),
          description: z.string().optional().describe('Human-readable description of the reminder'),
          invoke_agent: z.boolean().optional().describe('If true, the agent will process this message and respond. If false (default), just sends the message.'),
          silent: z.boolean().optional().describe('If true, job runs silently — agent decides whether to message anyone. Requires invoke_agent=true.'),
          platform: z.string().optional().describe('Target platform for notifications (e.g., "whatsapp", "imessage"). Defaults to current chat.'),
          chat_id: z.string().optional().describe('Target chat ID for notifications. Defaults to current chat.')
        },
        async (args) => {
          if (args.silent && !args.invoke_agent) {
            return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'silent=true requires invoke_agent=true. Silent mode runs the agent in the background without auto-replying — retry with invoke_agent=true, or remove silent to send the message directly to the chat.' }) }] }
          }
          const result = scheduler.scheduleDelayed({
            platform: args.platform || currentContext.platform,
            chatId: args.chat_id || currentContext.chatId,
            sessionKey: currentContext.sessionKey,
            message: args.message,
            delaySeconds: args.delay_seconds,
            description: args.description,
            invokeAgent: args.invoke_agent,
            silent: args.silent
          })

          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }]
          }
        }
      ),

      tool(
        'schedule_recurring',
        'Schedule a recurring task at regular intervals. Set invoke_agent=true to have the agent process and respond each time.',
        {
          message: z.string().describe('Message to send, or task for the agent if invoke_agent is true'),
          interval_seconds: z.number().positive().describe('Interval in seconds between executions'),
          description: z.string().optional().describe('Human-readable description'),
          invoke_agent: z.boolean().optional().describe('If true, the agent will process this message and respond each time.'),
          silent: z.boolean().optional().describe('If true, job runs silently — agent decides whether to message anyone. Requires invoke_agent=true.'),
          platform: z.string().optional().describe('Target platform for notifications (e.g., "whatsapp", "imessage"). Defaults to current chat.'),
          chat_id: z.string().optional().describe('Target chat ID for notifications. Defaults to current chat.')
        },
        async (args) => {
          if (args.silent && !args.invoke_agent) {
            return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'silent=true requires invoke_agent=true. Silent mode runs the agent in the background without auto-replying — retry with invoke_agent=true, or remove silent to send the message directly to the chat.' }) }] }
          }
          const result = scheduler.scheduleRecurring({
            platform: args.platform || currentContext.platform,
            chatId: args.chat_id || currentContext.chatId,
            sessionKey: currentContext.sessionKey,
            message: args.message,
            intervalSeconds: args.interval_seconds,
            description: args.description,
            invokeAgent: args.invoke_agent,
            silent: args.silent
          })

          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }]
          }
        }
      ),

      tool(
        'schedule_cron',
        'Schedule a task using cron expression. Format: "minute hour day month weekday". Examples: "0 9 * * *" for 9am daily. Set invoke_agent=true to have the agent process and respond.',
        {
          message: z.string().describe('Message to send, or task for the agent if invoke_agent is true'),
          cron: z.string().describe('Cron expression: "minute hour day month weekday"'),
          description: z.string().optional().describe('Human-readable description'),
          invoke_agent: z.boolean().optional().describe('If true, the agent will process this message and respond each time.'),
          silent: z.boolean().optional().describe('If true, job runs silently — agent decides whether to message anyone. Requires invoke_agent=true.'),
          platform: z.string().optional().describe('Target platform for notifications (e.g., "whatsapp", "imessage"). Defaults to current chat.'),
          chat_id: z.string().optional().describe('Target chat ID for notifications. Defaults to current chat.')
        },
        async (args) => {
          if (args.silent && !args.invoke_agent) {
            return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'silent=true requires invoke_agent=true. Silent mode runs the agent in the background without auto-replying — retry with invoke_agent=true, or remove silent to send the message directly to the chat.' }) }] }
          }
          const result = scheduler.scheduleCron({
            platform: args.platform || currentContext.platform,
            chatId: args.chat_id || currentContext.chatId,
            sessionKey: currentContext.sessionKey,
            message: args.message,
            cron: args.cron,
            description: args.description,
            invokeAgent: args.invoke_agent,
            silent: args.silent
          })

          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }]
          }
        }
      ),

      tool(
        'list_scheduled',
        'List all scheduled jobs (reminders, recurring, cron, triggers).',
        {},
        async () => {
          const jobs = scheduler.list()
          return {
            content: [{
              type: 'text',
              text: jobs.length > 0
                ? `Scheduled jobs:\n${JSON.stringify(jobs, null, 2)}`
                : 'No scheduled jobs'
            }]
          }
        }
      ),

      tool(
        'schedule_trigger',
        'Enable a Composio trigger for event-driven automation (e.g., new email, GitHub commit). Only triggers from config are allowed. Defaults to silent + invoke_agent.',
        {
          slug: z.string().describe('Trigger slug from config (e.g., GMAIL_NEW_MESSAGE). Use list_triggers to see available.'),
          message: z.string().describe('Task for the agent when trigger fires. Trigger payload will be appended.'),
          trigger_config: z.record(z.string(), z.unknown()).optional().describe('Override default trigger config fields'),
          description: z.string().optional(),
          invoke_agent: z.boolean().optional().describe('Defaults to true for triggers.'),
          silent: z.boolean().optional().describe('Defaults to true for triggers. Agent decides whether to notify.'),
          platform: z.string().optional().describe('Target platform. Defaults to current.'),
          chat_id: z.string().optional().describe('Target chat ID. Defaults to current.'),
        },
        async (args) => {
          const allowedTriggers = config.triggers || []
          const triggerDef = allowedTriggers.find(t => t.slug === args.slug)
          if (!triggerDef) {
            return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Trigger '${args.slug}' not in config. Available: ${allowedTriggers.map(t => t.slug).join(', ') || 'none configured'}. Ask the user to add it to config.js triggers array.` }) }] }
          }
          const invokeAgent = args.invoke_agent ?? true
          const silent = args.silent ?? true
          if (silent && !invokeAgent) {
            return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'silent=true requires invoke_agent=true. Silent mode runs the agent in the background without auto-replying — retry with invoke_agent=true, or remove silent to send the message directly to the chat.' }) }] }
          }
          const result = scheduler.scheduleTrigger({
            slug: args.slug,
            triggerConfig: { ...triggerDef.defaults, ...args.trigger_config },
            platform: args.platform || currentContext.platform,
            chatId: args.chat_id || currentContext.chatId,
            sessionKey: currentContext.sessionKey,
            message: args.message,
            description: args.description,
            invokeAgent,
            silent,
          })
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        }
      ),

      tool(
        'list_triggers',
        'List available Composio triggers from config and their active/inactive status.',
        {},
        async () => {
          const available = (config.triggers || []).map(t => t.slug)
          const activeJobs = scheduler.list().filter(j => j.type === 'trigger')
          const activeSlugs = new Set(activeJobs.map(j => j.slug))
          const result = available.map(slug => ({
            slug,
            active: activeSlugs.has(slug),
            ...(activeSlugs.has(slug) && { jobId: `trigger_${slug}` })
          }))
          return { content: [{ type: 'text', text: JSON.stringify({ triggers: result, activeJobs }, null, 2) }] }
        }
      ),

      tool(
        'cancel_scheduled',
        'Cancel a scheduled job by its ID.',
        {
          job_id: z.string().describe('The job ID to cancel')
        },
        async (args) => {
          const result = scheduler.cancel(args.job_id)
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }]
          }
        }
      )
    ]
  })
}

export default { createCronMcpServer, setContext, getScheduler }
