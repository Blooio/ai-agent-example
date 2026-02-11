import 'dotenv/config';
import express from 'express';
import { createWebhookHandler } from './webhook/handler.js';
import { sendMessage, markAsRead, startTyping, sendReaction, getChat, renameGroupChat, setGroupChatIcon } from './blooio/client.js';
import { chat, getGroupChatAction, generateImage } from './claude/client.js';
import { getUserProfile, addMessage } from './state/conversation.js';

// Clean up LLM response formatting quirks before sending
function cleanResponse(text: string): string {
  return text
    // Turn newline-dash into inline dash (e.g., "foo\n - bar" → "foo - bar")
    .replace(/\n\s*-\s*/g, ' - ')
    // Remove markdown underlines/italics (_text_ → text)
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    // Remove markdown bold (**text** → text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // Remove stray asterisks used for emphasis
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    // Clean up multiple spaces
    .replace(/  +/g, ' ')
    // Clean up extra newlines (but preserve intentional double-newlines for --- splits)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Webhook endpoint for Blooio
app.post(
  '/webhook',
  createWebhookHandler(async (chatId, from, text, messageId, images, audio, service) => {
    const start = Date.now();
    console.log(`[main] Processing message from ${from}`);

    // Mark as read, start typing, get chat info, and fetch user profile in parallel
    const [, , chatInfo, senderProfile] = await Promise.all([
      markAsRead(chatId).catch(e => console.error('[main] markAsRead failed:', e)),
      startTyping(chatId).catch(e => console.error('[main] startTyping failed:', e)),
      getChat(chatId),
      getUserProfile(from),
    ]);
    console.log(`[timing] markAsRead+startTyping+getChat+getProfile: ${Date.now() - start}ms`);
    if (senderProfile?.name) {
      console.log(`[main] Known user: ${senderProfile.name} (${senderProfile.facts.length} facts)`);
    }

    // Determine if this is a group chat
    const isGroupChat = chatInfo.is_group;
    const participantNames = chatInfo.participants.map(p => p.identifier);

    // In group chats, check if Claude should respond, react, or ignore
    // Always respond to voice memos/images - someone sending media is clearly trying to communicate
    if (isGroupChat && audio.length === 0 && images.length === 0) {
      const { action, reaction: quickReaction } = await getGroupChatAction(text, from, chatId);

      if (action === 'ignore') {
        console.log(`[main] Ignoring group chat message`);
        return;
      }

      if (action === 'react') {
        // Just send a reaction, no full response needed
        if (quickReaction) {
          await sendReaction(chatId, messageId, quickReaction.type);
          console.log(`[timing] quick reaction: ${Date.now() - start}ms`);

          // Save to conversation history so Claude knows what happened (include sender for group chats)
          await addMessage(chatId, 'user', text, from);
          await addMessage(chatId, 'assistant', `[reacted with ${quickReaction.type}]`);

          console.log(`[main] Reacted to ${from} with ${quickReaction.type}`);
        }
        return;
      }

      console.log(`[main] Claude should respond to this group message`);
    } else if (isGroupChat) {
      console.log(`[main] Responding to group media (skipping classifier)`);
    }

    // Get Claude's response (typing indicator shows while this runs)
    const { text: responseText, reaction, renameChat, rememberedUser, generatedImage, groupChatIcon } = await chat(chatId, text, images, audio, {
      isGroupChat,
      participantNames,
      chatName: chatInfo.display_name,
      senderHandle: from,
      senderProfile,
      service,
    });
    console.log(`[timing] claude: ${Date.now() - start}ms`);
    console.log(`[debug] responseText: ${responseText ? `"${responseText.substring(0, 50)}..."` : 'null'}, renameChat: ${renameChat || 'null'}, generatedImage: ${generatedImage ? 'yes' : 'null'}`);

    // Send reaction if Claude wants to
    if (reaction) {
      await sendReaction(chatId, messageId, reaction.type);
      console.log(`[timing] reaction: ${Date.now() - start}ms`);
    }

    // Rename group chat if Claude wants to (need group_id for Blooio API)
    if (renameChat && isGroupChat && chatInfo.group_id) {
      await renameGroupChat(chatInfo.group_id, renameChat);
      console.log(`[timing] renameChat: ${Date.now() - start}ms`);
    }

    // Send text response if there is one
    let finalText = responseText;

    // If Claude renamed chat but didn't send text, add a simple acknowledgment (group chats only)
    if (!finalText && renameChat && isGroupChat) {
      console.log(`[main] Claude renamed chat without text, adding acknowledgment`);
      finalText = `renamed the chat to "${renameChat}" 😎`;
    }

    // If Claude used remember_user without text, just log it - no automatic acknowledgments
    if (!finalText && rememberedUser) {
      console.log(`[main] Claude saved user info without text response (no auto-ack)`);
    }

    if (finalText || generatedImage || groupChatIcon) {
      // Split into multiple messages first, then clean each one
      // (must split before cleaning, or the --- delimiter gets mangled)
      const messages = finalText ? finalText.split('---').map(m => cleanResponse(m)).filter(m => m.length > 0) : [];

      // Send text messages first (before generating image)
      if (messages.length > 0) {
        for (let i = 0; i < messages.length; i++) {
          const isLastMessage = i === messages.length - 1;

          await sendMessage(chatId, messages[i]);

          // Add a natural delay between messages (except after the last one)
          if (!isLastMessage) {
            const delay = 400 + Math.random() * 400; // 400-800ms feels natural
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
        console.log(`[timing] sendMessage (${messages.length} text msg${messages.length !== 1 ? 's' : ''}): ${Date.now() - start}ms`);
      }

      // Now generate and send image if requested
      if (generatedImage) {
        // Show typing indicator while generating (takes ~15 seconds)
        await startTyping(chatId);
        console.log(`[main] Generating image after sending text...`);
        const imageUrl = await generateImage(generatedImage.prompt);
        if (imageUrl) {
          // Small delay before sending image
          await new Promise(resolve => setTimeout(resolve, 300));
          await sendMessage(chatId, '', [{ url: imageUrl }]);
          // Save to conversation history
          await addMessage(chatId, 'assistant', `[generated an image: ${generatedImage.prompt.substring(0, 50)}...]`);
          console.log(`[timing] generateImage + sendImage: ${Date.now() - start}ms`);
        } else {
          // Image generation failed - let user know
          await sendMessage(chatId, 'sorry the image didnt work, try again?');
          console.log(`[main] Image generation failed`);
        }
      }

      // Generate and set group chat icon if requested
      if (groupChatIcon && isGroupChat && chatInfo.group_id) {
        // Show typing indicator while generating (takes ~15 seconds)
        await startTyping(chatId);
        console.log(`[main] Generating group chat icon...`);
        const imageUrl = await generateImage(groupChatIcon.prompt);
        if (imageUrl) {
          await setGroupChatIcon(chatInfo.group_id, imageUrl);
          // Save to conversation history
          await addMessage(chatId, 'assistant', `[set group chat icon]`);
          console.log(`[timing] generateIcon + setIcon: ${Date.now() - start}ms`);
        } else {
          // Image generation failed - let user know
          await sendMessage(chatId, 'sorry couldnt set the icon, try again?');
          console.log(`[main] Group icon generation failed`);
        }
      }

      const extras = [generatedImage && 'image', groupChatIcon && 'icon'].filter(Boolean).join(', ');
      console.log(`[timing] total: ${Date.now() - start}ms (${extras || 'text only'})`);
    } else if (reaction) {
      // Reaction-only response - already saved to conversation history by chat()
      console.log(`[main] Reaction-only response (saved to history for context)`);
    }

    console.log(`[main] Reply sent to ${from}`);
  })
);

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║         Blooio <-> Claude Bridge                      ║
╠═══════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}              ║
║                                                       ║
║  Endpoints:                                           ║
║    POST /webhook  - Blooio webhook receiver           ║
║    GET  /health   - Health check                      ║
║                                                       ║
║  Next steps:                                          ║
║    1. Run: ngrok http ${PORT}                            ║
║    2. Create a Blooio webhook pointing to your URL    ║
║    3. Text your Blooio number!                        ║
╚═══════════════════════════════════════════════════════╝
  `);
});
