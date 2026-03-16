import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import path from 'path'
import os from 'os'
import BaseAdapter from './base.js'

const AUTH_DIR = path.join(os.homedir(), '.clawd', 'auth', 'whatsapp')

/**
 * WhatsApp adapter using Baileys
 * Supports text and image messages
 */
export default class WhatsAppAdapter extends BaseAdapter {
  constructor(config) {
    super(config)
    this.sock = null
    this.myJid = null
    this.jidMap = new Map()
    this.groupNameCache = new Map()
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion()

    const logger = pino({ level: 'silent' })

    this.sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false
    })

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        console.log('\n[WhatsApp] Scan QR code to connect:')
        qrcode.generate(qr, { small: true })
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut

        console.log(`[WhatsApp] Connection closed. Status: ${statusCode}`)

        if (shouldReconnect) {
          console.log('[WhatsApp] Reconnecting...')
          this.start()
        } else {
          console.log('[WhatsApp] Logged out. Please delete auth folder and restart.')
        }
      }

      if (connection === 'open') {
        this.myJid = this.sock.user?.id
        this.myLid = this.sock.user?.lid
        console.log(`[WhatsApp] Connected as ${this.myJid} (lid: ${this.myLid || 'none'})`)
      }
    })

    this.sock.ev.on('creds.update', saveCreds)

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return

      for (const msg of messages) {
        await this.handleMessage(msg)
      }
    })

    console.log('[WhatsApp] Adapter starting...')
  }

  async stop() {
    if (this.sock) {
      this.sock.end()
      this.sock = null
    }
    console.log('[WhatsApp] Adapter stopped')
  }

  async sendMessage(chatId, text) {
    if (!this.sock) {
      throw new Error('WhatsApp not connected')
    }

    const targetJid = this.jidMap?.get(chatId) || chatId
    await this.sock.sendMessage(targetJid, { text })
  }

  async sendTyping(chatId) {
    if (!this.sock) return
    try {
      await this.sock.sendPresenceUpdate('composing', chatId)
    } catch (err) {
      // Ignore
    }
  }

  async stopTyping(chatId) {
    if (!this.sock) return
    try {
      await this.sock.sendPresenceUpdate('paused', chatId)
    } catch (err) {
      // Ignore
    }
  }

  async react(chatId, messageId, emoji) {
    if (!this.sock) return
    try {
      await this.sock.sendMessage(chatId, {
        react: { text: emoji, key: { remoteJid: chatId, id: messageId } }
      })
    } catch (err) {
      // Ignore
    }
  }

  /**
   * Download image from message
   */
  async downloadImage(msg) {
    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger: pino({ level: 'silent' }),
          reuploadRequest: this.sock.updateMediaMessage
        }
      )
      return buffer
    } catch (err) {
      console.error('[WhatsApp] Failed to download image:', err.message)
      return null
    }
  }

  async handleMessage(msg) {
    if (msg.key.fromMe) return

    const jid = msg.key.remoteJid
    const isGroup = jid?.endsWith('@g.us')
    const sender = isGroup ? msg.key.participant : jid

    // Extract text
    let text = msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      ''

    // Check for image
    let image = null
    if (msg.message?.imageMessage) {
      console.log('[WhatsApp] Downloading image...')
      const buffer = await this.downloadImage(msg)
      if (buffer) {
        image = {
          data: buffer.toString('base64'),
          mediaType: 'image/jpeg'
        }
        console.log('[WhatsApp] Image downloaded, size:', buffer.length)
      }
      // If no caption, set placeholder text
      if (!text) {
        text = '[Image]'
      }
    }

    if (!text && !image) return

    // Extract mentions — contextInfo lives on the specific message type, not just extendedTextMessage
    const contextInfo =
      msg.message?.extendedTextMessage?.contextInfo ||
      msg.message?.imageMessage?.contextInfo ||
      msg.message?.videoMessage?.contextInfo ||
      msg.message?.documentMessage?.contextInfo ||
      {}
    const mentions = contextInfo.mentionedJid || []
    const isMentioned = mentions.some(m => {
      const mId = m.split('@')[0].split(':')[0]
      if (this.myJid) {
        const jidId = this.myJid.split('@')[0].split(':')[0]
        if (mId === jidId) return true
      }
      if (this.myLid) {
        const lidId = this.myLid.split('@')[0].split(':')[0]
        if (mId === lidId) return true
      }
      return false
    })

    // Get group name (cached)
    let groupName = null
    if (isGroup) {
      groupName = this.groupNameCache.get(jid)
      if (!groupName && this.sock) {
        try {
          const meta = await this.sock.groupMetadata(jid)
          groupName = meta?.subject || null
          if (groupName) this.groupNameCache.set(jid, groupName)
        } catch {}
      }
    }

    const message = {
      chatId: jid,
      text,
      isGroup,
      sender,
      senderName: msg.pushName || null,
      groupName,
      mentions: isMentioned ? ['self'] : mentions,
      image,
      raw: msg
    }

    if (!this.shouldRespond(message, this.config)) {
      return
    }

    this.emitMessage(message)
  }
}
