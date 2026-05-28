require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const express = require('express');
const path = require('path');
const fs = require('fs');
const { handleMessage } = require('./messageHandler');
const { messageCache } = require('./db');

const bootTime = Date.now();

// Process-wide error boundary to prevent Baileys socket closure crashes
process.on('uncaughtException', (err) => {
    console.error('🔥 [Process Error] Uncaught Exception:', err.message || err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 [Process Error] Unhandled Rejection:', reason?.message || reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Enable CORS Middleware for Vercel Frontend Connection
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Store multiple active user sessions (Map of phone -> socket information)
const sessions = new Map();

// Setup silent logger for Baileys
const logger = pino({ level: 'silent' });

/**
 * Custom MongoDB-backed authentication state provider for Baileys.
 * Allows hosting on ephemeral environments (Render/Vercel) without session loss.
 */
async function useMongoAuthState(phone) {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) return null;

    const { MongoClient } = require('mongodb');
    const client = new MongoClient(mongoUri);
    await client.connect();
    const db = client.db('whatsapp_sessions');
    const collection = db.collection(`session_${phone}`);

    const readData = async (id) => {
        try {
            const doc = await collection.findOne({ _id: id });
            if (doc && doc.data) {
                return JSON.parse(doc.data, (key, value) => {
                    if (value && typeof value === 'object' && value.type === 'Buffer') {
                        return Buffer.from(value.data);
                    }
                    return value;
                });
            }
        } catch (e) {
            console.error('[MongoAuth] Failed to read key:', id, e.message);
        }
        return null;
    };

    const writeData = async (id, value) => {
        try {
            if (value === null || value === undefined) {
                await collection.deleteOne({ _id: id });
            } else {
                const serialized = JSON.stringify(value, (key, val) => {
                    if (Buffer.isBuffer(val)) {
                        return { type: 'Buffer', data: val.toJSON().data };
                    }
                    return val;
                });
                await collection.updateOne(
                    { _id: id },
                    { $set: { data: serialized } },
                    { upsert: true }
                );
            }
        } catch (e) {
            console.error('[MongoAuth] Failed to write key:', id, e.message);
        }
    };

    // Initialize credentials
    let creds = await readData('creds');
    if (!creds) {
        const { initAuthCreds } = require('@whiskeysockets/baileys');
        creds = initAuthCreds();
        await writeData('creds', creds);
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            tasks.push(writeData(`${category}-${id}`, value));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', creds);
        }
    };
}

/**
 * Initialize a new WhatsApp connection for a specific phone number
 */
async function startSession(phone) {
    let state, saveCreds;
    
    // Dynamically connect to MongoDB if MONGO_URI is set
    if (process.env.MONGO_URI) {
        try {
            console.log(`[Session Manager] Connecting to MongoDB for phone: ${phone}...`);
            const mongoAuth = await useMongoAuthState(phone);
            state = mongoAuth.state;
            saveCreds = mongoAuth.saveCreds;
            console.log(`[Session Manager] MongoDB Connection successful for phone: ${phone}!`);
        } catch (e) {
            console.error(`[Session Manager] MongoDB Connection failed, falling back to local files:`, e.message);
        }
    }

    // Fallback to local files if MongoDB is not configured or fails
    if (!state) {
        const sessionDir = path.join(__dirname, 'sessions', `session_${phone}`);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        const diskAuth = await useMultiFileAuthState(sessionDir);
        state = diskAuth.state;
        saveCreds = diskAuth.saveCreds;
    }

    const { fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    console.log(`[Session Manager] Starting session for phone: ${phone} (WA Version: ${version.join('.')})`);

    const sock = makeWASocket({
        // Use cacheable Signal key store — keeps keys in memory for fast access,
        // dramatically reducing NULL/ENCRYPTED failures on first contact messages.
        auth: {
            creds: state.creds,
            keys: state.keys
        },
        version,
        printQRInTerminal: false,
        logger,
        browser: ['Windows', 'Chrome', '122.0.0.0'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        // Required for Baileys to retry messages it failed to decrypt.
        getMessage: async (key) => {
            const cached = messageCache.get(key.id);
            if (cached?.msg?.message) return cached.msg.message;
            return undefined;
        }
    });

    // Save auth credentials whenever updated
    sock.ev.on('creds.update', saveCreds);

    // Track which JIDs have had their stale session cleared this session.
    // Prevents repeatedly deleting the session file during the re-establishment window.
    const clearedSessions = new Set();

    // Track connection updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) 
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut 
                : true;
            
            console.log(`❌ Connection closed for ${phone}. Reason: ${lastDisconnect?.error || 'Unknown'}. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect && sock.authState.creds.registered) {
                startSession(phone);
            } else if (!sock.authState.creds.registered) {
                console.log(`ℹ️ Pairing process stopped/failed for ${phone}. Clean up connection state.`);
                sessions.delete(phone);
            } else {
                console.log(`🛑 Session logged out for ${phone}. Cleaning storage.`);
                sessions.delete(phone);
                try {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                } catch (e) {
                    console.error('Failed to clean session folder:', e);
                }
            }
        } else if (connection === 'open') {
            const currentSession = sessions.get(phone) || {};
            currentSession.status = 'connected';
            sessions.set(phone, currentSession);
            clearedSessions.clear(); // reset on each connection
            
            console.log(`🌟 ==================================== 🌟`);
            console.log(`🚀   Flex BOT is Online for @${phone}!   🚀`);
            console.log(`🌟 ==================================== 🌟`);

            // Send confirmation message to the owner's private DM
            const ownerJid = `${phone}@s.whatsapp.net`;
            try {
                await sock.sendMessage(ownerJid, {
                    text: `🌟 *Flex BOT Connected Successfully!* 🚀\n\nAll premium features (Anti-Delete, View-Once Bypass, and Status Auto-Capture) are now **active and operating at peak capacity**.\n\n👉 Send \`.help\` or \`.menu\` to view all commands!`
                });
            } catch (e) {
                console.error('[Session Manager] Failed to send connection welcome message:', e);
            }

            // ── Pre-warm Signal sessions with all known contacts ────────────────
            // Subscribing to a contact's presence triggers the Signal pre-key
            // exchange, so the session is established BEFORE they send a view-once.
            // Runs 8s after connect to let contacts & history sync first.
            setTimeout(async () => {
                const knownJids = Object.keys(sock.contacts || {})
                    .filter(jid =>
                        (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) &&
                        !jid.endsWith('@g.us') &&
                        !jid.startsWith('status')
                    );
                console.log(`[Pre-warm] Establishing sessions with ${knownJids.length} contacts...`);
                for (let i = 0; i < knownJids.length; i += 5) {
                    const batch = knownJids.slice(i, i + 5);
                    await Promise.allSettled(batch.map(jid => sock.presenceSubscribe(jid).catch(() => {})));
                    await new Promise(r => setTimeout(r, 800)); // 800ms between batches
                }
                console.log(`[Pre-warm] Done — sessions pre-established.`);
            }, 8000);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        // RAW log every message before any filtering — shows null/encrypted messages too
        for (const msg of m.messages) {
            const msgTime = (msg.messageTimestamp * 1000) || Date.now();
            if (msgTime < bootTime - 24 * 60 * 60 * 1000) {
                continue; // Skip very old historical messages
            }
            const rawKeys = msg.message ? Object.keys(msg.message).join(',') : 'NULL/ENCRYPTED';
            console.log(`[RAW] upsert type=${m.type} | id=...${msg.key?.id?.slice(-8)} | keys=${rawKeys} | from=${msg.key?.participant || msg.key?.remoteJid}`);
        }

        for (const msg of m.messages) {
            const msgTime = (msg.messageTimestamp * 1000) || Date.now();
            if (msgTime < bootTime - 24 * 60 * 60 * 1000) {
                // Skip very old historical messages
                continue;
            }

            // ── NULL/ENCRYPTED: clear stale session ONCE & kickstart fresh one ──
            // Only clear session files the FIRST time we see NULL/ENCRYPTED from
            // a JID — repeated deletions interrupt the re-establishment process.
            if (!msg.message && (m.type === 'notify' || m.type === 'append')) {
                const senderJid = msg.key.participant || msg.key.remoteJid;
                const lidId = senderJid.split('@')[0];

                if (!clearedSessions.has(senderJid)) {
                    clearedSessions.add(senderJid);
                    console.log(`[Session] NULL/ENCRYPTED from ${senderJid} — clearing stale session (once)...`);

                    // Clear stale Signal session using official Baileys state keys API
                    // This deletes the session from disk AND clears Baileys' in-memory key cache!
                    try {
                        const alternateJid = senderJid.endsWith('@lid')
                            ? senderJid.replace('@lid', '@s.whatsapp.net')
                            : senderJid.replace('@s.whatsapp.net', '@lid');

                        await state.keys.set({
                            'session': {
                                [senderJid]: null,
                                [alternateJid]: null
                            }
                        });
                        if (sock.auth && sock.auth.keys && typeof sock.auth.keys.set === 'function') {
                            await sock.auth.keys.set({
                                'session': {
                                    [senderJid]: null,
                                    [alternateJid]: null
                                }
                            });
                        }
                        console.log(`[Session] Cleanly reset Baileys Signal session (disk & memory cache) for ${senderJid} and ${alternateJid}`);
                    } catch (e) {
                        console.error('Failed to reset Baileys auth keys:', e);
                    }

                    // Subscribe to presence → triggers fresh prekey bundle exchange
                    try {
                        await sock.presenceSubscribe(senderJid);
                        await sock.presenceSubscribe(alternateJid).catch(() => {});
                        console.log(`[Session] Presence subscribed → fresh session exchange for ${senderJid} and ${alternateJid}`);
                    } catch (e) { /* ignore */ }
                } else {
                    console.log(`[Session] NULL/ENCRYPTED from ${senderJid} — waiting for retry (session reset already in progress)`);
                }
                continue;
            }

            if (m.type === 'notify' || m.type === 'append') {
                await handleMessage(sock, msg, phone);
            }
        }
    });

    // messages.update fires when Baileys successfully decrypts a message that
    // previously arrived null/encrypted (e.g. after a Signal session refresh).
    // This is how we catch view-once messages that were missed on first delivery.
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (!update.update?.message) continue;
            const fullMsg = { key: update.key, message: update.update.message };
            const rawKeys = Object.keys(update.update.message).join(',');
            console.log(`[RETRY-DECRYPT] id=...${update.key?.id?.slice(-8)} | keys=${rawKeys}`);
            // Run view-once check on the now-decrypted message
            await handleMessage(sock, fullMsg, phone, { viewOnceOnly: true });
        }
    });

    sock.ev.on('group-participants.update', async (update) => {
        const { handleParticipantsUpdate } = require('./messageHandler');
        await handleParticipantsUpdate(sock, update, phone);
    });

    // ── Contact sync ────────────────────────────────────────────────────────
    // messaging-history.set fires on every connect and carries the FULL
    // contact list including phonebook names (contact.name = how YOU saved them).
    sock.ev.on('messaging-history.set', ({ contacts: historicContacts, messages: historicMessages }) => {
        // ── Contacts ──────────────────────────────────────────────────────────
        if (!sock.contacts) sock.contacts = {};
        if (historicContacts && Array.isArray(historicContacts)) {
            for (const contact of historicContacts) {
                if (contact.id) {
                    sock.contacts[contact.id] = { ...(sock.contacts[contact.id] || {}), ...contact };
                }
            }
            console.log(`[Contacts] Loaded ${historicContacts.length} contacts from history sync.`);
        }

    });

    // contacts.upsert fires for incremental contact additions/updates
    sock.ev.on('contacts.upsert', (newContacts) => {
        if (!sock.contacts) sock.contacts = {};
        for (const contact of newContacts) {
            if (contact.id) {
                sock.contacts[contact.id] = { ...(sock.contacts[contact.id] || {}), ...contact };
            }
        }
    });

    sock.ev.on('contacts.update', (updates) => {
        if (!sock.contacts) sock.contacts = {};
        for (const update of updates) {
            if (update.id) {
                sock.contacts[update.id] = { ...(sock.contacts[update.id] || {}), ...update };
            }
        }
    });

    // Save connection instance to session map
    sessions.set(phone, { sock, status: 'pairing' });

    // Request Pairing Code safely with error boundaries
    if (!sock.authState.creds.registered) {
        try {
            // Wait slightly for socket to stabilize connection with WhatsApp server
            await new Promise(resolve => setTimeout(resolve, 6000));
            
            // Check if socket is still active before sending pairing request
            if (sessions.has(phone)) {
                const code = await sock.requestPairingCode(phone);
                return code;
            } else {
                throw new Error('Connection closed before pairing code could be requested.');
            }
        } catch (err) {
            console.error(`⚠️ Failed to retrieve pairing code for ${phone}:`, err.message);
            sessions.delete(phone);
            throw err;
        }
    }
}

// REST API endpoints
app.get('/api/status', (req, res) => {
    const { phone } = req.query;
    if (!phone) {
        return res.json({ status: 'offline' });
    }
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const session = sessions.get(cleanPhone);
    res.json({ status: session ? session.status : 'offline' });
});

app.post('/api/generate-code', async (req, res) => {
    let { phone } = req.body;
    if (!phone) {
        return res.status(400).json({ success: false, error: 'Phone number is required' });
    }

    phone = phone.replace(/[^0-9]/g, '');

    const existingSession = sessions.get(phone);
    if (existingSession && existingSession.status === 'connected') {
        return res.json({ success: true, code: null, message: 'Already connected!' });
    }

    try {
        const code = await startSession(phone);
        res.json({ success: true, code });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to request pairing code. Make sure the phone number is valid and includes the country code. Try again in a few seconds.' });
    }
});

// Serve frontend dashboard
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start API Server and automatically auto-login ALL saved sessions
app.listen(PORT, async () => {
    console.log(`🌐 Server running at: http://localhost:${PORT}`);
    
    // Auto-login existing sessions in directory
    const sessionsBaseDir = path.join(__dirname, 'sessions');
    if (fs.existsSync(sessionsBaseDir)) {
        const folders = fs.readdirSync(sessionsBaseDir);
        for (const folder of folders) {
            if (folder.startsWith('session_')) {
                const phone = folder.replace('session_', '');
                const credsFile = path.join(sessionsBaseDir, folder, 'creds.json');
                
                let isRegistered = false;
                if (fs.existsSync(credsFile)) {
                    try {
                        const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
                        isRegistered = creds.registered === true;
                    } catch (e) {
                        // Corrupted JSON
                    }
                }
                
                if (isRegistered) {
                    console.log(`📦 Auto-connecting saved session for: ${phone}`);
                    startSession(phone).catch(err => console.error(`Failed to auto-connect ${phone}:`, err));
                } else {
                    // Clean up failed/unregistered session folders to keep storage pristine
                    console.log(`🧹 Cleaning unregistered/failed session folder for: ${phone}`);
                    try {
                        fs.rmSync(path.join(sessionsBaseDir, folder), { recursive: true, force: true });
                    } catch (e) {}
                }
            }
        }
    }
});
