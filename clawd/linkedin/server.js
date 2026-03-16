import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Unipile REST API client for LinkedIn messaging and connections.
 * Wraps fetch calls with auth, query params, and multipart/form-data or JSON for POST.
 */
class UnipileClient {
  constructor({ baseUrl, apiKey }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.apiKey = apiKey
  }

  async request(method, path, { query, body, json } = {}) {
    const url = new URL(path, this.baseUrl)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, v)
      }
    }

    const opts = {
      method,
      headers: { 'X-API-KEY': this.apiKey, 'Accept': 'application/json' },
    }

    if (body) {
      if (json) {
        opts.headers['Content-Type'] = 'application/json'
        opts.body = JSON.stringify(body)
      } else {
        const form = new FormData()
        for (const [k, v] of Object.entries(body)) {
          if (v === undefined || v === null) continue
          if (Array.isArray(v)) {
            for (const item of v) form.append(k, item)
          } else {
            form.append(k, String(v))
          }
        }
        opts.body = form
      }
    }

    const res = await fetch(url, opts)
    const text = await res.text()

    if (!res.ok) {
      let detail = text
      try { detail = JSON.parse(text).detail || JSON.parse(text).title || text } catch {}
      throw new Error(`Unipile ${res.status}: ${detail}`)
    }

    return JSON.parse(text)
  }

  listChats(query) {
    return this.request('GET', '/api/v1/chats', { query: { account_type: 'LINKEDIN', ...query } })
  }

  getChatAttendees(chatId) {
    return this.request('GET', `/api/v1/chats/${chatId}/attendees`)
  }

  getMessages(chatId, query) {
    return this.request('GET', `/api/v1/chats/${chatId}/messages`, { query })
  }

  sendMessage(chatId, body) {
    return this.request('POST', `/api/v1/chats/${chatId}/messages`, { body })
  }

  startChat(body) {
    return this.request('POST', '/api/v1/chats', { body })
  }

  listReceivedInvites(query) {
    return this.request('GET', '/api/v1/users/invite/received', { query })
  }

  listSentInvites(query) {
    return this.request('GET', '/api/v1/users/invite/sent', { query })
  }

  sendInvite(body) {
    return this.request('POST', '/api/v1/users/invite', { body, json: true })
  }

  respondToInvite(invitationId, body) {
    return this.request('POST', `/api/v1/users/invite/received/${invitationId}`, { body, json: true })
  }
}

// --- Formatting helpers ---

function timeAgo(timestamp) {
  const mins = Math.floor((Date.now() - new Date(timestamp).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatMessageTime(timestamp) {
  const d = new Date(timestamp)
  const diffDays = Math.floor((Date.now() - d) / 86400000)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  if (diffDays === 0) return time
  if (diffDays < 7) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(diffDays > 365 && { year: 'numeric' }) })
}

const DEGREE_MAP = { DISTANCE_1: '1st', DISTANCE_2: '2nd', DISTANCE_3: '3rd' }

/**
 * Parse a raw attendee object into a clean profile.
 */
function parseAttendee(a) {
  return {
    name: a.name || 'Unknown',
    occupation: a.specifics?.occupation || '',
    degree: DEGREE_MAP[a.specifics?.network_distance] || '',
    isSelf: a.is_self === 1,
    profileUrl: a.profile_url || '',
    providerId: a.provider_id,
  }
}

/**
 * Format attendee as "Name (Occupation, 1st)"
 */
function formatAttendee(a) {
  const info = [a.occupation, a.degree].filter(Boolean).join(', ')
  return info ? `${a.name} (${info})` : a.name
}

/**
 * Format an invitation (received or sent) as a human-readable line.
 */
function formatInvitation(inv, type) {
  const isReceived = type === 'received'
  const name = isReceived ? inv.inviter?.inviter_name : inv.invited_user
  const desc = isReceived ? inv.inviter?.inviter_description : inv.invited_user_description
  const slug = isReceived ? inv.inviter?.inviter_public_identifier : inv.invited_user_public_id

  let label = name || 'Unknown'
  if (desc) label += ` (${desc})`

  const parts = [label]
  if (inv.invitation_text) parts.push(`"${inv.invitation_text}"`)
  parts.push(inv.date || timeAgo(inv.parsed_datetime))
  if (slug) parts.push(`linkedin.com/in/${slug}`)

  const sharedSecret = isReceived ? inv.specifics?.shared_secret : null
  return { id: inv.id, sharedSecret, detail: parts.join(' — ') }
}

/**
 * Create an MCP server for LinkedIn messaging via Unipile
 */
export function createLinkedinMcpServer({ baseUrl, apiKey, accountId, accountName }) {
  const client = new UnipileClient({ baseUrl, apiKey })
  const acct = accountName ? ` (${accountName}'s account)` : ''
  const desc = (d) => `${d}${acct}`

  /** Fetch non-self attendees for a chat, keyed by provider_id */
  async function getOtherAttendees(chatId) {
    const data = await client.getChatAttendees(chatId)
    const map = {}
    for (const raw of data.items || []) {
      const a = parseAttendee(raw)
      if (!a.isSelf) map[a.providerId] = a
    }
    return map
  }

  const text = (str) => ({ content: [{ type: 'text', text: str }] })

  return createSdkMcpServer({
    name: 'linkedin',
    version: '1.0.0',
    tools: [
      tool(
        'list_linkedin_chats',
        desc('List recent LinkedIn DM conversations with contact info, unread count, and how long ago.'),
        {
          unread: z.boolean().optional().describe('If true, only return unread chats'),
          limit: z.number().optional().describe('Max chats to return (1-250, default 15)')
        },
        async (args) => {
          const data = await client.listChats({ unread: args.unread, limit: args.limit || 15 })
          const lines = [`LinkedIn DMs (${data.items.length} conversations):\n`]

          for (let i = 0; i < data.items.length; i++) {
            const c = data.items[i]
            let label = c.name || 'Unknown'

            if (c.type === 0) {
              try {
                const attendees = await getOtherAttendees(c.id)
                const other = Object.values(attendees)[0]
                if (other) label = formatAttendee(other)
              } catch {}
            }

            const unread = c.unread_count > 0 ? `${c.unread_count} unread` : 'read'
            lines.push(`${i + 1}. ${label} — ${unread}, ${timeAgo(c.timestamp)}`)
            lines.push(`   chat_id: ${c.id}`)
          }

          if (data.cursor) lines.push('\n(more conversations available)')
          return text(lines.join('\n'))
        }
      ),

      tool(
        'read_linkedin_messages',
        'Read messages from a LinkedIn chat. Shows who said what, with timestamps and attendee profile info.',
        {
          chat_id: z.string().describe('The chat ID to read messages from'),
          limit: z.number().optional().describe('Max messages to return (1-250, default 20)')
        },
        async (args) => {
          const [attendees, msgData] = await Promise.all([
            getOtherAttendees(args.chat_id),
            client.getMessages(args.chat_id, { limit: args.limit || 20 })
          ])

          const header = 'Chat with ' + Object.values(attendees).map(formatAttendee).join(', ') + ':'
          const lines = [header, '']

          // API returns newest first — reverse for chronological reading
          for (const m of msgData.items.reverse()) {
            const sender = m.is_sender === 1 ? 'You' : (attendees[m.sender_id]?.name || 'Unknown')
            const body = m.text || (m.attachments?.length ? `[${m.attachments.length} attachment(s)]` : '[no text]')
            lines.push(`[${sender}] ${formatMessageTime(m.timestamp)}`)
            lines.push(body)
            lines.push('')
          }

          if (msgData.cursor) lines.push('(older messages available)')
          return text(lines.join('\n'))
        }
      ),

      tool(
        'send_linkedin_message',
        desc('Send a message in a LinkedIn chat. Requires approval.'),
        {
          chat_id: z.string().describe('The chat ID to send the message in'),
          text: z.string().describe('The message text to send')
        },
        async (args) => {
          await client.sendMessage(args.chat_id, { text: args.text, account_id: accountId })
          return text('Message sent.')
        }
      ),

      tool(
        'start_linkedin_chat',
        'Start a new LinkedIn conversation. Requires attendee LinkedIn provider IDs (ACo... prefix). Requires approval.',
        {
          attendee_ids: z.array(z.string()).describe('LinkedIn provider IDs of the recipients'),
          text: z.string().describe('The opening message')
        },
        async (args) => {
          const result = await client.startChat({
            account_id: accountId, attendees_ids: args.attendee_ids, text: args.text
          })
          return text(`Conversation started. Chat ID: ${result.chat_id}`)
        }
      ),

      tool(
        'get_linkedin_attendees',
        'Get profile info for attendees in a LinkedIn chat — name, role, connection degree, LinkedIn URL.',
        {
          chat_id: z.string().describe('The chat ID to get attendees for')
        },
        async (args) => {
          const attendees = await getOtherAttendees(args.chat_id)
          const lines = Object.values(attendees).map(a => {
            const parts = [a.name]
            if (a.occupation) parts.push(a.occupation)
            if (a.degree) parts.push(`${a.degree} degree connection`)
            if (a.profileUrl) parts.push(a.profileUrl)
            return parts.join('\n')
          })
          return text(lines.join('\n\n') || 'No attendees found.')
        }
      ),

      tool(
        'list_received_invitations',
        'List pending LinkedIn connection requests received — who wants to connect, their role, and any note they sent.',
        {
          limit: z.number().optional().describe('Max invitations to return (default 20)')
        },
        async (args) => {
          const data = await client.listReceivedInvites({ account_id: accountId, limit: args.limit || 20 })
          if (!data.items?.length) return text('No pending connection requests.')

          const lines = [`Received connection requests (${data.items.length}):\n`]
          for (let i = 0; i < data.items.length; i++) {
            const inv = formatInvitation(data.items[i], 'received')
            lines.push(`${i + 1}. ${inv.detail}`)
            lines.push(`   invitation_id: ${inv.id} | shared_secret: ${inv.sharedSecret}`)
          }
          if (data.cursor) lines.push('\n(more invitations available)')
          return text(lines.join('\n'))
        }
      ),

      tool(
        'list_sent_invitations',
        'List pending LinkedIn connection requests you sent — who you invited and their role.',
        {
          limit: z.number().optional().describe('Max invitations to return (default 20)')
        },
        async (args) => {
          const data = await client.listSentInvites({ account_id: accountId, limit: args.limit || 20 })
          if (!data.items?.length) return text('No pending sent invitations.')

          const lines = [`Sent connection requests (${data.items.length}):\n`]
          for (let i = 0; i < data.items.length; i++) {
            const inv = formatInvitation(data.items[i], 'sent')
            lines.push(`${i + 1}. ${inv.detail}`)
            lines.push(`   invitation_id: ${inv.id}`)
          }
          if (data.cursor) lines.push('\n(more invitations available)')
          return text(lines.join('\n'))
        }
      ),

      tool(
        'send_connection_request',
        desc("Send a LinkedIn connection request. Requires the person's LinkedIn provider ID (ACo... prefix). Optional note (max 300 chars). Requires approval."),
        {
          provider_id: z.string().describe('LinkedIn provider ID of the person to connect with'),
          message: z.string().max(300).optional().describe('Optional connection note (max 300 characters)')
        },
        async (args) => {
          await client.sendInvite({
            provider_id: args.provider_id,
            account_id: accountId,
            ...(args.message && { message: args.message }),
          })
          return text('Connection request sent.')
        }
      ),

      tool(
        'respond_to_invitation',
        'Accept or decline a received LinkedIn connection request. Use invitation_id and shared_secret from list_received_invitations. Requires approval.',
        {
          invitation_id: z.string().describe('The invitation ID to respond to'),
          action: z.enum(['accept', 'decline']).describe('Whether to accept or decline'),
          shared_secret: z.string().describe('The shared_secret from the invitation (required by LinkedIn)')
        },
        async (args) => {
          await client.respondToInvite(args.invitation_id, {
            provider: 'LINKEDIN',
            shared_secret: args.shared_secret,
            account_id: accountId,
            action: args.action,
          })
          return text(`Invitation ${args.action}ed.`)
        }
      ),
    ]
  })
}

export default createLinkedinMcpServer
