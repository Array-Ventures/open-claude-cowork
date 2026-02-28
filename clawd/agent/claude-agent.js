import { query } from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "events";
import path from "path";
import os from "os";
import MemoryManager from "../memory/manager.js";
import {
  createCronMcpServer,
  setContext as setCronContext,
  getScheduler,
} from "../tools/cron.js";
import { createGatewayMcpServer, setGatewayContext } from "../tools/gateway.js";
import { WorkspaceIndexer } from "../indexing/index.js";

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
 * Build the system prompt with memory system info
 */
function buildSystemPrompt(memoryContext, sessionInfo, cronInfo, workspace) {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-US", { hour12: true });

  return `You are Clawd, a personal AI assistant communicating via messaging platforms (WhatsApp, iMessage).

## Current Context
- Date: ${dateStr}
- Time: ${timeStr}
- Session: ${sessionInfo.sessionKey}
- Platform: ${sessionInfo.platform}

## Memory System

You have access to a persistent memory system. Use it to remember important information across conversations.

### Memory Structure
- **MEMORY.md**: Curated long-term memory for important facts, preferences, and decisions
- **memory/YYYY-MM-DD.md**: Daily notes (append-only log for each day)

### When to Write Memory
- **Immediately write** when the user says "remember this" or similar
- **Write to MEMORY.md** for: preferences, important decisions, recurring information, relationships, key facts
- **Write to daily log** for: tasks completed, temporary notes, conversation context, things that happened today

### Memory Tools
- Use \`Read\` tool to read memory files from ${workspace}/
- Use \`Write\` or \`Edit\` tools to update memory files
- Workspace path: ${workspace}/

### Memory Writing Guidelines
1. Be concise but include enough context to be useful later
2. Use markdown headers to organize information
3. Include dates when relevant
4. For MEMORY.md, organize by topic/category
5. For daily logs, use timestamps

## Current Memory Context
${memoryContext || "No memory files found yet. Start building your memory!"}

## Scheduling / Reminders

You have cron tools to schedule messages:
- \`mcp__cron__schedule_delayed\`: One-time reminder after delay (seconds)
- \`mcp__cron__schedule_recurring\`: Repeat at interval (seconds)
- \`mcp__cron__schedule_cron\`: Cron expression (minute hour day month weekday)
- \`mcp__cron__list_scheduled\`: List all scheduled jobs
- \`mcp__cron__cancel_scheduled\`: Cancel a job by ID

When user says "remind me in X minutes/hours", use schedule_delayed.
When user says "every day at 9am", use schedule_cron with "0 9 * * *".

### Current Scheduled Jobs
${cronInfo || "No jobs scheduled"}

## Image Handling

When the user sends an image, you will receive it in your context. You can:
- Describe what you see in the image
- Answer questions about the image
- Extract text from images (OCR)
- Analyze charts, diagrams, screenshots

## Communication Style
- Be helpful and conversational
- Keep responses concise for messaging (avoid walls of text)
- DO NOT use markdown formatting (no **, \`, #, -, etc.) - messaging platforms don't render it
- Use plain text only - write naturally without formatting syntax
- Use emoji sparingly and appropriately
- Remember context from the conversation
- Proactively use tools when needed
- DO NOT mention details about connected accounts (emails, usernames, account IDs) unless explicitly asked - just perform the action silently

## Available Tools
Built-in: Read, Write, Edit, Bash, Glob, Grep, TodoWrite, Skill
Scheduling: mcp__cron__schedule_delayed, mcp__cron__schedule_recurring, mcp__cron__schedule_cron, mcp__cron__list_scheduled, mcp__cron__cancel_scheduled
Gateway: mcp__gateway__send_message, mcp__gateway__list_platforms, mcp__gateway__get_queue_status, mcp__gateway__get_current_context, mcp__gateway__list_sessions, mcp__gateway__broadcast_message
Composio: Access to 500+ app integrations (Gmail, Slack, GitHub, Google Sheets, etc.) via Composio MCP tools
Browser: Browser automation via mcp__browser tools (see below)

## Gateway Tools
- \`mcp__gateway__send_message\`: Send a message to any chat on any platform
- \`mcp__gateway__list_platforms\`: List connected platforms
- \`mcp__gateway__get_queue_status\`: Check message queue status
- \`mcp__gateway__get_current_context\`: Get current platform/chat/session info
- \`mcp__gateway__list_sessions\`: List all active sessions
- \`mcp__gateway__broadcast_message\`: Send to multiple chats (use carefully)

## Tool Selection - IMPORTANT

**Default: Use Composio tools for app integrations.**
For tasks involving Gmail, Slack, GitHub, Google Sheets, Calendar, Notion, Trello, Jira, and other apps, ALWAYS use Composio MCP tools. These are faster, more reliable, and work via API.

**Browser tools are ONLY for when the user explicitly mentions:**
- "browser", "browse", "open website", "go to site", "navigate to"
- "web page", "webpage", "website"
- Specific URLs they want to visit
- Tasks that require visual interaction with a website that Composio cannot handle

Examples:
- "Send an email to John" → Use Composio (Gmail tools)
- "Check my GitHub notifications" → Use Composio (GitHub tools)
- "Open google.com in the browser" → Use Browser tools
- "Browse to twitter.com and take a screenshot" → Use Browser tools
- "Post a message in Slack" → Use Composio (Slack tools)
- "Go to amazon.com and search for headphones" → Use Browser tools

## Browser Tools (only when explicitly requested)
  - browser_status: Get browser status (running, mode, current URL, tab count)
  - browser_navigate: Navigate to a URL
  - browser_snapshot: Get accessibility tree snapshot (returns elements with [ref=eN] identifiers for targeting)
  - browser_screenshot: Take a screenshot of the current page
  - browser_click: Click element by ref (e.g., "e5") or text description (e.g., "Submit button")
  - browser_type: Type text into input fields (use ref or field name/placeholder)
  - browser_press: Press keyboard keys (e.g., "Enter", "Tab", "Escape")
  - browser_select: Select dropdown options
  - browser_wait: Wait for element or text to appear
  - browser_tabs: List all open tabs
  - browser_switch_tab: Switch to a tab by index
  - browser_new_tab: Open a new tab
  - browser_close_tab: Close current tab
  - browser_back: Go back in history
  - browser_forward: Go forward in history
  - browser_reload: Reload the page

### Browser Workflow (when needed)
1. Use browser_navigate to go to a URL
2. Use browser_snapshot to see the page structure and get element refs
3. Use browser_click/browser_type with refs (e.g., "e5") or descriptions to interact
4. Take browser_screenshot to verify visual state if needed

## Important
- The workspace at ${workspace}/ is your home - use it to store files and memory
- Always check memory before asking the user for information they may have already told you
- Update memory when you learn new persistent information about the user
- When user asks to be reminded, use the cron scheduling tools

## Platform Switching / Starting Gateway
When the user says things like "can I text you on WhatsApp?" or "I'm going outside, let me message you on WhatsApp":
- This means they want to continue the conversation on WhatsApp
- Tell the user the gateway needs to be started manually for now: \`cd ~/Downloads/Parth/open-claude-cowork/clawd && npm start\`
- A gateway control tool will be available soon to start/stop the gateway directly
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
    this.memoryManager = new MemoryManager(this.workspace);
    this.cronMcpServer = createCronMcpServer();
    this.cronScheduler = getScheduler();
    this.gatewayMcpServer = createGatewayMcpServer();
    this.indexer = new WorkspaceIndexer(this.workspace, config.indexing || {});
    this.leannMcpServer = this.indexer.getLeannMcpServerConfig();
    this.gateway = null; // Set by gateway after construction
    this.sessions = new Map();
    this.abortControllers = new Map();

    // allowedTools = auto-approved tools (skip ALL permission checks).
    // Only MCP tools go here. Built-in tools (Read/Write/Edit/Bash/etc.)
    // go through permission rules (deny/allow) + canUseTool callback.
    this.allowedTools = config.allowedTools || [];

    // Add cron MCP tools to allowed list
    this.cronTools = [
      "mcp__cron__schedule_delayed",
      "mcp__cron__schedule_recurring",
      "mcp__cron__schedule_cron",
      "mcp__cron__list_scheduled",
      "mcp__cron__cancel_scheduled",
    ];

    // Add gateway MCP tools to allowed list
    this.gatewayTools = [
      "mcp__gateway__send_message",
      "mcp__gateway__list_platforms",
      "mcp__gateway__get_queue_status",
      "mcp__gateway__get_current_context",
      "mcp__gateway__list_sessions",
      "mcp__gateway__broadcast_message",
    ];

    // Add LEANN indexing tools to allowed list
    this.indexingTools = [
      "mcp__leann__leann_search",
      "mcp__leann__leann_list",
    ];

    // Add browser MCP tools to allowed list
    this.browserTools = [
      "mcp__browser__browser_navigate",
      "mcp__browser__browser_snapshot",
      "mcp__browser__browser_screenshot",
      "mcp__browser__browser_click",
      "mcp__browser__browser_type",
      "mcp__browser__browser_press",
      "mcp__browser__browser_select",
      "mcp__browser__browser_wait",
      "mcp__browser__browser_tabs",
      "mcp__browser__browser_switch_tab",
      "mcp__browser__browser_new_tab",
      "mcp__browser__browser_close_tab",
      "mcp__browser__browser_back",
      "mcp__browser__browser_forward",
      "mcp__browser__browser_reload",
      "mcp__browser__browser_status",
    ];

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
    } = params;

    const session = this.getSession(sessionKey);
    session.lastActivity = Date.now();
    session.messageCount++;

    // Set cron context for scheduled messages
    setCronContext({ platform, chatId, sessionKey });

    // Set gateway context
    setGatewayContext({
      gateway: this.gateway,
      currentPlatform: platform,
      currentChatId: chatId,
      currentSessionKey: sessionKey,
    });

    // Build system prompt
    const memoryContext = this.memoryManager.getMemoryContext();
    const cronInfo = this.getCronSummary();
    const systemPrompt = buildSystemPrompt(
      memoryContext,
      { sessionKey, platform },
      cronInfo,
      this.workspace,
    );

    // MCP tools need auto-approval (no permission prompt). Built-in tools
    // go through permission rules + canUseTool — do NOT put them here.
    const autoApprovedTools = [
      ...this.allowedTools,
      ...this.cronTools,
      ...this.gatewayTools,
      ...this.indexingTools,
      ...this.browserTools,
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
      tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],  // available built-in tools
      allowedTools: autoApprovedTools,  // auto-approved (MCP only, skip permission checks)
      maxTurns: this.maxTurns,
      permissionMode: this.permissionMode,
      systemPrompt,
      includePartialMessages: true,
      // Safety net: deny anything not approved by permission rules
      canUseTool: async (toolName, input, { decisionReason }) => {
        console.log(`[Permissions] Denied ${toolName}: ${decisionReason || 'outside workspace scope'}`);
        return { behavior: 'deny', message: 'Operation not permitted — outside workspace scope' };
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
              // Allow all Bash (sandbox handles OS-level restrictions)
              "Bash",
            ],
          },
        }),
      },
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        network: {
          allowLocalBinding: true,
        },
        filesystem: {
          denyRead: [...denyPaths, '.env'],
          allowWrite: [
            this.workspace,              // ~/clawd workspace
            '/tmp',                      // temp files
            '~/.claude/shell-snapshots', // CLI shell env snapshots
          ],
          denyWrite: [
            '.env',          // never write env files even in workspace
          ],
        },
        ignoreViolations: {
          '*': ['/usr/bin', '/System', '/usr/lib', '/Library'],
        },
      },
      settingSources: [],
      env: {
        ...process.env,
        ENABLE_TOOL_SEARCH: "true",
      },
      mcpServers: {
        cron: this.cronMcpServer,
        gateway: this.gatewayMcpServer,
        ...(this.leannMcpServer ? { leann: this.leannMcpServer } : {}),
        ...mcpServers,
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

    try {
      let fullText = "";
      let hasStreamedContent = false;

      // Use streaming input for MCP compatibility
      for await (const chunk of query({
        prompt: this.generateMessages(message, image),
        options: queryOptions,
        abortSignal: abortController.signal,
      })) {
        // Capture session ID (only on first assignment)
        if (chunk.type === "system" && chunk.subtype === "init") {
          const newSessionId = chunk.session_id || chunk.data?.session_id;
          if (newSessionId && !session.sdkSessionId) {
            session.sdkSessionId = newSessionId;
          } else if (newSessionId) {
            session.sdkSessionId = newSessionId;
          }
          continue;
        }

        // Handle streaming partial messages (token-level streaming)
        if (chunk.type === "stream_event" && chunk.event) {
          const event = chunk.event;
          hasStreamedContent = true;

          // Text delta - stream individual tokens
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
          }
          // Tool use start
          else if (
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
        // Skip text blocks since they were already streamed via stream_event
        if (chunk.type === "assistant" && chunk.message?.content) {
          for (const block of chunk.message.content) {
            // Only yield text if we haven't been streaming
            if (block.type === "text" && block.text && !hasStreamedContent) {
              fullText += block.text;
              yield { type: "text", content: block.text };
              this.emit("run:text", { sessionKey, content: block.text });
            } else if (block.type === "tool_use") {
              // Tool use with full input (stream_event only has partial)
              if (!hasStreamedContent) {
                yield {
                  type: "tool_use",
                  name: block.name,
                  input: block.input,
                  id: block.id,
                };
                this.emit("run:tool", { sessionKey, name: block.name });
              }
            }
          }
          continue;
        }

        // Handle tool results
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
    } catch (error) {
      if (error.name === "AbortError") {
        console.log("[ClaudeAgent] Aborted:", sessionKey);
        yield { type: "aborted" };
        this.emit("run:aborted", { sessionKey });
      } else {
        console.error("[ClaudeAgent] Error:", error);
        yield { type: "error", error: error.message };
        this.emit("run:error", { sessionKey, error });
        throw error;
      }
    } finally {
      this.abortControllers.delete(sessionKey);
    }
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
