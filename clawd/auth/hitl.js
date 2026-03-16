// GMAIL_SEND_EMAIL → "Send Email"
function slugToTitle(slug) {
  return slug
    .replace(/^[A-Z]+_/, '')       // strip prefix (GMAIL_, TWITTER_, etc.)
    .split('_')
    .map(w => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ')
}

// Generic param renderer — key-value markdown
function buildRequestText(actionSlugs, toolParams) {
  const header = `**Actions:** ${actionSlugs.join(', ')}`
  if (!toolParams) return header

  // For MULTI_EXECUTE_TOOL, params.tools[] has the actual tool args
  const tools = toolParams?.tools || []
  const sections = tools
    .filter(t => actionSlugs.includes(t.tool_slug))
    .map(t => {
      const args = t.arguments || t.params || {}
      const lines = Object.entries(args)
        .map(([k, v]) => `**${k}:** ${String(v).substring(0, 500)}`)
        .join('\n')
      return lines || '(no params)'
    })

  return sections.length ? sections.join('\n\n---\n\n') : header
}

/**
 * HITL (Human-in-the-Loop) approval client for Handoff Server.
 * Creates boolean approval requests and waits for response via SSE.
 */
export class HITLApproval {
  constructor(config) {
    this.baseUrl = config.baseUrl
    this.apiKey = config.apiKey
    this.loopId = config.loopId
    this.timeoutSeconds = config.timeoutSeconds || 120
  }

  /**
   * Request human approval for sensitive actions.
   * Creates a request on the Handoff server and waits for SSE response.
   * @param {string[]} actionSlugs - Composio tool slugs requiring approval
   * @param {object} [context] - Optional context (platform, sessionKey, chatId, toolParams)
   * @returns {{ approved: boolean, reason?: string }}
   */
  async requestApproval(actionSlugs, context = {}) {
    const { platform, sessionKey, chatId, toolParams } = context

    const title = toolParams?.thought
      ? toolParams.thought.substring(0, 200)
      : actionSlugs.map(s => slugToTitle(s)).join(', ')
    const requestText = buildRequestText(actionSlugs, toolParams)

    let res
    try {
      res = await fetch(`${this.baseUrl}/api/v1/loops/${this.loopId}/requests`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title,
          request_text: requestText,
          type: 'markdown',
          response_type: 'boolean',
          processing_type: 'time-sensitive',
          timeout_seconds: this.timeoutSeconds,
          priority: 'high',
          platform: platform || '',
          context: { sessionKey, chatId },
          response_config: {
            true_label: 'Approve',
            false_label: 'Deny',
          },
        }),
      })
    } catch (err) {
      console.error('[HITL] Failed to reach Handoff server:', err.message)
      return { approved: false, reason: `Handoff unreachable: ${err.message}` }
    }

    const body = await res.json()
    if (body.error) {
      console.error('[HITL] Failed to create request:', body.msg)
      return { approved: false, reason: body.msg }
    }

    const requestId = body.data.request_id
    console.log(`[HITL] Request created: ${requestId}`)

    return this.waitForResponse(requestId)
  }

  /**
   * Wait for human response via SSE stream.
   * The Handoff SSE endpoint sends a single event when the request is resolved
   * (completed, cancelled, or timeout), then closes the connection.
   */
  async waitForResponse(requestId) {
    return new Promise((resolve) => {
      const url = `${this.baseUrl}/api/v1/requests/${requestId}/events`
      // Client-side timeout slightly longer than server-side to avoid race
      const timeoutMs = (this.timeoutSeconds + 10) * 1000

      fetch(url, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      }).then(async (res) => {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          // Parse SSE events from buffer
          const lines = buffer.split('\n')
          buffer = lines.pop() // keep incomplete line

          let eventType = ''
          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim()
            if (line.startsWith('data: ') && eventType) {
              try {
                const data = JSON.parse(line.slice(6))
                if (eventType === 'completed') {
                  const approved = data.request?.response_data?.boolean === true
                  const label = data.request?.response_data?.boolean_label
                  console.log(`[HITL] Response: ${label || (approved ? 'Approved' : 'Denied')}`)
                  resolve({ approved, reason: approved ? undefined : 'User denied' })
                } else {
                  // cancelled or timeout
                  console.log(`[HITL] Request ${eventType}`)
                  resolve({ approved: false, reason: eventType })
                }
              } catch (parseErr) {
                console.error('[HITL] Failed to parse SSE data:', parseErr.message)
                resolve({ approved: false, reason: 'Invalid SSE data' })
              }
              return
            }
          }
        }

        // Stream ended without an event
        resolve({ approved: false, reason: 'SSE stream ended unexpectedly' })
      }).catch((err) => {
        console.error('[HITL] SSE error:', err.message)
        resolve({ approved: false, reason: err.message })
      })
    })
  }
}
