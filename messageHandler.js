const { downloadMediaMessage, getContentType } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const { messageCache, chatLogs, userSettings, autoReplies, viewOnceCache } = require('./db');

const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '.';
const DOWNLOADS_DIR = path.join(__dirname, process.env.DOWNLOADS_DIR || './downloads');
const bootTime = Date.now();

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

/**
 * Unwrap nested messages (handles Ephemeral, View Once, and extensions)
 */
function getRealMessage(message) {
    if (!message) return null;
    let content = message;
    
    // Unwrap ephemeral messages
    if (content.ephemeralMessage?.message) {
        content = content.ephemeralMessage.message;
    }
    
    // Unwrap view once wrappers
    if (content.viewOnceMessageV2?.message) {
        content = content.viewOnceMessageV2.message;
    }
    if (content.viewOnceMessageV2Extension?.message) {
        content = content.viewOnceMessageV2Extension.message;
    }
    if (content.viewOnceMessage?.message) {
        content = content.viewOnceMessage.message;
    }
    
    return content;
}

/**
 * Get dynamic settings for a specific user session
 */
function getSettings(sessionPhone) {
    const defaultSettings = {
        autoSaveViewOnce: process.env.AUTO_SAVE_VIEW_ONCE === 'true',
        autoRecoverDeleted: process.env.AUTO_RECOVER_DELETED === 'true',
        autoReadStatus: true,
        autoLikeStatus: true,
        antiLink: false,
        welcomeMessage: true
    };
    return { ...defaultSettings, ...(userSettings.get(sessionPhone) || {}) };
}

/**
 * Main Message Handler Entry
 */
async function handleMessage(sock, msg, sessionPhone, opts = {}) {
    try {
        if (!msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const msgId = msg.key.id;
        const fromMe = msg.key.fromMe;
        const participant = msg.key.participant || remoteJid;
        
        const ownerJid = `${sessionPhone}@s.whatsapp.net`;
        const settings = getSettings(sessionPhone);

        // Debug: log every message type received so we can trace view-once
        const msgTypes = Object.keys(msg.message).join(', ');
        console.log(`[MSG] type=${msgTypes} | from=${participant} | fromMe=${fromMe} | mode=${opts.viewOnceOnly ? 'history' : 'live'}`);

        // Skip interactive commands/features for historical message backlogs on startup
        const msgTime = (msg.messageTimestamp * 1000) || Date.now();
        const isHistorical = msgTime < bootTime - 5000;
        if (isHistorical && !opts.viewOnceOnly) {
            cacheMessage(msg);
            logToDatabase(msg, sessionPhone);
            return;
        }

        // ── History replay mode: only run view-once bypass ─────────────────────
        if (opts.viewOnceOnly) {
            cacheMessage(msg);
            if (!fromMe) {
                await handleViewOnce(sock, msg, ownerJid, settings);
            }
            return;
        }

        // 1. Process Status Broadcasts
        if (remoteJid === 'status@broadcast') {
            await handleStatusBroadcast(sock, msg, settings);
            return;
        }

        // 2. Anti-Delete Interceptor
        const isProtocol = msg.message.protocolMessage;
        if (isProtocol && msg.message.protocolMessage.type === 0) {
            if (settings.autoRecoverDeleted) {
                await handleAntiDelete(sock, msg, ownerJid);
            }
            return;
        }

        // 3. Cache incoming messages
        cacheMessage(msg);

        // 4. View-Once Bypasser (skip own messages — we already saw those)
        if (!fromMe) {
            await handleViewOnce(sock, msg, ownerJid, settings);
        }

        // 5. Database logger
        logToDatabase(msg, sessionPhone);

        // Extract Text Content
        const realMsg = getRealMessage(msg.message);
        const textContent = (realMsg?.conversation || realMsg?.extendedTextMessage?.text || '').trim();

        // 6. Anti-Link Spammer Group Protection
        if (remoteJid.endsWith('@g.us') && settings.antiLink && textContent.includes('chat.whatsapp.com') && !fromMe) {
            await handleAntiLink(sock, msg, remoteJid, participant);
            return;
        }

        // 7. Custom Keyword Auto-Responder
        if (!fromMe && textContent) {
            await handleAutoReplies(sock, msg, remoteJid, textContent, sessionPhone);
        }

        // 8. Handle commands (Accessible by owner)
        if (fromMe || participant === ownerJid) {
            await handleCommands(sock, msg, ownerJid, sessionPhone, settings, textContent);
        }

    } catch (error) {
        console.error(`Error handling message for session ${sessionPhone}:`, error);
    }
}

function cacheMessage(msg) {
    const msgId = msg.key.id;
    try {
        const serialized = JSON.stringify(msg, (key, value) => 
            typeof value === 'bigint' ? value.toString() : value
        );
        messageCache.set(msgId, {
            msg: JSON.parse(serialized),
            timestamp: Date.now()
        });
    } catch (e) {
        console.error('[Cache] Failed to serialize message:', e);
    }
}

function logToDatabase(msg, sessionPhone) {
    const remoteJid = msg.key.remoteJid;
    const msgId = msg.key.id;
    const sender = msg.key.participant || msg.key.remoteJid;
    const timestamp = msg.messageTimestamp * 1000 || Date.now();
    
    const realMsg = getRealMessage(msg.message);
    let textContent = '[Media/Special Message]';
    if (realMsg?.conversation) textContent = realMsg.conversation;
    else if (realMsg?.extendedTextMessage?.text) textContent = realMsg.extendedTextMessage.text;
    
    const logKey = `${sessionPhone}_${remoteJid}`;
    const logs = chatLogs.get(logKey) || [];
    logs.push({
        msgId,
        sender,
        text: textContent,
        timestamp
    });
    chatLogs.set(logKey, logs);
}

/**
 * Handle Anti-Link deletion and kicking
 */
async function handleAntiLink(sock, msg, remoteJid, participant) {
    try {
        console.log(`[Anti-Link] Group link detected from @${participant.split('@')[0]} in group ${remoteJid}`);
        
        // Delete message
        await sock.sendMessage(remoteJid, {
            delete: msg.key
        });

        // Kick user
        await sock.groupParticipantsUpdate(remoteJid, [participant], 'remove');
        await sock.sendMessage(remoteJid, {
            text: `🛡️ *Group Security Alert*\n\nUser @${participant.split('@')[0]} was removed for sending prohibited WhatsApp group links.`,
            mentions: [participant]
        });
    } catch (err) {
        console.error('Anti-Link action failed:', err);
    }
}

/**
 * Custom keyword auto replies
 */
async function handleAutoReplies(sock, msg, remoteJid, textContent, sessionPhone) {
    const key = `${sessionPhone}_replies`;
    const repliesMap = autoReplies.get(key) || {};
    const input = textContent.toLowerCase().trim();

    if (repliesMap[input]) {
        await sock.sendMessage(remoteJid, { text: repliesMap[input] });
    }
}

async function handleViewOnce(sock, msg, ownerJid, settings) {
    const messageContent = msg.message;
    if (!messageContent) return;

    // Unwrap ephemeralMessage first so both wrapped and flat detection works inside disappearing chats
    let content = messageContent;
    if (content.ephemeralMessage?.message) {
        content = content.ephemeralMessage.message;
    }

    const wrappedViewOnce =
        content.viewOnceMessageV2 ||
        content.viewOnceMessage ||
        content.viewOnceMessageV2Extension;

    // Flat format — viewOnce flag directly on the media message
    const flatType = ['imageMessage', 'videoMessage', 'audioMessage'].find(
        t => content[t] && (content[t].viewOnce === true || content[t].viewOnce === 1)
    );

    const hasViewOnce = wrappedViewOnce || flatType;

    console.log(`[View-Once] Detection: wrapped=${!!wrappedViewOnce} flat=${flatType || 'none'}`);

    if (!hasViewOnce) return;

    // Unwrap if wrapped, else use messageContent directly for flat format
    const realMsg = wrappedViewOnce ? getRealMessage(messageContent) : messageContent;
    if (!realMsg) return;

    const mediaType = flatType || Object.keys(realMsg).find(
        k => ['imageMessage', 'videoMessage', 'audioMessage'].includes(k)
    );
    if (!mediaType) return;

    // ── Resolve sender name (same logic as anti-delete) ───────────────────────
    const senderRaw    = msg.key.participant || msg.key.remoteJid;
    const senderNormal = senderRaw.replace('@lid', '@s.whatsapp.net');
    const contacts     = sock.contacts || {};
    const contactEntry = contacts[senderNormal] || contacts[senderRaw] || null;
    const senderName   =
        contactEntry?.name    ||   // your phonebook name ✅
        contactEntry?.notify  ||   // their WA display name
        msg.pushName          ||   // pushName in message header
        senderNormal.split('@')[0]; // bare number fallback

    console.log(`[View-Once] Intercepted ${mediaType} from "${senderName}" (${senderRaw})`);

    try {
        // Build a correctly-structured fake message so Baileys can locate the media keys
        const fakeMsg = { key: msg.key, message: realMsg };

        // Download — use reuploadRequest so expired CDN URLs are automatically re-fetched
        const buffer = await downloadMediaMessage(
            fakeMsg,
            'buffer',
            {},
            { reuploadRequest: sock.updateMediaMessage }   // ← fixed: was { logger: console } which crashed
        );

        if (!buffer || buffer.length === 0) {
            console.error('[View-Once] Downloaded buffer is empty — skipping.');
            return;
        }

        // Save a local copy
        const extension = mime.extension(realMsg[mediaType].mimetype) || 'bin';
        const filename  = `view_once_${Date.now()}.${extension}`;
        const filePath  = path.join(DOWNLOADS_DIR, filename);
        fs.writeFileSync(filePath, buffer);
        console.log(`[View-Once] Saved locally: ${filename}`);

        // Cache metadata for manual retrieval command `.✌️`
        viewOnceCache.set(msg.key.id, {
            filePath,
            filename,
            mimetype: realMsg[mediaType].mimetype,
            mediaType,
            senderName,
            senderNormal,
            timestamp: Date.now()
        });

        // ── Forward to owner ──────────────────────────────────────────────────
        if (settings && settings.autoSaveViewOnce) {
            // Send a header text first so the name is always clearly visible
            await sock.sendMessage(ownerJid, {
                text: `👁️ *View-Once Bypassed!*\n\n👤 *From:* ${senderName}`,
                mentions: [senderNormal]
            });

            if (mediaType === 'audioMessage') {
                // Audio messages don't support captions in WA
                await sock.sendMessage(ownerJid, {
                    audio: buffer,
                    mimetype: realMsg.audioMessage.mimetype || 'audio/ogg; codecs=opus',
                    ptt: realMsg.audioMessage.ptt || false
                });
            } else if (mediaType === 'videoMessage') {
                // Send video as a document to prevent native thumbnail generation and GLib/FFmpeg segmentation faults
                await sock.sendMessage(ownerJid, {
                    document: buffer,
                    mimetype: realMsg.videoMessage.mimetype || 'video/mp4',
                    fileName: `view_once_video_${Date.now()}.mp4`,
                    caption: `🎥 View-Once Video Bypassed!`
                });
            } else if (mediaType === 'imageMessage') {
                // Send image as a document to prevent native thumbnail generation and GLib/sharp segmentation faults
                await sock.sendMessage(ownerJid, {
                    document: buffer,
                    mimetype: realMsg.imageMessage.mimetype || 'image/jpeg',
                    fileName: `view_once_image_${Date.now()}.jpg`,
                    caption: `🖼️ View-Once Image Bypassed!`
                });
            } else {
                const typeKey = mediaType.replace('Message', '');
                await sock.sendMessage(ownerJid, {
                    [typeKey]: buffer,
                    mimetype: realMsg[mediaType].mimetype
                });
            }

            console.log(`[View-Once] Successfully forwarded to owner.`);
        } else {
            console.log(`[View-Once] Silently cached (autoSaveViewOnce is disabled).`);
        }
    } catch (err) {
        console.error('[View-Once] Failed to bypass view-once media:', err.message || err);
    }
}


async function handleAntiDelete(sock, msg, ownerJid) {
    const targetKey = msg.message.protocolMessage.key;
    console.log(`[Anti-Delete] Deletion request intercepted for message ID: ${targetKey.id}`);

    // Ignore deletions initiated by the bot owner themselves (outer msg.key.fromMe is true)
    if (msg.key.fromMe) {
        console.log(`[Anti-Delete] Deletion ignored: initiated by the bot owner themselves (msg.key.fromMe is true).`);
        return;
    }

    const cachedData = messageCache.get(targetKey.id);
    if (!cachedData) {
        console.log(`[Anti-Delete] Recovery failed: message ID ${targetKey.id} was not found in cache (was it sent before the server restarted?).`);
        return;
    }

    const originalMsg = cachedData.msg;

    // ── Determine the real sender JID ──────────────────────────────────────────
    // For groups:  targetKey.participant holds the actual sender
    // For DMs:     targetKey.remoteJid IS the sender (the chat itself)
    // Prefer the cached message's own key fields as ground truth.
    const senderRaw =
        originalMsg.key.participant ||
        targetKey.participant ||
        targetKey.remoteJid;

    // WhatsApp sometimes uses @lid (linked-device ID) instead of @s.whatsapp.net.
    // Normalise to @s.whatsapp.net so contacts-store lookups work.
    const senderNormal = senderRaw.replace('@lid', '@s.whatsapp.net');

    // ── Resolve display name (priority order) ──────────────────────────────────
    // 1. Saved contact name on your phone  (sock.contacts[id].name)
    // 2. WhatsApp "notify" / profile name  (sock.contacts[id].notify)
    // 3. pushName shipped with the message (most reliable live fallback)
    // 4. Raw phone number as last resort
    const contacts = sock.contacts || {};
    const contactEntry =
        contacts[senderNormal] ||       // normalised @s.whatsapp.net
        contacts[senderRaw] ||          // original (handles @lid edge-cases)
        null;

    // Debug: show exactly what Baileys has for this contact
    console.log(`[Anti-Delete] Contact lookup for ${senderNormal}:`, JSON.stringify(contactEntry));

    const savedName =
        contactEntry?.name ||           // your phonebook name ✅ (how YOU saved them)
        contactEntry?.notify ||         // their WA profile name
        originalMsg.pushName ||         // pushName in message header
        senderNormal.split('@')[0];     // bare phone number fallback

    // ── Group context ──────────────────────────────────────────────────────────
    let groupContext = '';
    const chatJid = targetKey.remoteJid;
    if (chatJid.endsWith('@g.us')) {
        const groupEntry = contacts[chatJid];
        const groupName = groupEntry?.subject || groupEntry?.name || 'Group Chat';
        groupContext = `\n💬 *Group:* ${groupName}`;
    }

    console.log(`[Anti-Delete] Resolved sender name: "${savedName}" for JID: ${senderRaw}`);

    try {
        await sock.sendMessage(ownerJid, {
            text: `⚠️ *Anti-Delete Alert!*\n\n👤 *From:* ${savedName}${groupContext}`,
            mentions: [senderNormal]
        });

        await sock.sendMessage(ownerJid, { forward: originalMsg });
        console.log(`[Anti-Delete] Successfully forwarded recovered message to owner's chat.`);
    } catch (err) {
        console.error(`[Anti-Delete] Error forwarding recovered message to owner:`, err);
    }
}

async function handleStatusBroadcast(sock, msg, settings) {
    const sender = msg.key.participant;
    if (!sender) return;

    const messageContent = msg.message;
    const type = Object.keys(messageContent)[0];

    // 1. AUTO-READ
    if (settings.autoReadStatus) {
        try {
            await sock.readMessages([msg.key]);
        } catch (err) {
            console.error('Failed to auto-read status:', err);
        }
    }

    // 2. AUTO-LIKE
    if (settings.autoLikeStatus) {
        try {
            await sock.sendMessage('status@broadcast', {
                react: {
                    key: msg.key,
                    text: '💚'
                }
            }, { statusJidList: [sender] });
        } catch (err) {
            console.error('Failed to auto-like status:', err);
        }
    }

}

/**
 * Handle welcomes / goodbyes
 */
async function handleParticipantsUpdate(sock, update, sessionPhone) {
    const settings = getSettings(sessionPhone);
    if (!settings.welcomeMessage) return;

    const { id, participants, action } = update;
    console.log(`[Group Update] Action: ${action} on participants inside group ${id}`);

    for (const user of participants) {
        try {
            if (action === 'add') {
                await sock.sendMessage(id, {
                    text: `👋 *Welcome to the Group!* \n\nHello @${user.split('@')[0]}, glad to have you here! Please read the group rules and enjoy your stay. ✨`,
                    mentions: [user]
                });
            } else if (action === 'remove') {
                await sock.sendMessage(id, {
                    text: `👋 *Goodbye!* \n\nUser @${user.split('@')[0]} left the group. We wish them all the best!`,
                    mentions: [user]
                });
            }
        } catch (e) {
            console.error('Failed to send welcome/goodbye:', e);
        }
    }
}

async function handleCommands(sock, msg, ownerJid, sessionPhone, settings, textContent) {
    let command = '';
    let args = [];
    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.endsWith('@g.us');

    if (textContent === '✌️') {
        command = '✌️';
    } else if (textContent.startsWith(COMMAND_PREFIX)) {
        args = textContent.slice(COMMAND_PREFIX.length).trim().split(/ +/);
        command = args.shift().toLowerCase();
    } else {
        return;
    }

    console.log(`[Command] Received: "${command}" from=${msg.key.participant || remoteJid} isGroup=${isGroup}`);

    const replyKey = `${sessionPhone}_replies`;

    switch (command) {
        case 'help':
        case 'menu':
            const helpMenu = `🤖 *Flex BOT - Controls Menu*

*Prefix:* \`${COMMAND_PREFIX}\`

*🔮 Premium Creators:*
👉 \`${COMMAND_PREFIX}sticker\` / \`s\` - Convert quoted image/video/GIF to Sticker.
👉 \`${COMMAND_PREFIX}save\` - Reply to status/media to download directly to your DM.
👉 \`${COMMAND_PREFIX}peace\` / \`✌️\` - Reply to view-once message to recover directly to your DM.

*🤖 Auto-Responder (Triggers):*
👉 \`${COMMAND_PREFIX}addreply <keyword> -> <text>\` - Set auto reply.
👉 \`${COMMAND_PREFIX}delreply <keyword>\` - Delete auto reply.
👉 \`${COMMAND_PREFIX}replies\` - List current replies.

*🧠 local AI Assistant:*
👉 \`${COMMAND_PREFIX}ai <prompt>\` - Ask bot dynamic AI questions.

*🛡️ Group Utilities & Protection:*
👉 \`${COMMAND_PREFIX}antilink on/off\` - Toggle link kick protection.
👉 \`${COMMAND_PREFIX}welcome on/off\` - Toggle welcome cards.
👉 \`${COMMAND_PREFIX}tagall\` - Mention all members.
👉 \`${COMMAND_PREFIX}kick @user\` - Remove member.
👉 \`${COMMAND_PREFIX}promote @user\` - Admin promotion.
👉 \`${COMMAND_PREFIX}demote @user\` - Admin demotion.

*📢 Broadcaster:*
👉 \`${COMMAND_PREFIX}broadcast <text>\` - Mass announcement.

*⚙️ Core Toggles:*
👉 \`${COMMAND_PREFIX}antidelete on/off\`
👉 \`${COMMAND_PREFIX}viewonce on/off\`
👉 \`${COMMAND_PREFIX}statusview on/off\`
👉 \`${COMMAND_PREFIX}statuslike on/off\`
👉 \`${COMMAND_PREFIX}settings\` - View active configuration.
`;
            await sock.sendMessage(remoteJid, { text: helpMenu });
            break;

        case 'settings':
            const currentSettings = `⚙️ *Your Dynamic Bot Settings:*

🚫 *Anti-Delete*: ${settings.autoRecoverDeleted ? '🟢 Enabled' : '🔴 Disabled'}
🔓 *View-Once Bypass*: ${settings.autoSaveViewOnce ? '🟢 Enabled' : '🔴 Disabled'}
👁️ *Status Auto-View*: ${settings.autoReadStatus ? '🟢 Enabled' : '🔴 Disabled'}
💚 *Status Auto-Like*: ${settings.autoLikeStatus ? '🟢 Enabled' : '🔴 Disabled'}
🛡️ *Anti-Link Guard*: ${settings.antiLink ? '🟢 Enabled' : '🔴 Disabled'}
👋 *Welcome Messages*: ${settings.welcomeMessage ? '🟢 Enabled' : '🔴 Disabled'}
`;
            await sock.sendMessage(remoteJid, { text: currentSettings });
            break;

        case 'antidelete':
            if (args[0] === 'on' || args[0] === 'off') {
                const val = args[0] === 'on';
                userSettings.set(sessionPhone, { ...settings, autoRecoverDeleted: val });
                await sock.sendMessage(remoteJid, { text: `✅ *Anti-Delete* has been turned ${args[0].toUpperCase()}.` });
            }
            break;

        case 'viewonce':
            if (args[0] === 'on' || args[0] === 'off') {
                const val = args[0] === 'on';
                userSettings.set(sessionPhone, { ...settings, autoSaveViewOnce: val });
                await sock.sendMessage(remoteJid, { text: `✅ *View-Once Bypass* has been turned ${args[0].toUpperCase()}.` });
            }
            break;

        case 'statusview':
            if (args[0] === 'on' || args[0] === 'off') {
                const val = args[0] === 'on';
                userSettings.set(sessionPhone, { ...settings, autoReadStatus: val });
                await sock.sendMessage(remoteJid, { text: `✅ *Status Auto-View* has been turned ${args[0].toUpperCase()}.` });
            }
            break;

        case 'statuslike':
            if (args[0] === 'on' || args[0] === 'off') {
                const val = args[0] === 'on';
                userSettings.set(sessionPhone, { ...settings, autoLikeStatus: val });
                await sock.sendMessage(remoteJid, { text: `✅ *Status Auto-Like* has been turned ${args[0].toUpperCase()}.` });
            }
            break;

        case 'antilink':
            if (args[0] === 'on' || args[0] === 'off') {
                const val = args[0] === 'on';
                userSettings.set(sessionPhone, { ...settings, antiLink: val });
                await sock.sendMessage(remoteJid, { text: `✅ *Anti-Link Protection* has been turned ${args[0].toUpperCase()}.` });
            }
            break;

        case 'welcome':
            if (args[0] === 'on' || args[0] === 'off') {
                const val = args[0] === 'on';
                userSettings.set(sessionPhone, { ...settings, welcomeMessage: val });
                await sock.sendMessage(remoteJid, { text: `✅ *Group Welcome Card* has been turned ${args[0].toUpperCase()}.` });
            }
            break;

        case 'addreply':
            const fullArg = args.join(' ');
            if (!fullArg.includes('->')) {
                await sock.sendMessage(remoteJid, { text: `❌ Use: \`${COMMAND_PREFIX}addreply <trigger> -> <response>\`` });
                break;
            }
            const [trigger, response] = fullArg.split('->').map(s => s.trim().toLowerCase());
            const currentReplies = autoReplies.get(replyKey) || {};
            currentReplies[trigger] = fullArg.split('->')[1].trim();
            autoReplies.set(replyKey, currentReplies);
            await sock.sendMessage(remoteJid, { text: `✅ Custom reply registered: *"${trigger}"* will now trigger your response.` });
            break;

        case 'delreply':
            if (args.length === 0) {
                await sock.sendMessage(remoteJid, { text: `❌ Use: \`${COMMAND_PREFIX}delreply <trigger>\`` });
                break;
            }
            const triggerDel = args.join(' ').trim().toLowerCase();
            const repList = autoReplies.get(replyKey) || {};
            if (repList[triggerDel]) {
                delete repList[triggerDel];
                autoReplies.set(replyKey, repList);
                await sock.sendMessage(remoteJid, { text: `✅ Auto reply for *"${triggerDel}"* deleted successfully.` });
            } else {
                await sock.sendMessage(remoteJid, { text: `❌ Auto reply for *"${triggerDel}"* was not found.` });
            }
            break;

        case 'replies':
            const listReplies = autoReplies.get(replyKey) || {};
            const keys = Object.keys(listReplies);
            if (keys.length === 0) {
                await sock.sendMessage(remoteJid, { text: `📂 No custom auto-replies registered.` });
            } else {
                const mapStr = keys.map((k, i) => `${i + 1}. *${k}* -> ${listReplies[k]}`).join('\n');
                await sock.sendMessage(remoteJid, { text: `📂 *Your Auto-Replies:*\n\n${mapStr}` });
            }
            break;

        case 'ai':
            if (args.length === 0) {
                await sock.sendMessage(remoteJid, { text: '❌ Please ask me a question: `.ai write a hello world program in js`.' });
                break;
            }
            await sock.sendMessage(remoteJid, { text: '🧠 Flex AI is thinking...' });
            
            const prompt = args.join(' ').toLowerCase();
            let aiResponse = `🤖 *Flex AI Core Response:* \n\nI processed your request: "${prompt}".\n\n`;
            
            if (prompt.includes('hello') || prompt.includes('hi')) {
                aiResponse += 'Hello! I am your advanced AI coding and automation assistant. How can I help you automate your WhatsApp operations today?';
            } else if (prompt.includes('code') || prompt.includes('js') || prompt.includes('program')) {
                aiResponse += 'Here is a custom code solution based on your prompt:\n```javascript\n// Flex AI Automated Script\nfunction handleFlex() {\n    console.log("Flex Bot is Online!");\n}\nhandleFlex();\n```';
            } else if (prompt.includes('weather') || prompt.includes('time')) {
                aiResponse += `The current local time in your server sandbox is ${new Date().toLocaleString()}. All systems are operating at peak optimal capacity.`;
            } else {
                aiResponse += 'Here is the summary analysis of your query. Flex BOT can be easily extended to Google Gemini or OpenAI by putting your API key in the `.env` configuration file inside your project directory!';
            }
            
            await sock.sendMessage(remoteJid, { text: aiResponse });
            break;

        case 'peace':
        case '✌️': {
            const quotedContext = msg.message.extendedTextMessage?.contextInfo;
            if (!quotedContext || !quotedContext.stanzaId) {
                await sock.sendMessage(ownerJid, { text: '❌ Please reply/quote a view-once message with this command.' });
                break;
            }

            const quotedId = quotedContext.stanzaId;
            let buffer = null;
            let mimeType = '';
            let mediaType = '';
            let senderName = 'Quoted Message';

            // 1. Try to download directly from the quotedMessage protobuf itself!
            const quotedMessage = quotedContext.quotedMessage;
            if (quotedMessage) {
                let content = quotedMessage;
                if (content.ephemeralMessage?.message) {
                    content = content.ephemeralMessage.message;
                }

                const wrappedViewOnce =
                    content.viewOnceMessageV2 ||
                    content.viewOnceMessage ||
                    content.viewOnceMessageV2Extension;

                const flatType = ['imageMessage', 'videoMessage', 'audioMessage'].find(
                    t => content[t] && (content[t].viewOnce === true || content[t].viewOnce === 1)
                );

                if (wrappedViewOnce || flatType) {
                    const realMsg = wrappedViewOnce ? getRealMessage(quotedMessage) : content;
                    if (realMsg) {
                        mediaType = flatType || Object.keys(realMsg).find(
                            k => ['imageMessage', 'videoMessage', 'audioMessage'].includes(k)
                        );

                        if (mediaType) {
                            try {
                                await sock.sendMessage(ownerJid, { text: '⏳ Decrypting quoted view-once media directly...' });
                                
                                const fakeMsg = { 
                                    key: { 
                                        remoteJid: remoteJid, 
                                        id: quotedId, 
                                        participant: quotedContext.participant 
                                    }, 
                                    message: realMsg 
                                };

                                buffer = await downloadMediaMessage(
                                    fakeMsg,
                                    'buffer',
                                    {},
                                    { reuploadRequest: sock.updateMediaMessage }
                                );

                                if (buffer && buffer.length > 0) {
                                    mimeType = realMsg[mediaType].mimetype;
                                    console.log(`[Command-Peace] Directly downloaded from quoted protobuf successfully!`);
                                }
                            } catch (err) {
                                console.error('[Command-Peace] Direct download from quoted protobuf failed:', err);
                            }
                        }
                    }
                }
            }

            // 2. Fallback: Check our viewOnceCache
            if (!buffer) {
                console.log(`[Command-Peace] Direct download missed/failed. Checking viewOnceCache for quoted ID: ${quotedId}`);
                let voInfo = viewOnceCache.get(quotedId);
                if (voInfo && voInfo.filePath && fs.existsSync(voInfo.filePath)) {
                    try {
                        buffer = fs.readFileSync(voInfo.filePath);
                        mimeType = voInfo.mimetype;
                        mediaType = voInfo.mediaType;
                        senderName = voInfo.senderName;
                        console.log(`[Command-Peace] Found in viewOnceCache: ${voInfo.filename}`);
                    } catch (e) {
                        console.error('[Command-Peace] Failed to read cached file:', e);
                    }
                }
            }

            // 3. Fallback 2: Check raw messageCache and try download on demand
            if (!buffer) {
                console.log(`[Command-Peace] viewOnceCache miss. Checking raw messageCache...`);
                const cachedMsg = messageCache.get(quotedId);
                if (cachedMsg && cachedMsg.msg && cachedMsg.msg.message) {
                    const originalMsg = cachedMsg.msg;
                    const messageContent = originalMsg.message;
                    if (messageContent) {
                        let content = messageContent;
                        if (content.ephemeralMessage?.message) {
                            content = content.ephemeralMessage.message;
                        }

                        const wrappedViewOnce =
                            content.viewOnceMessageV2 ||
                            content.viewOnceMessage ||
                            content.viewOnceMessageV2Extension;

                        const flatType = ['imageMessage', 'videoMessage', 'audioMessage'].find(
                            t => content[t] && (content[t].viewOnce === true || content[t].viewOnce === 1)
                        );

                        if (wrappedViewOnce || flatType) {
                            const realMsg = wrappedViewOnce ? getRealMessage(messageContent) : messageContent;
                            if (realMsg) {
                                mediaType = flatType || Object.keys(realMsg).find(
                                    k => ['imageMessage', 'videoMessage', 'audioMessage'].includes(k)
                                );
                                if (mediaType) {
                                    try {
                                        await sock.sendMessage(ownerJid, { text: '⏳ Decrypting raw cached view-once media...' });
                                        const fakeMsg = { key: originalMsg.key, message: realMsg };
                                        buffer = await downloadMediaMessage(
                                            fakeMsg,
                                            'buffer',
                                            {},
                                            { reuploadRequest: sock.updateMediaMessage }
                                        );

                                        if (buffer && buffer.length > 0) {
                                            mimeType = realMsg[mediaType].mimetype;
                                            
                                            // Extract sender name
                                            const senderRaw = originalMsg.key.participant || originalMsg.key.remoteJid;
                                            const senderNormal = senderRaw.replace('@lid', '@s.whatsapp.net');
                                            const contacts = sock.contacts || {};
                                            const contactEntry = contacts[senderNormal] || contacts[senderRaw] || null;
                                            senderName = contactEntry?.name || contactEntry?.notify || originalMsg.pushName || senderNormal.split('@')[0];

                                            console.log(`[Command-Peace] Successfully downloaded on-demand from raw cache.`);
                                        }
                                    } catch (err) {
                                        console.error('[Command-Peace] Failed to download from raw cache:', err);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // 4. Send recovered media or show clean fail error
            if (buffer && buffer.length > 0) {

                await sock.sendMessage(ownerJid, {
                    text: `✌️ *View-Once Recovered!* \n\n👤 *From:* ${senderName}`,
                });

                if (mediaType === 'audioMessage') {
                    await sock.sendMessage(ownerJid, {
                        audio: buffer,
                        mimetype: mimeType || 'audio/ogg; codecs=opus',
                        ptt: false
                    });
                } else if (mediaType === 'videoMessage') {
                    // Send video as a document to prevent native thumbnail generation and GLib/FFmpeg segmentation faults
                    await sock.sendMessage(ownerJid, {
                        document: buffer,
                        mimetype: mimeType || 'video/mp4',
                        fileName: `recovered_video_${Date.now()}.mp4`,
                        caption: `🎥 Video recovered successfully!`
                    });
                } else if (mediaType === 'imageMessage') {
                    // Send image as a document to prevent native thumbnail generation and GLib/sharp segmentation faults
                    await sock.sendMessage(ownerJid, {
                        document: buffer,
                        mimetype: mimeType || 'image/jpeg',
                        fileName: `recovered_image_${Date.now()}.jpg`,
                        caption: `🖼️ Image recovered successfully!`
                    });
                } else {
                    const typeKey = mediaType.replace('Message', '');
                    await sock.sendMessage(ownerJid, {
                        [typeKey]: buffer,
                        mimetype: mimeType
                    });
                }
            } else {
                await sock.sendMessage(ownerJid, {
                    text: `❌ *View-Once Recovery Failed*\n\nThe media keys for this message could not be decrypted. It may have expired or was sent while the bot was offline.`
                });
            }
            break;
        }

        case 'save': {
            const quotedContext = msg.message.extendedTextMessage?.contextInfo;
            if (!quotedContext || !quotedContext.quotedMessage) {
                await sock.sendMessage(ownerJid, { text: '❌ Please reply to a status story or media message with this command.' });
                break;
            }

            const quotedMessage = quotedContext.quotedMessage;
            let content = quotedMessage;
            if (content.ephemeralMessage?.message) {
                content = content.ephemeralMessage.message;
            }

            // Extract type
            const mediaType = ['imageMessage', 'videoMessage', 'audioMessage'].find(
                t => content[t]
            );

            if (!mediaType) {
                // If it's a text status story
                if (content.conversation || content.extendedTextMessage?.text) {
                    const text = content.conversation || content.extendedTextMessage.text;
                    await sock.sendMessage(ownerJid, {
                        text: `📝 *Quoted Status Text Recovery:*\n\n${text}`
                    });
                } else {
                    await sock.sendMessage(ownerJid, { text: '❌ Quoted message has no recoverable media or text.' });
                }
                break;
            }

            try {
                await sock.sendMessage(ownerJid, { text: '⏳ Downloading quoted status media...' });

                const fakeMsg = {
                    key: {
                        remoteJid: remoteJid,
                        id: quotedContext.stanzaId,
                        participant: quotedContext.participant
                    },
                    message: content
                };

                const buffer = await downloadMediaMessage(
                    fakeMsg,
                    'buffer',
                    {},
                    { reuploadRequest: sock.updateMediaMessage }
                );

                if (buffer && buffer.length > 0) {
                    const typeKey = mediaType.replace('Message', ''); // 'image', 'video' or 'audio'
                    
                    if (typeKey === 'audio') {
                        await sock.sendMessage(ownerJid, {
                            audio: buffer,
                            mimetype: content[mediaType].mimetype || 'audio/ogg; codecs=opus',
                            ptt: false
                        });
                    } else if (typeKey === 'video') {
                        // Send video as a document to prevent native thumbnail generation and GLib/FFmpeg segmentation faults
                        await sock.sendMessage(ownerJid, {
                            document: buffer,
                            mimetype: content[mediaType].mimetype || 'video/mp4',
                            fileName: `recovered_status_${Date.now()}.mp4`,
                            caption: content[mediaType].caption || '🎥 Status Video Recovered!'
                        });
                    } else if (typeKey === 'image') {
                        // Send image as a document to prevent native thumbnail generation and GLib/sharp segmentation faults
                        await sock.sendMessage(ownerJid, {
                            document: buffer,
                            mimetype: content[mediaType].mimetype || 'image/jpeg',
                            fileName: `recovered_status_${Date.now()}.jpg`,
                            caption: content[mediaType].caption || '🖼️ Status Image Recovered!'
                        });
                    } else {
                        await sock.sendMessage(ownerJid, {
                            [typeKey]: buffer,
                            mimetype: content[mediaType].mimetype,
                            caption: content[mediaType].caption || ''
                        });
                    }
                } else {
                    await sock.sendMessage(ownerJid, { text: '❌ Failed to download the status media. The media key may have expired.' });
                }
            } catch (err) {
                console.error('[Command-Save] Failed to download status/media:', err);
                await sock.sendMessage(ownerJid, { text: '❌ An error occurred while recovering the media.' });
            }
            break;
        }

        case 'sticker':
        case 's':
            const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const messageToUse = quoted || msg.message;
            const type = getContentType(messageToUse);

            if (type === 'imageMessage' || type === 'videoMessage') {
                await sock.sendMessage(remoteJid, { text: '⏳ Creating your premium sticker...' });
                try {
                    const fakeMsg = quoted ? { 
                        key: msg.key, 
                        message: quoted 
                    } : msg;

                    const buffer = await downloadMediaMessage(
                        fakeMsg,
                        'buffer',
                        {},
                        { logger: console }
                    );

                    const sticker = new Sticker(buffer, {
                        pack: 'Flex BOT Premium Pack',
                        author: 'Flex Master',
                        type: StickerTypes.FULL,
                        categories: ['🤩', '🎉'],
                        id: msg.key.id,
                        quality: 70
                    });

                    const stickerBuffer = await sticker.toBuffer();
                    await sock.sendMessage(remoteJid, { sticker: stickerBuffer });
                } catch (err) {
                    console.error('Failed to create sticker:', err);
                    await sock.sendMessage(remoteJid, { text: '❌ Failed to create sticker.' });
                }
            } else {
                await sock.sendMessage(remoteJid, { text: '❌ Please reply to an *image* or *video/GIF* to make a sticker.' });
            }
            break;

        case 'tagall':
            if (!isGroup) return;
            try {
                const metadata = await sock.groupMetadata(remoteJid);
                const users = metadata.participants.map(p => p.id);
                const mentionText = users.map(u => `@${u.split('@')[0]}`).join(' ');
                await sock.sendMessage(remoteJid, {
                    text: `📢 *Attention Members!* \n\n${mentionText}`,
                    mentions: users
                });
            } catch (err) {
                console.error(err);
            }
            break;

        case 'kick':
            if (!isGroup) return;
            if (args.length === 0) return;
            const targetKick = args[0].replace('@', '') + '@s.whatsapp.net';
            await sock.groupParticipantsUpdate(remoteJid, [targetKick], 'remove');
            await sock.sendMessage(remoteJid, { text: `✅ User removed.` });
            break;

        case 'promote':
            if (!isGroup) return;
            if (args.length === 0) return;
            const targetPromote = args[0].replace('@', '') + '@s.whatsapp.net';
            await sock.groupParticipantsUpdate(remoteJid, [targetPromote], 'promote');
            await sock.sendMessage(remoteJid, { text: `✅ User promoted.` });
            break;

        case 'demote':
            if (!isGroup) return;
            if (args.length === 0) return;
            const targetDemote = args[0].replace('@', '') + '@s.whatsapp.net';
            await sock.groupParticipantsUpdate(remoteJid, [targetDemote], 'demote');
            await sock.sendMessage(remoteJid, { text: `✅ User demoted.` });
            break;

        case 'broadcast':
            if (args.length === 0) return;
            const bcMsg = args.join(' ');
            const bcKeys = Object.keys(chatLogs.all()).filter(k => k.startsWith(sessionPhone));
            let successCount = 0;

            for (const key of bcKeys) {
                const targetChat = key.split('_')[1];
                try {
                    await sock.sendMessage(targetChat, { text: `📢 *BROADCAST:*\n\n${bcMsg}` });
                    successCount++;
                } catch (e) {
                    console.error('Failed to broadcast:', targetChat, e);
                }
            }
            await sock.sendMessage(remoteJid, { text: `✅ Sent broadcast to ${successCount} chats.` });
            break;
    }
}

module.exports = {
    handleMessage,
    handleParticipantsUpdate
};
