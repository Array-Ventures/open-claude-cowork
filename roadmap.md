# Roadmap

## DONE

### ~~2. Wire up configurable working directory (cwd) in Clawd~~ ✅
- Unified `config.agent.workspace` as single source of truth
- `resolveWorkspace()` helper in `claude-agent.js` expands `~/` paths
- `cwd: this.workspace` passed to SDK `query()` options
- `MemoryManager` accepts workspace from constructor (env var as fallback)
- `buildSystemPrompt()` uses dynamic `${workspace}/` instead of hardcoded path
- `gateway.js` and `cli.js` both pass `config.agent?.workspace` through

### ~~Enable sandbox~~ ✅
- Sandbox enabled in `claude-agent.js` query options: `sandbox: { enabled: true, autoAllowBashIfSandboxed: true, network: { allowLocalBinding: true } }`
- Agent's Bash/Read/Write/Edit scoped to workspace (`~/clawd/`)
- Host process (adapters, MCP servers, browser) unaffected — runs outside sandbox
- `permissionMode` stays `'bypassPermissions'` for now (needs Electron bridge for approval UI)
- Removed hardcoded gateway Bash command from system prompt (will be an MCP tool)

### ~~LEANN Workspace Indexing~~ ✅
- `WorkspaceIndexer` class in `clawd/indexing/manager.js` — manages LEANN-based semantic indexing
- Config-driven via `config.indexing` (enabled, sources, autoIndex)
- LEANN MCP server (`leann_mcp` stdio) registered in agent for `leann_search`/`leann_list` tools
- Auto-indexes on startup (fire-and-forget), `/reindex` slash command for manual rebuild
- Graceful degradation: works without LEANN installed, warns and skips
- Extensible `sources` array for future transcript/conversation/app indexing
- LEANN has built-in `.gitignore` support + excludes `.git`, `node_modules`, `__pycache__`, etc.
- Both gateway and terminal chat paths wired up

### ~~Enable built-in tool search~~ ✅
- `ENABLE_TOOL_SEARCH=true` via SDK `env` option — CLI auto-adds `MCPSearch` tool
- `settingSources: ["user"]` loads `~/.claude/settings.json` (outside agent workspace)

## TODO

### 5. CLI↔Gateway interaction
- Terminal chat (`npm run chat`) currently creates a standalone agent — separate from the gateway
- Should be able to connect to a running gateway instead, sharing sessions and adapter access
- Send messages through WhatsApp/Telegram/etc. from terminal, view cross-platform conversations
- Related to #4 (Electron bridge) — both need an API layer on the gateway

### 1. Add permission controls and hooks to Clawd (depends on #3 Electron bridge)
- Change `permissionMode` from `'bypassPermissions'` to `'default'`
- Implement `canUseTool` handler that routes approval requests to the Electron control panel
- Add human-in-the-loop UI in the Electron renderer for tool approval/denial
- **Use SDK hooks** for granular control — Clawd currently uses no hooks at all
  - `PreToolUse` hook with matcher to intercept dangerous tools (e.g. `Bash`) and route to Electron UI for approval
  - `PostToolUse` hook to log/monitor tool results in the control panel
  - `PermissionRequest` hook to handle permission prompts when `permissionMode` is `'default'`
- **SDK permission system** for allowlisting paths outside sandbox:
  - `canUseTool` can return `updatedPermissions: [{ type: 'addDirectories', directories: [...], destination: 'session' }]`
  - `PermissionRequest` hook can do the same via `decision.updatedPermissions`
  - `blockedPath` is passed to `canUseTool` when a path is denied

### 2. Gateway control tool
- Add single `gateway_control` tool to existing `clawd/tools/gateway.js` with `action` param: `start`, `stop`, `health_check`
- Replaces the hardcoded Bash command in the system prompt
- Runs gateway from the host process (outside sandbox) using `child_process.spawn`

### 3. Add plugins support
- Pass `plugins` option in `clawd/agent/claude-agent.js` query options
  ```typescript
  plugins: [
    { type: "local", path: "./plugins/my-plugin" }
  ]
  ```
- Allow users to configure plugins via Clawd config or the Electron control panel
- Support loading plugins from a configurable directory
- Currently `settingSources` is not set in Clawd — consider adding it for user/project-level plugin auto-detection
- **Skills**: No direct `skills` option in the SDK — skills are delivered through plugins. To add skills programmatically, create a plugin containing skill files and pass via `plugins`. Skills in `~/.claude/` and `.claude/` directories are auto-detected when `settingSources` includes `'user'` and `'project'`. The `Skill` tool is already in `allowedTools`.

### 4. Bridge Electron app with Clawd gateway
The Electron app and Clawd are currently two separate systems. The Electron app should act as a **control panel** for the Clawd gateway process, not run its own bare-bones agent.

#### Architecture
- Clawd gateway runs as the core agent process (with memory, cron, browser, Composio, messaging adapters)
- Electron app connects to it as a control panel / dashboard
- The server layer becomes a bridge, not a standalone agent

#### Implementation
- **Expose Clawd gateway over HTTP/WebSocket**
  - Add an API layer to `gateway.js` (Express or WS server) that exposes:
    - `POST /chat` — send messages to the agent (same as messaging adapters do via `agentRunner.enqueueRun`)
    - `GET /sessions` — list active sessions across all platforms
    - `GET /memory` — read current memory state
    - `GET /cron` — list scheduled jobs
    - `GET /adapters` — list connected platforms and their status
    - `POST /commands` — execute slash commands (`/new`, `/status`, `/memory`, `/stop`)
    - `WS /stream` — real-time streaming of agent responses and events
- **Update Electron server** to proxy to Clawd gateway instead of running its own `ClaudeProvider`
- **Update Electron frontend** to:
  - Show connected messaging platforms and their status
  - Display cross-platform session list
  - View/edit memory (MEMORY.md + daily logs)
  - Manage cron jobs (list, create, cancel)
  - Monitor agent activity in real-time across all platforms
  - Chat directly with Clawd (as another "adapter")

#### Benefits
- Single agent instance with shared memory across all platforms + Electron
- Electron becomes a dashboard for monitoring WhatsApp/Telegram/iMessage/Signal conversations
- No duplicate agent logic between `server/` and `clawd/`
- Centralized configuration
