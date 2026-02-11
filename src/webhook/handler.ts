import { Request, Response } from 'express';
import {
  WebhookEvent,
  isMessageReceivedEvent,
  extractImageAttachments,
  extractAudioAttachments,
  ExtractedMedia,
} from './types.js';

export type MessageService = 'iMessage' | 'SMS' | 'RCS';

export interface MessageHandler {
  (chatId: string, from: string, text: string, messageId: string, images: ExtractedMedia[], audio: ExtractedMedia[], service?: MessageService): Promise<void>;
}

function mapProtocolToService(protocol: string | null): MessageService | undefined {
  if (!protocol) return undefined;
  switch (protocol.toLowerCase()) {
    case 'imessage': return 'iMessage';
    case 'sms': return 'SMS';
    case 'rcs': return 'RCS';
    case 'non-imessage': return 'SMS';
    default: return undefined;
  }
}

export function createWebhookHandler(onMessage: MessageHandler) {
  // Sender numbers to ignore (comma-separated)
  const ignoredSenders = process.env.IGNORED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];
  // If set, ONLY respond to these sender numbers (for local dev)
  const allowedSenders = process.env.ALLOWED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];

  return async (req: Request, res: Response) => {
    const event = req.body as WebhookEvent;

    const pstTime = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
    console.log(`[webhook] ${pstTime} PST | ${event.event} (${event.message_id})`);

    // Acknowledge receipt immediately
    res.status(200).json({ received: true });

    // Only process message.received events
    if (!isMessageReceivedEvent(event)) {
      return;
    }

    // Debug: log full webhook payload (only in development)
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[webhook] Full payload:`, JSON.stringify(event, null, 2));
    }

    const sender = event.sender;
    if (!sender) {
      console.log(`[webhook] Skipping message with no sender`);
      return;
    }

    // If ALLOWED_SENDERS is set, only respond to those numbers
    if (allowedSenders.length > 0 && !allowedSenders.includes(sender)) {
      console.log(`[webhook] Skipping ${sender} (not in allowed senders)`);
      return;
    }

    // Skip messages from ignored senders
    if (ignoredSenders.includes(sender)) {
      console.log(`[webhook] Skipping ${sender} (ignored sender)`);
      return;
    }

    const text = event.text || '';
    const images = extractImageAttachments(event.attachments);
    const audio = extractAudioAttachments(event.attachments);

    if (!text.trim() && images.length === 0 && audio.length === 0) {
      console.log(`[webhook] Skipping empty message`);
      return;
    }

    const service = mapProtocolToService(event.protocol);

    // Determine chatId: for group chats use group_id, for 1:1 use external_id
    const chatId = event.is_group && event.group_id ? event.group_id : event.external_id;

    const mediaInfo = [
      images.length > 0 ? `${images.length} image(s)` : '',
      audio.length > 0 ? `${audio.length} audio` : '',
    ].filter(Boolean).join(', ');
    console.log(`[webhook] Message from ${sender} in ${chatId}: "${text.substring(0, 50)}..."${mediaInfo ? ` [${mediaInfo}]` : ''}`);

    try {
      await onMessage(chatId, sender, text, event.message_id, images, audio, service);
    } catch (error) {
      console.error(`[webhook] Error handling message:`, error);
    }
  };
}
