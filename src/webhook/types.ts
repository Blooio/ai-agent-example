// Blooio V2 Webhook Types
// Ref: https://backend.blooio.com/v2/api/openapi.json

export interface WebhookEvent {
  event: string;
  message_id: string;
  external_id: string;
  status: string;
  protocol: string | null;
  timestamp: number;
  internal_id: string | null;
  text: string | null;
  attachments: Array<{ url: string; name?: string | null }> | null;
  is_group: boolean;
  group_id: string | null;
  group_name: string | null;
  participants: Array<{ contact_id: string; identifier: string; name: string | null }> | null;
  sender: string | null;
  sent_at?: number | null;
  delivered_at?: number | null;
  read_at?: number | null;
  error_code?: string | null;
  error_message?: string | null;
}

export function isMessageReceivedEvent(event: WebhookEvent): boolean {
  return event.event === 'message.received';
}

export interface ExtractedMedia {
  url: string;
  mimeType: string;
}

// Infer MIME type from URL or filename
function inferMimeType(url: string, name?: string | null): string {
  const source = (name || url).toLowerCase();

  // Images
  if (source.includes('.jpg') || source.includes('.jpeg')) return 'image/jpeg';
  if (source.includes('.png')) return 'image/png';
  if (source.includes('.gif')) return 'image/gif';
  if (source.includes('.webp')) return 'image/webp';
  if (source.includes('.heic')) return 'image/heic';
  if (source.includes('.heif')) return 'image/heif';
  if (source.includes('.bmp')) return 'image/bmp';
  if (source.includes('.tiff')) return 'image/tiff';

  // Audio
  if (source.includes('.m4a')) return 'audio/mp4';
  if (source.includes('.mp3')) return 'audio/mpeg';
  if (source.includes('.wav')) return 'audio/wav';
  if (source.includes('.aac')) return 'audio/aac';
  if (source.includes('.ogg')) return 'audio/ogg';
  if (source.includes('.caf')) return 'audio/x-caf';
  if (source.includes('.amr')) return 'audio/amr';

  return 'application/octet-stream';
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tiff'];
const AUDIO_EXTENSIONS = ['.m4a', '.mp3', '.wav', '.aac', '.ogg', '.caf', '.amr'];

function matchesExtensions(url: string, name: string | null | undefined, extensions: string[]): boolean {
  const urlLower = url.toLowerCase();
  const nameLower = (name || '').toLowerCase();
  return extensions.some(ext => urlLower.includes(ext) || nameLower.endsWith(ext));
}

export function extractImageAttachments(attachments: Array<{ url: string; name?: string | null }> | null): ExtractedMedia[] {
  if (!attachments) return [];

  return attachments
    .filter(a => a.url && matchesExtensions(a.url, a.name, IMAGE_EXTENSIONS))
    .map(a => ({
      url: a.url,
      mimeType: inferMimeType(a.url, a.name),
    }));
}

export function extractAudioAttachments(attachments: Array<{ url: string; name?: string | null }> | null): ExtractedMedia[] {
  if (!attachments) return [];

  return attachments
    .filter(a => a.url && matchesExtensions(a.url, a.name, AUDIO_EXTENSIONS))
    .map(a => ({
      url: a.url,
      mimeType: inferMimeType(a.url, a.name),
    }));
}
