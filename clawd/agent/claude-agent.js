import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "events";
import path from "path";
import os from "os";

import { getClaudeProjectDir } from "../utils.js";
import MemoryManager from "../memory/manager.js";
import {
  createCronMcpServer,
  setContext as setCronContext,
  getScheduler,
} from "../tools/cron.js";
import { createGatewayMcpServer, setGatewayContext, getGatewayContext } from "../tools/gateway.js";
import { createBrowserMcpServer } from "../browser/index.js";
import { createLinkedinMcpServer } from "../linkedin/server.js";
// Obsidian removed — memory is now nanograph at ~/clawd/graph/
import { WorkspaceIndexer } from "../indexing/index.js";
import SessionStore from "../sessions/store.js";

/**
 * Resolve workspace path (handles ~/ prefix)
 */
function resolveWorkspace(workspace) {
  if (!workspace) return path.join(os.homedir(), 'clawd');
  if (workspace.startsWith('~/')) {
    return path.join(os.homedir(), workspace.slice(2));
  }
  return path.resolve(workspace);
}

/**
 * Build the append prompt with Clawd-specific instructions.
 * This is appended to Claude Code's default system prompt (which includes auto memory,
 * built-in tool instructions, etc.)
 */
function buildAppendPrompt(sessionInfo, cronInfo, workspace, outputMode = 'interactive') {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-US", { hour12: true });

  const outputModeText = outputMode === 'silent'
    ? `## Output Mode: SILENT
You are running in silent mode — no user is waiting for a response. Your text output is NOT sent to anyone.
To send a message, you MUST use mcp__gateway__send_message with the target platform and chat_id.`
    : `## Output Mode: INTERACTIVE
Your text responses are automatically sent to the current chat. Do NOT use mcp__gateway__send_message to reply to the current conversation — only use it to proactively message a DIFFERENT chat.`;

  return `# Clawd — Personal AI Assistant

You are Clawd, a personal AI assistant communicating via messaging platforms (WhatsApp, iMessage).

## Current Context
- Date: ${dateStr}
- Time: ${timeStr}
- Session: ${sessionInfo.sessionKey}
- Platform: ${sessionInfo.platform}
- Workspace: ${workspace}/
- Memory: ${getClaudeProjectDir(workspace)}/memory/

${outputModeText}

## Scheduling / Reminders
- "remind me in X": use schedule_delayed with the reminder text as the message
- "every day at 9am": use schedule_cron with "0 9 * * *"
- invoke_agent=false (default): sends the message text directly to the chat — use for simple reminders like "Take your medicine!"
- invoke_agent=true: wakes you (the agent) to process the message as a task and respond
- silent=true + invoke_agent=true: runs you in the background — you decide whether to message anyone using send_message. Good for background checks and monitoring tasks.
- silent=true requires invoke_agent=true (will error otherwise — silent only makes sense when the agent runs)
- All schedule tools accept optional platform and chat_id to route notifications to a specific chat (defaults to current)

## Triggers (Event-Driven)
- Use schedule_trigger to enable real-time event triggers (new email, GitHub commit, etc.)
- Use list_triggers to see available triggers and their status
- Triggers default to silent=true + invoke_agent=true — you wake up, assess the event, decide whether to notify the user
- Cancel triggers with cancel_scheduled using the job ID (e.g., trigger_GMAIL_NEW_MESSAGE)

### Current Scheduled Jobs
${cronInfo || "No jobs scheduled"}

## Image Handling
When the user sends an image, you can describe it, answer questions, extract text (OCR), or analyze charts/diagrams/screenshots.

## Tool Selection - IMPORTANT

**Default: Use Composio tools for app integrations.**
For tasks involving Gmail, Slack, GitHub, Google Sheets, Calendar, Notion, Trello, Jira, and other apps, ALWAYS use Composio MCP tools. These are faster, more reliable, and work via API.

**Browser tools are ONLY for when the user explicitly mentions:**
- "browser", "browse", "open website", "go to site", "navigate to"
- Specific URLs they want to visit
- Tasks that require visual interaction with a website that Composio cannot handle

Examples:
- "Send an email to John" → Use Composio (Gmail tools)
- "Open google.com in the browser" → Use Browser tools

## Gateway Tools
- mcp__gateway__send_message: Send a message to any chat on any platform (use ONLY for messaging a different chat, or in silent mode)
- mcp__gateway__list_platforms: List connected platforms
- mcp__gateway__get_queue_status: Check message queue status
- mcp__gateway__get_current_context: Get current platform/chat/session info
- mcp__gateway__list_sessions: List all active sessions
- mcp__gateway__broadcast_message: Send to multiple chats (use carefully)

## Knowledge Tools
Use mcp__knowledge__* tools to search across workspace files, transcripts, and memories.
When user asks to find, recall, or search for something from past conversations or files, use Knowledge tools.

## LinkedIn Tools
Use mcp__linkedin__* tools for LinkedIn messaging and connections.
- list_linkedin_chats: List recent LinkedIn DM conversations (filter by unread)
- read_linkedin_messages: Read messages from a specific chat
- send_linkedin_message: Reply in an existing chat (requires approval)
- start_linkedin_chat: Start a new conversation (requires approval)
- get_linkedin_attendees: Get attendee profiles — name, role, connection degree, LinkedIn URL
- list_received_invitations: List pending connection requests received
- list_sent_invitations: List pending sent connection requests
- send_connection_request: Send a connection request with optional note (requires approval)
- respond_to_invitation: Accept or decline a connection request (requires approval)
When user asks about LinkedIn messages, DMs, connections, or invitations, use these tools.

## Agency Tools
Use mcp__agency__* tools for CRM data — companies, people, meetings, emails, opportunities.
When user asks about contacts, deals, companies, or meeting notes, use Agency tools.

## Memory System
Your memory is a nanograph property graph at \`~/clawd/graph/\`. This is what makes you *you* across conversations. Every person you meet, every deal you track, every decision the fund makes lives here.

MEMORY.md has the quick-reference aliases. The **joyce-graph** skill has full schema, queries, and mutation workflows — load it before any graph operation.

**Be proactive:** Don't wait to be asked to remember things. When someone mentions a person, search the graph. When a deal progresses, advance it. When metrics come in, add them. Your memory is what makes you useful.

**Reading the graph:**
\`\`\`
cd ~/clawd/graph
nanograph run pipeline          # pending deals
nanograph run ours              # deals where Array owes next move
nanograph run why deal-<slug>   # trace a deal's provenance
nanograph run metrics           # latest portco metrics
nanograph run search "query"    # semantic search
\`\`\`

**Writing to the graph:**
Load /joyce-graph skill and read its mutations.md reference. Key workflows:
- New cold inbound: insert_company + insert_deal + link_deal_for (no spine needed)
- New warm intro: full spine — Artifact + Signal + Decision + edges
- Advance deal: advance_deal + Signal + Decision
- Pass: close_deal + set_pass_date + Decision
- Metrics: unset old isLatest, insert new, set new isLatest, link_metrics_for

**Key rules:**
- Timestamps auto-set via now() — never pass createdAt/updatedAt
- Shruti forwarding to deals@ is standard funnel entry, not a signal of interest
- passDate != stageDate — stageDate is when deal entered stage, passDate is when pass email was sent
- Slug conventions: per-{first}-{last}, com-{name}, deal-{name}, port-{name}-{yyyy-mm}, met-{name}-{period}
`;
}

/**
 * Claude Agent using the Claude Agent SDK
 * With memory system and cron MCP server
 */
export default class ClaudeAgent extends EventEmitter {
  constructor(config = {}) {
    super();
    this.workspace = resolveWorkspace(config.workspace);

    // Seed auto memory + CLAUDE.md if they don't exist yet
    const srcRoot = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
    this.srcRoot = srcRoot;
    this.memoryManager = new MemoryManager(this.workspace, srcRoot);
    this.memoryManager.seed();
    this.memoryManager.seedSkills();        // async: git clone latest skills
    // Obsidian headless sync removed — memory is nanograph

    this.cronScheduler = getScheduler();
    this.indexer = new WorkspaceIndexer(this.workspace, config.indexing || {});
    // Add auto memory as an indexable source
    this.indexer.sources.push({
      name: 'memory',
      type: 'directory',
      path: getClaudeProjectDir(this.workspace) + '/memory',
    });
    this.leannMcpServer = this.indexer.getLeannMcpServerConfig();
    this.gateway = null; // Set by gateway after construction
    this.sessions = new SessionStore();
    this.abortControllers = new Map();

    // allowedTools = auto-approved tools (skip ALL permission checks).
    // Only MCP tools go here. Built-in tools (Read/Write/Edit/Bash/etc.)
    // go through permission rules (deny/allow) + canUseTool callback.
    this.allowedTools = config.allowedTools || [];

    this.hitl = config.hitl || null;
    this.model = config.model || undefined;
    this.maxTurns = config.maxTurns || 50;
    this.permissionMode = config.permissionMode || "default";

    // Forward cron events
    this.cronScheduler.on("execute", (data) => this.emit("cron:execute", data));
  }

  getSession(sessionKey) {
    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, {
        sdkSessionId: null,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        messageCount: 0,
      });
    }
    return this.sessions.get(sessionKey);
  }

  abort(sessionKey) {
    const controller = this.abortControllers.get(sessionKey);
    if (controller) {
      console.log("[ClaudeAgent] Aborting query for:", sessionKey);
      controller.abort();
      this.abortControllers.delete(sessionKey);
      return true;
    }
    return false;
  }

  getCronSummary() {
    const jobs = this.cronScheduler.list();
    if (jobs.length === 0) return null;
    return jobs
      .map((j) => `- ${j.id}: ${j.description} (${j.type})`)
      .join("\n");
  }

  /**
   * Build prompt - supports images for vision
   */
  buildPrompt(message, image) {
    if (!image) return message;

    return [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: image.mediaType,
          data: image.data,
        },
      },
      {
        type: "text",
        text: message,
      },
    ];
  }

  /**
   * Generate streaming messages for the SDK
   */
  async *generateMessages(message, image) {
    yield {
      type: "user",
      message: {
        role: "user",
        content: this.buildPrompt(message, image),
      },
    };
  }

  /**
   * Run the agent for a message
   */
  async *run(params) {
    const {
      message,
      sessionKey,
      platform = "unknown",
      chatId = null,
      image = null,
      mcpServers = {},
      outputMode = "interactive",
    } = params;

    const session = this.getSession(sessionKey);
    session.lastActivity = Date.now();
    session.messageCount++;
    this.sessions.save();

    // Set cron context for scheduled messages
    setCronContext({ platform, chatId, sessionKey });

    // Set gateway context
    setGatewayContext({
      gateway: this.gateway,
      currentPlatform: platform,
      currentChatId: chatId,
      currentSessionKey: sessionKey,
    });

    // Build append prompt (Clawd-specific instructions appended to Claude Code's default)
    const cronInfo = this.getCronSummary();
    const appendPrompt = buildAppendPrompt(
      { sessionKey, platform },
      cronInfo,
      this.workspace,
      outputMode,
    );

    // Auto-approve all MCP tools by server name (wildcard).
    // Built-in tools (Read/Write/Edit/Bash) go through permission rules + canUseTool.
    const autoApprovedTools = [
      ...this.allowedTools,
      "mcp__cron__*",
      "mcp__gateway__*",
      "mcp__knowledge__*",
      "mcp__browser__*",
      "mcp__composio__COMPOSIO_SEARCH_TOOLS",
      "mcp__composio__COMPOSIO_MANAGE_CONNECTIONS",
      "mcp__composio__COMPOSIO_GET_TOOL_SCHEMAS",
      "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL",
      "mcp__composio__COMPOSIO_REMOTE_BASH_TOOL",
      // COMPOSIO_REMOTE_WORKBENCH excluded — has proxy_execute that bypasses tool-level gating
      "mcp__agency__*",
      // LinkedIn read-only tools (send/write tools gated by HITL in canUseTool)
      "mcp__linkedin__list_linkedin_chats",
      "mcp__linkedin__read_linkedin_messages",
      "mcp__linkedin__get_linkedin_attendees",
      "mcp__linkedin__list_received_invitations",
      "mcp__linkedin__list_sent_invitations",
    ];

    // Paths to deny — credentials + user data directories.
    // Mirrored in both permission rules (Read/Edit/Write tools) and sandbox (Bash).
    // Permission rules: whitelist workspace via allow rules, canUseTool denies the rest.
    // Sandbox: no allowRead exists, so we blacklist known-sensitive paths.
    //   (system configs like ~/.gitconfig, ~/.npmrc stay readable so Bash tools work)
    // Paths denied in BOTH permission rules AND sandbox denyRead
    const denyPaths = [
      '~/.ssh', '~/.aws', '~/.gnupg', '~/.clawd',
      '~/Downloads', '~/Documents', '~/Desktop',
      '~/Movies', '~/Music', '~/Pictures', '~/Public', '~/Library',
    ];
    // ~/.claude is NOT denied anywhere — permission deny rules feed into sandbox
    // Seatbelt profile, so denying Read(~/.claude/**) would block shell snapshot
    // sourcing. Protection: no allow rule for ~/.claude → canUseTool denies file tools.
    const denyPatterns = ['.env', '.env.*'];

    // Build query options
    const queryOptions = {
      cwd: this.workspace,
      additionalDirectories: [],
      tools: { type: 'preset', preset: 'claude_code' },  // all built-in tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Task, etc.)
      allowedTools: autoApprovedTools,  // auto-approved (MCP only, skip permission checks)
      ...(this.model ? { model: this.model } : {}),
      disallowedTools: ['mcp__claude_ai_*'],  // exclude first-party Anthropic integrations (Gmail, etc.)
      maxTurns: this.maxTurns,
      permissionMode: this.permissionMode,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: appendPrompt,
      },
      includePartialMessages: true,
      // Safety net: canUseTool fires for anything not resolved by permission rules.
      // Built-in tools are already gated by permission rules + sandbox.
      // Only deny unauthorized MCP tools here.
      canUseTool: async (toolName, input, { decisionReason }) => {
        // REMOTE_WORKBENCH — has proxy_execute that bypasses tool-level gating
        if (toolName === 'mcp__composio__COMPOSIO_REMOTE_WORKBENCH') {
          if (this.hitl) {
            console.log('[HITL] Requesting approval for REMOTE_WORKBENCH');
            const ctx = getGatewayContext()
            const result = await this.hitl.requestApproval(['REMOTE_WORKBENCH'], {
              platform: ctx.currentPlatform,
              sessionKey: ctx.currentSessionKey,
              chatId: ctx.currentChatId,
              toolParams: input,
            });
            if (result.approved) return { behavior: 'allow', updatedInput: input };
            return { behavior: 'deny', message: `User denied: REMOTE_WORKBENCH` };
          }
          console.log('[Permissions] Blocked COMPOSIO_REMOTE_WORKBENCH');
          return { behavior: 'deny', message: 'Remote workbench is not permitted' };
        }

        // LinkedIn write tools — require HITL approval
        if (toolName === 'mcp__linkedin__send_linkedin_message' ||
            toolName === 'mcp__linkedin__start_linkedin_chat' ||
            toolName === 'mcp__linkedin__send_connection_request' ||
            toolName === 'mcp__linkedin__respond_to_invitation') {
          if (this.hitl) {
            const action = toolName.replace('mcp__linkedin__', '')
            console.log(`[HITL] Requesting approval for LinkedIn: ${action}`)
            const ctx = getGatewayContext()
            const result = await this.hitl.requestApproval([action], {
              platform: ctx.currentPlatform,
              sessionKey: ctx.currentSessionKey,
              chatId: ctx.currentChatId,
              toolParams: input,
            });
            if (result.approved) return { behavior: 'allow', updatedInput: input };
            return { behavior: 'deny', message: `User denied LinkedIn action: ${action}` };
          }
          console.log(`[Permissions] Blocked LinkedIn send tool: ${toolName}`);
          return { behavior: 'deny', message: 'LinkedIn messaging requires HITL approval (HANDOFF_API_KEY not configured)' };
        }

        // Deny MCP tools not in allowedTools
        if (toolName.startsWith('mcp__')) {
          console.log(`[Permissions] Denied MCP tool ${toolName}`);
          return { behavior: 'deny', message: 'MCP tool not permitted' };
        }

        // Built-in tools (Read, Write, Bash, WebSearch, WebFetch, Task, etc.) → allow
        // Already gated by permission rules + sandbox
        return { behavior: 'allow', updatedInput: input };
      },
      // Inject permission rules via extraArgs → --settings flag
      // SDK merges this with sandbox config into --settings JSON automatically
      extraArgs: {
        settings: JSON.stringify({
          permissions: {
            deny: [
              ...denyPaths.flatMap(p => [`Read(${p}/**)`, `Edit(${p}/**)`, `Write(${p}/**)`]),
              ...denyPatterns.flatMap(p => [`Read(${p})`, `Edit(${p})`, `Write(${p})`]),
            ],
            allow: [
              // Allow Read/Edit/Write within workspace only (// = absolute path)
              `Read(//${this.workspace.replace(/^\//, '')}/**)`,
              `Edit(//${this.workspace.replace(/^\//, '')}/**)`,
              `Write(//${this.workspace.replace(/^\//, '')}/**)`,
              // Allow /tmp for temp files
              "Read(//tmp/**)",
              "Edit(//tmp/**)",
              "Write(//tmp/**)",
              // Allow auto memory (Read/Write/Edit to project memory dir)
              `Read(//${getClaudeProjectDir(this.workspace).replace(/^\//, '')}/memory/**)`,
              `Edit(//${getClaudeProjectDir(this.workspace).replace(/^\//, '')}/memory/**)`,
              `Write(//${getClaudeProjectDir(this.workspace).replace(/^\//, '')}/memory/**)`,
              // Allow all Bash (sandbox handles OS-level restrictions)
              "Bash",
            ],
          },
          // Block built-in claude.ai first-party integrations (Gmail, Calendar, etc.)
          // These come from the user's OAuth session, not settings files, so
          // settingSources: ['project'] doesn't exclude them. Block at server level
          // so they never appear in the model's tool list.
          deniedMcpServers: [
            { serverName: "claude_ai_Gmail" },
            { serverName: "claude_ai_Calendar" },
            { serverName: "claude_ai_Drive" },
            { serverName: "claude_ai_Docs" },
            { serverName: "claude_ai_Sheets" },
            { serverName: "claude_ai_Slides" },
          ],
        }),
      },
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        network: {
          allowLocalBinding: true,
          allowAllUnixSockets: true,
        },
        filesystem: {
          denyRead: [...denyPaths, '.env'],
          allowWrite: [
            this.workspace,              // ~/clawd workspace
            '/tmp',                      // temp files
            '~/.claude/shell-snapshots', // CLI shell env snapshots
            getClaudeProjectDir(this.workspace) + '/memory',  // auto memory
          ],
          denyWrite: [
            '.env',          // never write env files even in workspace
          ],
        },
        ignoreViolations: {
          '*': ['/usr/bin', '/System', '/usr/lib', '/Library'],
        },
      },
      settingSources: ['project'],
      env: {
        ...process.env,
        CLAUDECODE: "",  // prevent "nested session" detection when SDK spawns claude CLI
        ENABLE_TOOL_SEARCH: "true",
      },
      // MCP servers created fresh per query() call — SDK protocol allows only one
      // transport per server instance, so concurrent sessions need separate instances.
      // The underlying state (CronScheduler, gatewayContext, Composio tools) stays shared.
      mcpServers: {
        ...(() => {
          try {
            const server = createCronMcpServer()
            console.log('[ClaudeAgent] Cron MCP server created successfully')
            return { cron: server }
          } catch (err) {
            console.error('[ClaudeAgent] FAILED to create Cron MCP server:', err)
            return {}
          }
        })(),
        ...(() => {
          try {
            const server = createGatewayMcpServer()
            console.log('[ClaudeAgent] Gateway MCP server created successfully')
            return { gateway: server }
          } catch (err) {
            console.error('[ClaudeAgent] FAILED to create Gateway MCP server:', err)
            return {}
          }
        })(),
        ...(this.leannMcpServer ? { knowledge: this.leannMcpServer } : {}),
        ...(mcpServers.composioTools
          ? { composio: createSdkMcpServer({ name: 'composio', version: '1.0.0', tools: mcpServers.composioTools }) }
          : {}),
        ...(mcpServers.browserServer
          ? { browser: createBrowserMcpServer(mcpServers.browserServer) }
          : {}),
        ...(mcpServers.agency ? { agency: mcpServers.agency } : {}),
        ...(mcpServers.linkedin ? { linkedin: createLinkedinMcpServer(mcpServers.linkedin) } : {}),
        // Obsidian MCP removed — memory is nanograph at ~/clawd/graph/
      },
    };

    // DEBUG: Log permission settings being passed
    console.log("[Permissions] Mode:", queryOptions.permissionMode);
    console.log("[Permissions] extraArgs.settings:", queryOptions.extraArgs?.settings);
    console.log("[Permissions] canUseTool defined:", !!queryOptions.canUseTool);

    // Resume session if exists
    if (session.sdkSessionId) {
      queryOptions.resume = session.sdkSessionId;
    }

    const abortController = new AbortController();
    this.abortControllers.set(sessionKey, abortController);

    if (image) console.log("[ClaudeAgent] With image attachment");

    this.emit("run:start", { sessionKey, message, hasImage: !!image });

    // Retry once if session is corrupted (exit code 1 on resume)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let fullText = "";
        let hasStreamedContent = false;

        for await (const chunk of query({
          prompt: this.generateMessages(message, image),
          options: queryOptions,
          abortSignal: abortController.signal,
        })) {
          // Capture session ID
          if (chunk.type === "system" && chunk.subtype === "init") {
            const newSessionId = chunk.session_id || chunk.data?.session_id;
            if (newSessionId) {
              session.sdkSessionId = newSessionId;
              this.sessions.save();
            }
            continue;
          }

          // Handle streaming partial messages (token-level streaming)
          if (chunk.type === "stream_event" && chunk.event) {
            const event = chunk.event;
            hasStreamedContent = true;

            if (
              event.type === "content_block_delta" &&
              event.delta?.type === "text_delta"
            ) {
              const text = event.delta.text;
              if (text) {
                fullText += text;
                yield { type: "text", content: text };
                this.emit("run:text", { sessionKey, content: text });
              }
            } else if (
              event.type === "content_block_start" &&
              event.content_block?.type === "tool_use"
            ) {
              yield {
                type: "tool_use",
                name: event.content_block.name,
                input: {},
                id: event.content_block.id,
              };
              this.emit("run:tool", {
                sessionKey,
                name: event.content_block.name,
              });
            }
            continue;
          }

          // Handle complete assistant messages (only if we haven't streamed content)
          if (chunk.type === "assistant" && chunk.message?.content) {
            for (const block of chunk.message.content) {
              if (block.type === "text" && block.text && !hasStreamedContent) {
                fullText += block.text;
                yield { type: "text", content: block.text };
                this.emit("run:text", { sessionKey, content: block.text });
              } else if (block.type === "tool_use" && !hasStreamedContent) {
                yield {
                  type: "tool_use",
                  name: block.name,
                  input: block.input,
                  id: block.id,
                };
                this.emit("run:tool", { sessionKey, name: block.name });
              }
            }
            continue;
          }

          if (chunk.type === "tool_result" || chunk.type === "result") {
            yield { type: "tool_result", result: chunk.result || chunk.content };
            continue;
          }

          if (chunk.type !== "system") {
            yield chunk;
          }
        }

        yield { type: "done", fullText };
        this.emit("run:complete", { sessionKey, response: fullText });
        break; // success — exit retry loop
      } catch (error) {
        if (error.name === "AbortError") {
          console.log("[ClaudeAgent] Aborted:", sessionKey);
          yield { type: "aborted" };
          this.emit("run:aborted", { sessionKey });
          break;
        }
        // Corrupted session — clear and retry once
        if (attempt === 0 && queryOptions.resume && error.message?.includes("exited with code 1")) {
          console.warn(`[ClaudeAgent] Session ${queryOptions.resume} appears corrupted, starting fresh`);
          session.sdkSessionId = null;
          this.sessions.save();
          delete queryOptions.resume;
          continue; // retry
        }
        console.error("[ClaudeAgent] Error:", error);
        yield { type: "error", error: error.message };
        this.emit("run:error", { sessionKey, error });
        throw error;
      }
    }
    this.abortControllers.delete(sessionKey);
  }

  /**
   * Run and collect full response
   */
  async runAndCollect(params) {
    let fullText = "";
    for await (const chunk of this.run(params)) {
      if (chunk.type === "text") {
        fullText += chunk.content;
      }
      if (chunk.type === "done") {
        return chunk.fullText || fullText;
      }
      if (chunk.type === "error") {
        throw new Error(chunk.error);
      }
    }
    return fullText;
  }

  stopCron() {
    this.cronScheduler.stop();
  }
}
