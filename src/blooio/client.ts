// Blooio V2 API Client
// Ref: https://backend.blooio.com/v2/api/openapi.json

const BASE_URL = process.env.BLOOIO_API_BASE_URL || 'https://backend.blooio.com/v2/api';
const API_TOKEN = process.env.BLOOIO_API_KEY;

// Truncate error messages (especially HTML error pages)
function truncateError(text: string, maxLen = 100): string {
  if (text.includes('<!DOCTYPE') || text.includes('<html')) {
    return '[HTML error page - likely Blooio backend issue]';
  }
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

// Chat info cache
const chatInfoCache = new Map<string, ChatInfo>();

export interface ChatParticipant {
  identifier: string;
  name: string | null;
}

export interface ChatInfo {
  id: string;
  display_name: string | null;
  participants: ChatParticipant[];
  is_group: boolean;
  group_id: string | null;
}

export async function getChat(chatId: string): Promise<ChatInfo> {
  // Check cache first
  const cached = chatInfoCache.get(chatId);
  if (cached) {
    return cached;
  }

  if (!API_TOKEN) {
    throw new Error('BLOOIO_API_KEY not configured');
  }

  const encodedChatId = encodeURIComponent(chatId);
  const url = `${BASE_URL}/chats/${encodedChatId}`;

  console.log(`[blooio] Fetching chat info for ${chatId}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[blooio] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Blooio API error: ${response.status} ${truncateError(errorText)}`);
  }

  const data = await response.json() as {
    id: string;
    type: string;
    is_group: boolean;
    group_id: string | null;
    group_name: string | null;
    member_count: number;
    contact: { contact_id: string; name: string | null; identifier: string } | null;
  };

  let participants: ChatParticipant[] = [];
  const displayName = data.group_name || null;

  if (data.is_group && data.group_id) {
    // Fetch group members for participant list
    try {
      const membersUrl = `${BASE_URL}/groups/${data.group_id}/members?limit=200`;
      const membersResponse = await fetch(membersUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${API_TOKEN}`,
        },
      });
      if (membersResponse.ok) {
        const membersData = await membersResponse.json() as {
          members: Array<{ identifier: string; name: string | null }>;
        };
        participants = membersData.members.map(m => ({
          identifier: m.identifier,
          name: m.name,
        }));
      }
    } catch (e) {
      console.error(`[blooio] Failed to fetch group members:`, e);
    }
  } else if (data.contact) {
    participants = [{ identifier: data.contact.identifier, name: data.contact.name }];
  }

  const chatInfo: ChatInfo = {
    id: data.id,
    display_name: displayName,
    participants,
    is_group: data.is_group,
    group_id: data.group_id,
  };

  // Cache it
  chatInfoCache.set(chatId, chatInfo);
  console.log(`[blooio] Chat info cached: ${participants.length} participants, is_group=${data.is_group}`);

  return chatInfo;
}

export interface SendMessageResponse {
  message_id?: string;
  message_ids?: string[];
  status: string;
}

export interface MediaAttachment {
  url: string;
  name?: string;
}

export async function sendMessage(chatId: string, text: string, media?: MediaAttachment[]): Promise<SendMessageResponse> {
  if (!API_TOKEN) {
    throw new Error('BLOOIO_API_KEY not configured');
  }

  const encodedChatId = encodeURIComponent(chatId);
  const url = `${BASE_URL}/chats/${encodedChatId}/messages`;

  const extras: string[] = [];
  if (media?.length) extras.push(`${media.length} attachment(s)`);
  console.log(`[blooio] Sending message to chat ${chatId}${extras.length ? ` with ${extras.join(', ')}` : ''}`);

  const body: Record<string, unknown> = {};

  if (text) {
    body.text = text;
  }

  if (media && media.length > 0) {
    body.attachments = media.map(m => m.name ? { url: m.url, name: m.name } : m.url);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[blooio] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Blooio API error: ${response.status} ${truncateError(errorText)}`);
  }

  const data = await response.json() as SendMessageResponse;
  console.log(`[blooio] Message sent: ${data.message_id || data.message_ids?.join(', ')}`);

  return data;
}

export async function renameGroupChat(groupId: string, name: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('BLOOIO_API_KEY not configured');
  }

  const url = `${BASE_URL}/groups/${groupId}`;

  console.log(`[blooio] Renaming group ${groupId} to "${name}"`);

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[blooio] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Blooio API error: ${response.status} ${truncateError(errorText)}`);
  }

  console.log(`[blooio] Group renamed to "${name}"`);
}

export async function setGroupChatIcon(groupId: string, iconUrl: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('BLOOIO_API_KEY not configured');
  }

  console.log(`[blooio] Setting group ${groupId} icon from ${iconUrl.substring(0, 50)}...`);

  // Download the image first
  const imageResponse = await fetch(iconUrl);
  if (!imageResponse.ok) {
    throw new Error(`Failed to download icon image: ${imageResponse.status}`);
  }

  const imageBlob = await imageResponse.blob();

  // Upload as multipart form data
  const formData = new FormData();
  formData.append('icon', imageBlob, 'icon.png');

  const url = `${BASE_URL}/groups/${groupId}/icon`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[blooio] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Blooio API error: ${response.status} ${truncateError(errorText)}`);
  }

  console.log(`[blooio] Group icon updated`);
}

export async function markAsRead(chatId: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('BLOOIO_API_KEY not configured');
  }

  const encodedChatId = encodeURIComponent(chatId);
  const url = `${BASE_URL}/chats/${encodedChatId}/read`;

  console.log(`[blooio] Marking chat ${chatId} as read`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[blooio] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Blooio API error: ${response.status} ${truncateError(errorText)}`);
  }

  console.log(`[blooio] Chat marked as read`);
}

export async function startTyping(chatId: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('BLOOIO_API_KEY not configured');
  }

  const encodedChatId = encodeURIComponent(chatId);
  const url = `${BASE_URL}/chats/${encodedChatId}/typing`;

  console.log(`[blooio] Starting typing indicator for chat ${chatId}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[blooio] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Blooio API error: ${response.status} ${truncateError(errorText)}`);
  }

  console.log(`[blooio] Typing indicator started`);
}

export async function stopTyping(chatId: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('BLOOIO_API_KEY not configured');
  }

  const encodedChatId = encodeURIComponent(chatId);
  const url = `${BASE_URL}/chats/${encodedChatId}/typing`;

  console.log(`[blooio] Stopping typing indicator for chat ${chatId}`);

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[blooio] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Blooio API error: ${response.status} ${truncateError(errorText)}`);
  }

  console.log(`[blooio] Typing indicator stopped`);
}

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';

export interface SendReactionResponse {
  success: boolean;
  message_id: string;
  reaction: string;
  action: 'add' | 'remove';
}

export async function sendReaction(
  chatId: string,
  messageId: string,
  reaction: StandardReactionType,
  action: 'add' | 'remove' = 'add'
): Promise<SendReactionResponse> {
  if (!API_TOKEN) {
    throw new Error('BLOOIO_API_KEY not configured');
  }

  const encodedChatId = encodeURIComponent(chatId);
  const url = `${BASE_URL}/chats/${encodedChatId}/messages/${messageId}/reactions`;

  const prefix = action === 'add' ? '+' : '-';
  console.log(`[blooio] Sending ${prefix}${reaction} reaction to message ${messageId} in chat ${chatId}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reaction: `${prefix}${reaction}` }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[blooio] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Blooio API error: ${response.status} ${truncateError(errorText)}`);
  }

  const data = await response.json() as SendReactionResponse;
  console.log(`[blooio] Reaction sent: ${prefix}${reaction}`);

  return data;
}
