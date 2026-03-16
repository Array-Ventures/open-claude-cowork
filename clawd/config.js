export default {
  agentId: "clawd",

  whatsapp: {
    enabled: true,
    allowedDMs: process.env.WHATSAPP_ALLOWED_DMS?.split(',').filter(Boolean) || [],
    allowedGroups: process.env.WHATSAPP_ALLOWED_GROUPS?.split(',').filter(Boolean) || [],
    respondToMentionsOnly: true, // for groups, only respond when mentioned
  },

  imessage: {
    enabled: false, // Set to true after signing into Messages.app
    allowedDMs: ["*"], // '*' allows all, or specific chat IDs
    allowedGroups: [], // group chat IDs
    respondToMentionsOnly: true, // for groups, only respond when mentioned
  },

  telegram: {
    enabled: false, // Set to true and add bot token
    token: "", // Get from @BotFather on Telegram
    allowedDMs: ["*"], // '*' allows all, or specific user IDs
    allowedGroups: [], // group chat IDs
    respondToMentionsOnly: true, // for groups, only respond when @mentioned
  },

  signal: {
    enabled: false, // Set to true after setting up signal-cli
    phoneNumber: "", // Your Signal phone number with country code (+1234567890)
    signalCliPath: "signal-cli", // Path to signal-cli binary
    allowedDMs: ["*"], // '*' allows all, or specific phone numbers
    allowedGroups: [], // group IDs
    respondToMentionsOnly: true, // for groups, only respond when mentioned
  },

  // Agent configuration
  agent: {
    workspace: "~/clawd", // Agent workspace directory
    model: "claude-sonnet-4-6", // Model to use (claude-sonnet-4-6, claude-opus-4-6, etc.)
    maxTurns: 50, // Max tool-use turns per message
    allowedTools: [],  // auto-approved tools only (MCP tools added by agent)
    sensitiveActions: [
      // Composio tool slugs that should be blocked by canUseTool.
      // These are checked inside COMPOSIO_MULTI_EXECUTE_TOOL and COMPOSIO_REMOTE_WORKBENCH.

      // Gmail — sending
      "GMAIL_SEND_EMAIL",
      "GMAIL_SEND_DRAFT",
      "GMAIL_REPLY_TO_THREAD",
      "GMAIL_FORWARD_MESSAGE",
      // Gmail — deleting
      "GMAIL_DELETE_MESSAGE",
      "GMAIL_DELETE_THREAD",
      "GMAIL_BATCH_DELETE_MESSAGES",
      "GMAIL_MOVE_TO_TRASH",
      "GMAIL_TRASH_THREAD",
      "GMAIL_DELETE_DRAFT",
      "GMAIL_DELETE_FILTER",
      "GMAIL_DELETE_LABEL",
      // Gmail — mailbox manipulation
      "GMAIL_CREATE_FILTER",
      "GMAIL_IMPORT_MESSAGE",
      "GMAIL_INSERT_MESSAGE",
      "GMAIL_UPDATE_VACATION_SETTINGS",
      "GMAIL_PATCH_SEND_AS",

      // LinkedIn — posting/commenting
      "LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE",
      "LINKEDIN_CREATE_COMMENT_ON_POST",
      "LINKEDIN_CREATE_LINKED_IN_POST",
      // LinkedIn — deleting
      "LINKEDIN_DELETE_LINKED_IN_POST",
      "LINKEDIN_DELETE_POST",
      "LINKEDIN_DELETE_UGC_POST",
      "LINKEDIN_DELETE_UGC_POSTS",

      // Twitter — posting/sending
      "TWITTER_CREATION_OF_A_POST",
      "TWITTER_RETWEET_POST",
      "TWITTER_SEND_A_NEW_MESSAGE_TO_A_USER",
      "TWITTER_SEND_A_NEW_MESSAGE_TO_A_DM_CONVERSATION",
      "TWITTER_CREATE_A_NEW_DM_CONVERSATION",
      // Twitter — deleting
      "TWITTER_POST_DELETE_BY_POST_ID",
      "TWITTER_DELETE_DM",
      "TWITTER_DELETE_LIST",
      // Twitter — social actions
      "TWITTER_FOLLOW_USER",
      "TWITTER_UNFOLLOW_USER",

      // Google Calendar — events
      "GOOGLECALENDAR_CREATE_EVENT",
      "GOOGLECALENDAR_DELETE_EVENT",
      "GOOGLECALENDAR_PATCH_EVENT",
      "GOOGLECALENDAR_UPDATE_EVENT",
      "GOOGLECALENDAR_EVENTS_MOVE",
      "GOOGLECALENDAR_REMOVE_ATTENDEE",
      "GOOGLECALENDAR_QUICK_ADD",
      // Google Calendar — destructive
      "GOOGLECALENDAR_CALENDARS_DELETE",
      "GOOGLECALENDAR_CLEAR_CALENDAR",
      "GOOGLECALENDAR_CALENDAR_LIST_DELETE",
      // Google Calendar — access control
      "GOOGLECALENDAR_ACL_INSERT",
      "GOOGLECALENDAR_ACL_DELETE",
      "GOOGLECALENDAR_ACL_PATCH",

      // Google Sheets
      "GOOGLESHEETS_DELETE_SHEET",

      // Slack
      "SLACK_SEND_MESSAGE",
      "SLACK_SEND_MESSAGE_TO_CHANNEL",

      // GitHub
      "GITHUB_CREATE_ISSUE",
      "GITHUB_CREATE_PR",
    ],
  },

  // Workspace indexing (requires LEANN: uv tool install leann-core --with leann)
  indexing: {
    enabled: true,
    sources: [
      { name: "workspace", type: "workspace" },
      { name: "transcripts", type: "transcripts" },
    ],
  },

  // Handoff Server — human-in-the-loop approvals for sensitive actions
  handoff: {
    enabled: !!process.env.HANDOFF_API_KEY,
    baseUrl: process.env.HANDOFF_BASE_URL || 'http://localhost:8080',
    apiKey: process.env.HANDOFF_API_KEY,         // hnd_... key
    loopId: process.env.HANDOFF_LOOP_ID,         // loop UUID for sensitive action approvals
    timeoutSeconds: 120,                          // 2 min default
  },

  // Heartbeat — periodic silent agent invocation
  heartbeat: {
    enabled: process.env.HEARTBEAT_ENABLED !== 'false',
    cron: "*/30 * * * *", // every 30 minutes
    prompt: "Check for anything to proactively notify the user about — new important emails, upcoming calendar events, pending reminders. Only message the user if something is genuinely worth their attention.",
  },

  // Composio triggers — event-driven automation
  triggers: [
    { slug: 'GMAIL_NEW_GMAIL_MESSAGE', defaults: {} },
    // { slug: 'GITHUB_COMMIT_EVENT', defaults: { owner: 'user', repo: 'repo' } },
  ],

  // LinkedIn messaging via Unipile
  unipile: {
    enabled: !!process.env.UNIPILE_API_KEY,
    baseUrl: process.env.UNIPILE_BASE_URL,  // e.g. https://api1.unipile.com:13111
    apiKey: process.env.UNIPILE_API_KEY,
    accountId: process.env.UNIPILE_ACCOUNT_ID,  // LinkedIn account ID from Unipile
  },

  browser: {
    enabled: true,
    mode: "clawd",
    clawd: {
      userDataDir: "~/.clawd/browser-profile",
      headless: false,
    },
    chrome: {
      profilePath: "",
      cdpPort: 9222,
    },
  },
};
