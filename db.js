const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

let mongoClient = null;
let mongoDb = null;

async function getMongoDb() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) return null;

    if (mongoDb) return mongoDb;

    try {
        if (!mongoClient) {
            mongoClient = new MongoClient(mongoUri, {
                maxPoolSize: 10,
                minPoolSize: 2,
                connectTimeoutMS: 5000,
                serverSelectionTimeoutMS: 5000
            });
            await mongoClient.connect();
        }
        mongoDb = mongoClient.db('whatsapp_sessions');
        return mongoDb;
    } catch (err) {
        // Log simple connection failure notice to keep console logs completely clean
        console.warn(`[Mongo DB] Persistent connection skipped (please verify MONGO_URI in Render dashboard).`);
        mongoClient = null;
        mongoDb = null;
        return null;
    }
}

class JSONDatabase {
    constructor(filename) {
        this.filePath = path.join(__dirname, 'data', filename);
        this.data = {};
        this.init();
        this.loadFromMongo();
    }

    init() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(this.filePath)) {
            this.saveLocal();
        } else {
            try {
                const content = fs.readFileSync(this.filePath, 'utf-8');
                this.data = JSON.parse(content || '{}');
            } catch (error) {
                console.error(`Failed to load database: ${this.filePath}`, error);
                this.data = {};
            }
        }
    }

    async loadFromMongo() {
        try {
            const db = await getMongoDb();
            if (!db) return;

            const colName = this.filePath.split(/[\\/]/).pop().replace('.json', '');
            const collection = db.collection(colName);
            const doc = await collection.findOne({ _id: 'main_data' });
            if (doc && doc.data) {
                const parsed = JSON.parse(doc.data);
                this.data = { ...this.data, ...parsed };
                this.saveLocal();
            }
        } catch (e) {
            // Quiet failure
        }
    }

    save() {
        this.saveLocal();
        this.saveToMongo();
    }

    saveLocal() {
        try {
            const serialized = JSON.stringify(this.data, (key, value) => 
                typeof value === 'bigint' ? value.toString() : value, 
            2);
            fs.writeFileSync(this.filePath, serialized, 'utf-8');
        } catch (error) {
            console.error(`Failed to save database: ${this.filePath}`, error);
        }
    }

    async saveToMongo() {
        try {
            const db = await getMongoDb();
            if (!db) return;

            const colName = this.filePath.split(/[\\/]/).pop().replace('.json', '');
            const collection = db.collection(colName);
            
            const serialized = JSON.stringify(this.data, (key, value) => 
                typeof value === 'bigint' ? value.toString() : value
            );

            await collection.updateOne(
                { _id: 'main_data' },
                { $set: { data: serialized } },
                { upsert: true }
            );
        } catch (e) {
            // Quiet failure
        }
    }

    get(key) {
        return this.data[key];
    }

    set(key, value) {
        this.data[key] = value;
        this.save();
    }

    delete(key) {
        delete this.data[key];
        this.save();
    }

    all() {
        return this.data;
    }
}

// Instantiate cache, log, and settings databases
const messageCache = new JSONDatabase('cache.json');
const chatLogs = new JSONDatabase('chat_logs.json');
const userSettings = new JSONDatabase('user_settings.json');
const autoReplies = new JSONDatabase('auto_replies.json');
const viewOnceCache = new JSONDatabase('view_once_cache.json');

/**
 * Clean up cached messages older than 24 hours to prevent file bloat
 */
function cleanExpiredCache() {
    const cacheData = messageCache.all();
    const voCacheData = viewOnceCache.all();
    const now = Date.now();
    const expiryTime = 24 * 60 * 60 * 1000; // 24 Hours
    let changed = false;
    let voChanged = false;

    for (const key in cacheData) {
        if (now - cacheData[key].timestamp > expiryTime) {
            delete cacheData[key];
            changed = true;
        }
    }

    for (const key in voCacheData) {
        if (now - voCacheData[key].timestamp > expiryTime) {
            // Also delete physical file if it exists
            const fileInfo = voCacheData[key];
            if (fileInfo && fileInfo.filePath && fs.existsSync(fileInfo.filePath)) {
                try {
                    fs.unlinkSync(fileInfo.filePath);
                } catch (e) {
                    console.error('Failed to delete physical view-once file:', e);
                }
            }
            delete voCacheData[key];
            voChanged = true;
        }
    }

    if (changed) {
        messageCache.save();
        console.log('Expired message cache entries cleared.');
    }
    if (voChanged) {
        viewOnceCache.save();
        console.log('Expired view-once cache entries cleared.');
    }
}

// Run cleanup every 1 hour
setInterval(cleanExpiredCache, 60 * 60 * 1000);

module.exports = {
    messageCache,
    chatLogs,
    userSettings,
    autoReplies,
    viewOnceCache,
    cleanExpiredCache
};
