const WebSocket = require('ws');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { encode, decode } = require('@msgpack/msgpack'); // <--- ADD THIS
require('dotenv').config(); // <--- ADD THIS LINE TO READ THE .ENV FILE
const express = require('express');
const http = require('http');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Global RAM for Squad Chats (Ultra-fast, ephemeral)
const SQUAD_CHATS_RAM = {};
// --- DATABASE CONNECTION ---
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI, { family: 4 })
    .then(async () => {
        console.log('🔥 Connected to MongoDB!');

        // 🛑 EL FIX: Cargar la Playlist de MongoDB a la RAM
        let config = await ServerConfig.findOne();
        if (!config) {
            // Si es la primera vez que prendes el server, crea el documento base
            config = new ServerConfig({ bgmPlaylist: ["audio/music/track1.mp3"] }); // Pon la ruta real que tengas en Github luego
            await config.save();
        }
        GLOBAL_BGM_PLAYLIST = config.bgmPlaylist;

        loadTilesetsFromDB();
        loadWorldMapFromDB();
        loadZoneConfigsFromDB();
        loadSafeZonesFromDB();
        loadSkeletonFromDB();
        loadArenasFromDB();
        loadRanksFromDB();
        loadPatchNotesFromDB();
        // 🛑 EL FIX: Solo llamamos al Catálogo Maestro. 
        // Ya no cargamos Weapons ni Trash por separado.
        loadMasterCatalog();
        loadTasksFromDB();
        loadArgemPackagesFromDB();
    })
    .catch(err => console.error('MongoDB Connection Error:', err));

const tileSchema = new mongoose.Schema({
    x: Number,
    y: Number,
    l: { type: Number, default: 0 },
    tileId: Number,
    hasCollision: { type: Boolean, default: false },
    isSit: { type: Boolean, default: false },
    triggerType: String,
    destX: Number,
    destY: Number,
    itemId: String,
    rotation: { type: Number, default: 0 },
    requiresClick: { type: Boolean, default: false },
    npcMessage: { type: String, default: "" },

    // 👇 NUEVO: FILA DE LA IMAGEN DE LA TIENDA 👇
    itemRow: { type: Number, default: 0 },
    shelfX: { type: Number, default: 0 },
    shelfY: { type: Number, default: 0 }
});

const Tile = mongoose.model('Tile', tileSchema);

const blueprintSchema = new mongoose.Schema({
    name: { type: String, required: true },
    w: { type: Number, required: true },
    h: { type: Number, required: true },
    isMultiLayer: { type: Boolean, default: true },
    multiTiles: [{
        x: Number, y: Number, l: Number, tileId: Number,
        hasCollision: Boolean, isSit: Boolean, triggerType: String,
        destX: Number, destY: Number, itemId: Number, rotation: Number
    }]
});
const Blueprint = mongoose.model('Blueprint', blueprintSchema);

// --- ESQUEMA DE MINIJUEGOS Y ARENAS (ESCALABLE) ---
const arenaSchema = new mongoose.Schema({
    arenaId: { type: String, required: true, unique: true },
    name: { type: String, default: "Arena" },
    gameType: { type: String, default: "spar" }, // 'spar', 'soccer', 'hide_seek', 'battle_royale'

    // Spawn points para juegos de 2 equipos (Spar, Soccer)
    p1X: { type: Number },
    p1Y: { type: Number },
    p2X: { type: Number },
    p2Y: { type: Number },

    // Configuraciones extra (Zonas de spawn aleatorias, props, tiempos)
    config: { type: Object, default: {} },

    team1Size: { type: Number, default: 1 },
    team2Size: { type: Number, default: 1 },
    maxPlayers: { type: Number, default: 2 }, // Útil para Battle Royale o Hide & Seek
    isRanked: { type: Boolean, default: false }
});
const Arena = mongoose.model('Arena', arenaSchema);
// Memoria RAM ultra-rápida para manejar las colas y juegos en vivo
let arenasRAM = {};

const turfSchema = new mongoose.Schema({
    turfId: { type: String, required: true, unique: true },
    name: { type: String, default: "Base Central" },
    hp: { type: Number, default: 5000 },
    maxHp: { type: Number, default: 5000 },
    ownerSquadName: { type: String, default: null },
    srcIdle: { type: String, default: "" },
    srcHit: { type: String, default: "" },
    spriteOffsetX: { type: Number, default: 0 },
    spriteOffsetY: { type: Number, default: 0 },
    hitboxOffsetX: { type: Number, default: 0 },
    hitboxOffsetY: { type: Number, default: 0 },
    // 👇 NUEVO: ANCHO Y ALTO DEL CUADRADO FÍSICO 👇
    hitboxW: { type: Number, default: 32 },
    hitboxH: { type: Number, default: 32 }
});
const Turf = mongoose.model('Turf', turfSchema);

// --- ESQUEMA UNIVERSAL DE ZONAS (VECTORES) ---
const safeZoneSchema = new mongoose.Schema({
    name: { type: String, required: true },
    zoneType: { type: String, default: 'safe' }, // 'safe', 'trash', 'turf', etc.
    xMin: { type: Number, required: true },
    xMax: { type: Number, required: true },
    yMin: { type: Number, required: true },
    yMax: { type: Number, required: true },
    // 🏴 TURF: punto de spawn al que van los que mueren dentro de esta zona
    spawnX: { type: Number, default: null },
    spawnY: { type: Number, default: null }
});
const SafeZone = mongoose.model('SafeZone', safeZoneSchema);

let safeZonesRAM = []; // Caché ultrarrápida (Guarda todas las zonas de todos los tipos)

async function loadSafeZonesFromDB() {
    try {
        const rawZones = await SafeZone.find({}).lean();
        // ⚡ Convert the complex ObjectId into a pure String for MessagePack
        safeZonesRAM = rawZones.map(z => ({ ...z, _id: z._id.toString() }));
        console.log(`🗺️ Zonas Universales cargadas en RAM (${safeZonesRAM.length} zonas).`);
    } catch (err) { console.error("Error cargando Zonas:", err); }
}

// --- ESCÁNER MATEMÁTICO: ¿ESTOY EN UNA ZONA SEGURA? ---
function isInSafeZone(px, py) {
    for (let i = 0; i < safeZonesRAM.length; i++) {
        let z = safeZonesRAM[i];
        // 🛑 EL FIX: Solo nos protege si la zona es específicamente de tipo 'safe'
        if ((z.zoneType === 'safe' || !z.zoneType) && px >= z.xMin && px <= z.xMax && py >= z.yMin && py <= z.yMax) {
            return true;
        }
    }
    return false;
}

// ==========================================
// 🏆 ESQUEMA DE RANGOS ELO (MONGODB)
// ==========================================
const rankSchema = new mongoose.Schema({
    name: { type: String, required: true },
    minElo: { type: Number, required: true },
    src: { type: String, required: true } // La imagen 32x48
});
const Rank = mongoose.model('Rank', rankSchema);

let RANKS_CACHE = []; // RAM Cache

async function loadRanksFromDB() {
    try {
        let ranks = await Rank.find({}, { _id: 0, __v: 0 }).sort({ minElo: -1 }).lean();

        if (ranks.length === 0) {
            console.log("🏆 Inicializando Rangos por defecto en MongoDB...");
            const defaultRanks = [
                { name: "Elite", minElo: 2500, src: "items/ranks/elite.png" },
                { name: "Profesional", minElo: 1800, src: "items/ranks/profesional.png" },
                { name: "Amateur", minElo: 1200, src: "items/ranks/amateur.png" },
                { name: "Novato", minElo: 600, src: "items/ranks/novato.png" },
                { name: "Principiante", minElo: 0, src: "items/ranks/principiante.png" }
            ];
            await Rank.insertMany(defaultRanks);
            ranks = await Rank.find({}, { _id: 0, __v: 0 }).sort({ minElo: -1 }).lean();
        }
        RANKS_CACHE = ranks;
        console.log(`🏆 Rangos cargados: ${RANKS_CACHE.length} divisiones activas.`);
    } catch (err) { console.error("Error cargando Rangos:", err); }
}

// ==========================================
// 🗺️ ESQUEMA DE CONFIGURACIÓN DE ZONAS (MONGODB)
// ==========================================
const zoneConfigSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true }, // ej: 'safe', 'trash', 'npc'
    name: { type: String, required: true },
    icon: { type: String, default: "❓" },
    colorBorder: { type: String, default: "white" },
    colorFill: { type: String, default: "rgba(255,255,255,0.2)" }
});

const ZoneConfig = mongoose.model('ZoneConfig', zoneConfigSchema);

// Memoria RAM para consultas ultrarrápidas
let ZONE_CONFIG = {};

// Función para cargar desde la Base de Datos al iniciar el servidor
async function loadZoneConfigsFromDB() {
    try {
        let configs = await ZoneConfig.find({}, { _id: 0, __v: 0 }).lean();

        // Si la tabla está vacía, inyectamos los básicos
        if (configs.length === 0) {
            console.log("🛠️ Inicializando Tipos de Zona por defecto en MongoDB...");
            const defaultZones = [
                { id: "safe", name: "Zona Segura", icon: "🛡️", colorBorder: "rgba(46, 204, 113, 0.8)", colorFill: "rgba(46, 204, 113, 0.2)" },
                { id: "trash", name: "Basurero", icon: "🗑️", colorBorder: "rgba(230, 126, 34, 0.8)", colorFill: "rgba(230, 126, 34, 0.2)" },
                { id: "npc", name: "Zona NPC", icon: "🤖", colorBorder: "rgba(155, 89, 182, 0.8)", colorFill: "rgba(155, 89, 182, 0.2)" },
                { id: "dig", name: "Zona de Excavación", icon: "⛏️", colorBorder: "rgba(139, 69, 19, 0.8)", colorFill: "rgba(139, 69, 19, 0.2)" }
            ];
            await ZoneConfig.insertMany(defaultZones);
            configs = await ZoneConfig.find({}, { _id: 0, __v: 0 }).lean();
        }

        // 🛑 EL FIX: Si tu base de datos ya existía pero no tenía la zona "indoor", la inyectamos a la fuerza
        if (!configs.find(c => c.id === 'indoor')) {
            console.log("🏠 Añadiendo nueva zona de Techos a la base de datos...");
            await ZoneConfig.create({ id: "indoor", name: "Interior (Sin Lluvia)", icon: "🏠", colorBorder: "rgba(52, 152, 219, 0.8)", colorFill: "rgba(52, 152, 219, 0.2)" });
            configs = await ZoneConfig.find({}, { _id: 0, __v: 0 }).lean();
        }

        // 🏴 Inyectar zona Turf si no existe
        if (!configs.find(c => c.id === 'turf')) {
            console.log("🏴 Añadiendo zona Turf (Respawn personalizado) a la base de datos...");
            await ZoneConfig.create({ id: "turf", name: "Turf (Respawn)", icon: "🏴", colorBorder: "rgba(231, 76, 60, 0.9)", colorFill: "rgba(231, 76, 60, 0.15)" });
            configs = await ZoneConfig.find({}, { _id: 0, __v: 0 }).lean();
        }

        // Limpiar la RAM y llenarla con los datos de Mongo
        ZONE_CONFIG = {};
        configs.forEach(c => {
            ZONE_CONFIG[c.id] = { name: c.name, icon: c.icon, colorBorder: c.colorBorder, colorFill: c.colorFill };
        });

        console.log(`🎨 Tipos de Zona cargados en RAM (${Object.keys(ZONE_CONFIG).length} tipos).`);
    } catch (err) {
        console.error("❌ Error cargando Configuración de Zonas:", err);
    }
}

// --- HERRAMIENTA: ESCÁNER DE ZONAS SEGURAS ---
const SERVER_TILE_SIZE = 16;

// --- MODELO DEL ESQUELETO (GANI) ---
const skeletonSchema = new mongoose.Schema({
    anchors: { type: Object, default: {} },
    handTile: { type: Object, default: { x: 13, y: 0 } } // <--- NUEVO
});
const Skeleton = mongoose.model('Skeleton', skeletonSchema);

// Variable global en RAM
let skeletonRAM = {};


// --- CARGAR ANIMACIONES GANI AL INICIAR (CORREGIDO) ---
async function loadSkeletonFromDB() {
    try {
        // Buscamos el registro sin filtros innecesarios
        const skel = await Skeleton.findOne({}, { _id: 0, __v: 0 }).lean();
        if (skel && skel.anchors) {
            skeletonRAM = skel.anchors;
            console.log("✅ Animaciones Gani cargadas correctamente desde MongoDB!");
        } else {
            console.log("🦴 No hay animaciones previas, iniciando Gani en blanco.");
            skeletonRAM = {};
        }
    } catch (err) {
        console.error("❌ Error al cargar las animaciones Gani:", err);
    }
}

// --- ESQUEMA DE ACTUALIZACIONES (PATCH NOTES) ---
const patchNoteSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: { type: String, required: true },
    version: { type: String, default: "1.0" },
    date: { type: Date, default: Date.now }
});
const PatchNote = mongoose.model('PatchNote', patchNoteSchema);

// Memoria RAM para enviarlo rápido a los jugadores al conectar
let PATCH_NOTES_CACHE = [];

async function loadPatchNotesFromDB() {
    try {
        // Traemos las últimas 10 actualizaciones ordenadas de la más nueva a la más vieja
        PATCH_NOTES_CACHE = await PatchNote.find({}, { _id: 0, __v: 0 }).sort({ date: -1 }).limit(10).lean();
        // Si está vacía, creamos una de bienvenida automáticamente
        if (PATCH_NOTES_CACHE.length === 0) {
            const welcomeNote = new PatchNote({
                title: "¡Bienvenidos a MMOARGON!",
                description: "El servidor alfa está oficialmente en línea. Explora el mapa, únete a un clan y domina la ciudad.",
                version: "1.0.0"
            });
            await welcomeNote.save();
            PATCH_NOTES_CACHE = [welcomeNote];
        }
        console.log(`📰 Noticias cargadas: ${PATCH_NOTES_CACHE.length} parches encontrados.`);
    } catch (err) {
        console.error("Error cargando Patch Notes:", err);
    }
}

// --- THE TASK (ACHIEVEMENTS) BLUEPRINT ---
const taskSchema = new mongoose.Schema({
    taskId: { type: String, required: true, unique: true }, // e.g., 'daily_login', 'squad_10_hours'
    title: { type: String, required: true },
    description: { type: String },

    category: { type: String, enum: ['daily', 'squad', 'milestone', 'event'], default: 'daily' },
    requirementType: { type: String, enum: ['login', 'play_hours', 'kills', 'elo'], default: 'login' },
    requirementValue: { type: Number, required: true },

    rewardType: { type: String, enum: ['coins', 'item'], default: 'coins' },
    rewardValue: { type: mongoose.Schema.Types.Mixed, required: true },

    isRepeatable: { type: Boolean, default: false },
    resetIntervalMs: { type: Number, default: 0 } // 86400000 for daily
});
const Task = mongoose.model('Task', taskSchema);

// --- THE PLAYER BLUEPRINT (SCHEMA) ---
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    password: { type: String, required: true },
    token: { type: String, default: "" },
    worldX: { type: Number, default: 0 },
    worldY: { type: Number, default: 0 },

    inventory: { type: [mongoose.Schema.Types.Mixed], default: [] },
    equippedWeapon: { type: String, default: "none" },
    hotbar: { type: Array, default: ["none", "none", "none"] },
    quickSwaps: { type: Array, default: [] },
    equipped: { // 👕 EL WARDROBE
        hands: { type: String, default: 'none' },
        head: { type: String, default: 'head_default' },
        body: { type: String, default: 'body_default' },
        hat: { type: String, default: 'none' } // 🎩 NUEVO: Espacio para sombreros
    },
    friends: { type: Array, default: [] },

    // --- NUEVO: SISTEMA DE ECONOMÍA ---
    coins: { type: Number, default: 0 },
    gems: { type: Number, default: 0 }, // Argems Premium Currency
    // 👇 NUEVO: ESTADÍSTICAS DE COMBATE 👇
    elo: { type: Number, default: 1000 },
    kills: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    // 👇 NUEVO: GUARDADO DE SALUD (ANTI-COMBAT LOGGING) 👇
    hp: { type: Number, default: 100 },
    isDead: { type: Boolean, default: false },
    // --- NUEVO: SISTEMA DE ROLES ---
    role: { type: String, default: 'player' }, // Todos nacen como 'player' por defecto, pero podrías tener 'admin', 'moderator', etc. y manejar permisos en el futuro.
    // --- NUEVO: IDENTIFICADOR ÚNICO (EJ: A1000) ---
    gameId: { type: String, unique: true },
    // --- NUEVO: TUTORIAL ---
    hasSeenTutorial: { type: Boolean, default: false },
    // ... tus otros campos (coins, friends, etc)
    squad: { type: mongoose.Schema.Types.ObjectId, ref: 'Squad', default: null }, // <--- NUEVO

    // --- NUEVO: SISTEMA DE TAREAS Y LOGROS ---
    taskProgress: { type: mongoose.Schema.Types.Mixed, default: {} },
    claimedTasks: { type: mongoose.Schema.Types.Mixed, default: {} }
});

const User = mongoose.model('User', userSchema);

// --- NUEVO: CONTADOR GLOBAL PARA IDs ÚNICOS (EJ: A1000) ---
const counterSchema = new mongoose.Schema({
    id: { type: String, required: true },
    seq: { type: Number, default: 1000 }
});
const Counter = mongoose.model('Counter', counterSchema);

// --- NUEVO: SISTEMA DE FEEDBACK ---
const feedbackSchema = new mongoose.Schema({
    gameId: { type: String, required: true },
    category: { type: String, default: 'Ideas' }, // 'Ideas', 'Bugs & Errors', 'Help'
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    status: { type: String, default: 'pending' } // 'pending', 'reviewed', 'rewarded'
});
const Feedback = mongoose.model('Feedback', feedbackSchema);



// --- ESQUEMA DE LOS SQUADS (CLANES) ---

// Sub-esquema para definir qué puede hacer cada miembro
const squadMemberSchema = new mongoose.Schema({
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    customTitle: { type: String, default: 'Miembro' }, // Aquí va "Comandante", "Reclutador", etc.

    // Los permisos granulares que pediste
    canInvite: { type: Boolean, default: false },      // Puede contratar personal
    canKick: { type: Boolean, default: false },        // Puede sacar personal
    canAssignRoles: { type: Boolean, default: false },  // Puede dar atributos a otros (Full Admin)
    joinedAt: { type: Date, default: Date.now }        // Anti-cheat para recompensas de clan
}, { _id: false }); // _id: false evita que MongoDB le cree un ID extra a cada fila del arreglo

// El esquema principal del Squad
const squadSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true, // ¡Garantiza que no haya dos nombres iguales!
        maxLength: 20 // Para que el nombre no ocupe toda la pantalla
    },
    leader: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // 👇 NUEVO CAMPO PARA EL LOGO 👇
    logo: { type: String, default: "" },
    // Arreglo de miembros (Excluyendo al líder). Controlaremos el límite de 24 en el código.
    members: [squadMemberSchema],

    createdAt: { type: Date, default: Date.now },
    // 👇 NUEVO: CAMPO PARA EL RANKING GLOBAL DE INFAMIA 👇
    territoryTimeMinutes: { type: Number, default: 0 },
    // 👇 NUEVOS CAMPOS PARA LOS RANKINGS ROTATIVOS 👇
    dailyTimeMinutes: { type: Number, default: 0 },
    weeklyTimeMinutes: { type: Number, default: 0 },
    // NUEVO: SEGUIMIENTO DE CUANDO SE ALCANZAN LAS METAS (ANTI-CHEAT)
    milestonesAchieved: { type: Map, of: Date, default: {} }
});

const Squad = mongoose.model('Squad', squadSchema);

// ==========================================
// CONFIGURACIÓN GLOBAL DEL SERVIDOR (MUSIC, ETC)
// ==========================================
const serverConfigSchema = new mongoose.Schema({
    bgmPlaylist: { type: [String], default: [] }
});
const ServerConfig = mongoose.model('ServerConfig', serverConfigSchema);

let GLOBAL_BGM_PLAYLIST = []; // Memoria RAM ultrarrápida

// ==========================================
// 📦 TABLA MAESTRA DE ÍTEMS (MASTER CATALOG)
// ==========================================
const itemSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    category: { type: String, required: true },
    name: { type: String, required: true },
    src: { type: String, required: true },
    price: { type: Number, default: 0 },
    stats: { type: Object, default: {} },
    drawConfig: { type: Object, default: {} },

    // 🔊 NUEVO: DICCIONARIO DE AUDIO
    audio: {
        type: Object,
        default: {
            use: null,     // Sonido al usar/disparar/swing
            reload: null,  // Sonido de recarga
            equip: null    // Sonido genérico al equiparlo en la mano
        }
    }
});

const Item = mongoose.model('Item', itemSchema);

// --- 🌟 NUEVO: TAREAS Y LOGROS GLOBALES 🌟 ---
// --- NUEVO: ARGEMS PREMIUM PACKAGES ---
const argemPackageSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    gemsAmount: { type: Number, required: true },
    priceString: { type: String, required: true },
    priceCents: { type: Number, required: true },
    badge: { type: String, default: "" },
    color: { type: String, default: "#9b59b6" }
});
const ArgemPackage = mongoose.model('ArgemPackage', argemPackageSchema);

let ARGEM_PACKAGES = []; // Cached in RAM

async function loadArgemPackagesFromDB() {
    try {
        const packages = await ArgemPackage.find({}).sort({ priceCents: 1 }).lean();
        if (packages.length === 0) {
            const defaultPackages = [
                { id: 'argems_500', title: 'Handful of Argems', gemsAmount: 500, priceString: '$4.99', priceCents: 499, color: '#3498db' },
                { id: 'argems_1200', title: 'Pouch of Argems', gemsAmount: 1200, priceString: '$9.99', priceCents: 999, badge: 'Best Value!', color: '#9b59b6' },
                { id: 'argems_2500', title: 'Chest of Argems', gemsAmount: 2500, priceString: '$19.99', priceCents: 1999, color: '#e67e22' },
                { id: 'argems_6500', title: 'Vault of Argems', gemsAmount: 6500, priceString: '$49.99', priceCents: 4999, badge: 'Mega Vault!', color: '#f1c40f' }
            ];
            await ArgemPackage.insertMany(defaultPackages);
            ARGEM_PACKAGES = defaultPackages;
            console.log('💎 Argem Packages seeded into MongoDB.');
        } else {
            ARGEM_PACKAGES = packages;
        }
    } catch (e) {
        console.error("Error loading Argem packages:", e);
    }
}

let GLOBAL_TASKS = {};
async function loadTasksFromDB() {
    try {
        const tasks = await Task.find({}).lean();
        if (tasks.length === 0) {
            // Inyectar tareas por defecto si la base de datos está vacía
            const defaultTasks = [
                {
                    taskId: 'daily_login',
                    title: 'Daily Login Bonus',
                    description: 'Log in to the game to receive your daily coins.',
                    category: 'daily',
                    requirementType: 'login',
                    requirementValue: 1,
                    rewardType: 'coins',
                    rewardValue: 500,
                    isRepeatable: true,
                    resetIntervalMs: 86400000 // 24 hours
                },
                {
                    taskId: 'first_blood',
                    title: 'First Blood',
                    description: 'Get your first kill in the game.',
                    category: 'milestone',
                    requirementType: 'kills',
                    requirementValue: 1,
                    rewardType: 'item',
                    rewardValue: 'head_default', // Example item reward
                    isRepeatable: false,
                    resetIntervalMs: 0
                },
                {
                    taskId: 'squad_base_10h',
                    title: 'Warlords of Argon',
                    description: 'Your squad has held the Central Base for 10 accumulated hours.',
                    category: 'squad',
                    requirementType: 'squad_base_minutes',
                    requirementValue: 600, // 600 minutes = 10 hours
                    rewardType: 'coins',
                    rewardValue: 5000,
                    isRepeatable: false,
                    resetIntervalMs: 0
                }
            ];
            await Task.insertMany(defaultTasks);
            defaultTasks.forEach(t => GLOBAL_TASKS[t.taskId] = t);
            console.log("Injected default tasks.");
        } else {
            GLOBAL_TASKS = {};
            tasks.forEach(t => GLOBAL_TASKS[t.taskId] = t);
            console.log(`Loaded ${tasks.length} tasks from DB.`);
        }

        // --- INICIALIZAR METAS LEGACY PARA SQUADS EXISTENTES ---
        try {
            const allSquads = await Squad.find({});
            let modified = 0;
            const now = Date.now();
            for (let sq of allSquads) {
                let changed = false;
                if (!sq.milestonesAchieved) sq.milestonesAchieved = new Map();
                for (let taskId in GLOBAL_TASKS) {
                    const task = GLOBAL_TASKS[taskId];
                    if (task.requirementType === 'squad_base_minutes') {
                        if (sq.territoryTimeMinutes >= task.requirementValue && !sq.milestonesAchieved.has(taskId)) {
                            sq.milestonesAchieved.set(taskId, now);
                            changed = true;
                        }
                    }
                }
                if (changed) {
                    await sq.save();
                    modified++;
                }
            }
            console.log(`Initialized legacy milestones for ${modified} squads.`);
        } catch (err) { console.error("Error initializing legacy milestones:", err); }

    } catch (err) { console.error("Error loading tasks:", err); }
}

let MASTER_CATALOG = {};
let WEAPONS = {};
let TRASH_CATALOG = [];
let METALS_CATALOG = []; // <--- ⛏️ ¡AQUÍ ESTÁ LA LÍNEA QUE FALTABA!



async function loadMasterCatalog() {
    try {
        console.log("📦 Cargando Catálogo Maestro...");

        // 1. Solo deja activos los que sean "Esenciales" o nuevos.
        // Si ya ajustaste la Katana en Compass, puedes comentar su 'findOneAndUpdate' 
        // para que el servidor solo la LEA de la DB y no intente re-escribirla.

        /* await Item.findOneAndUpdate({ id: "katana_azulado" }, { ... }, { upsert: true }); 
        */

        // ⚡ ADD { _id: 0, __v: 0 } PROJECTION:
        const items = await Item.find({}, { _id: 0, __v: 0 }).lean();

        MASTER_CATALOG = {};
        WEAPONS = {};
        TRASH_CATALOG = [];
        METALS_CATALOG = [];

        items.forEach(i => {
            MASTER_CATALOG[i.id] = i;
            // ⚡ REMOVE the .toObject() calls because .lean() already made them raw objects!
            if (i.category === 'weapon') {
                WEAPONS[i.id] = { ...i, ...i.stats };
            } else if (i.category === 'junk') {
                TRASH_CATALOG.push({ ...i, ...i.drawConfig, value: i.price });
            } else if (i.category === 'metal') {
                METALS_CATALOG.push({ ...i, ...i.drawConfig, value: i.price });
            }
        });

        // Failsafe para evitar crashes
        if (!WEAPONS["none"]) WEAPONS["none"] = { damage: 0, type: "none", pivotX: 0, pivotY: 0 };

        console.log(`✅ Catálogo cargado: ${Object.keys(MASTER_CATALOG).length} ítems listos.`);
    } catch (err) {
        console.error("💥 Error cargando el Catálogo:", err);
    }
}

// --- EL ESQUEMA DE LOS TILESETS ---
const tilesetSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    name: String,
    src: String,
    startId: Number
});
const Tileset = mongoose.model('Tileset', tilesetSchema);

let TILESETS = []; // Caché en RAM para los tilesets

async function loadTilesetsFromDB() {
    try {
        const dbTilesets = await Tileset.find({}, { _id: 0, __v: 0 }).sort({ startId: 1 }).lean();

        if (dbTilesets.length === 0) {
            console.log('📦 Migrando TILESET_CONFIG a MongoDB por primera vez...');

            // --- 0. MULTI-TILESET SYSTEM (GLOBAL IDs) ---
            const defaultTilesets = [];

            await Tileset.insertMany(defaultTilesets);
            TILESETS = await Tileset.find({}, { _id: 0, __v: 0 }).sort({ startId: 1 }).lean();
            console.log('✅ ¡60 Tilesets migrados a MongoDB exitosamente!');
        } else {
            TILESETS = dbTilesets;
            console.log(`✅ Base de datos de Tilesets cargada en RAM (${TILESETS.length} tilesets)`);
        }
    } catch (err) { console.error("Error cargando tilesets:", err); }
}

// --- LA NUEVA MEMORIA FÍSICA DEL SERVIDOR ---
let serverWorldMap = {}; // Aquí el servidor recordará dónde están las paredes y puertas

// 💥 NUEVO: EL CEREBRO DE LA BASE CENTRAL 💥
let centralBase = null;

async function loadWorldMapFromDB() {
    try {
        // 2. FETCH WORLD DATA
        const allTiles = await Tile.find({}, { _id: 0, __v: 0 }).lean();

        // Reiniciamos la base por si acaso recargamos el mapa
        centralBase = null;

        allTiles.forEach(t => {
            const l = t.l || 0;
            serverWorldMap[`${t.x},${t.y},${l}`] = {
                tileId: t.tileId,
                hasCollision: t.hasCollision || false,
                isSit: t.isSit || false,
                triggerType: t.triggerType,
                destX: t.destX,
                destY: t.destY,
                itemId: t.itemId,
                itemRow: t.itemRow || 0, // <--- AÑADE ESTO
                shelfX: t.shelfX || 0,
                shelfY: t.shelfY || 0
            };

            // 🛑 EL FIX: Detectar la Base y conectarla con su persistencia
            if (t.triggerType === 'base') {
                // Creamos un ID único basado en dónde pusiste el bloque
                const uniqueTurfId = `base_${t.x}_${t.y}`;

                // Buscamos si ya existe en la base de datos (await se usa dentro de una función asíncrona, 
                // así que cambiaremos el forEach por un for...of o manejaremos la promesa).

                // Como allTiles.forEach no maneja bien await, lo guardamos temporalmente
                // y lo inicializamos justo después del forEach.
                centralBase = {
                    turfId: uniqueTurfId,
                    gridX: t.x, gridY: t.y,
                    worldX: (t.x * 16) + 8, worldY: (t.y * 16) + 8,
                    hp: 5000, maxHp: 5000,
                    currentOwnerSquadId: null,
                    damageTracker: {}
                };
            }
        });
        // --- RECUPERAR DATOS DE LA BASE DESDE MONGODB ---
        // --- RECUPERAR DATOS DE LA BASE DESDE MONGODB ---
        if (centralBase) {
            let dbTurf = await Turf.findOne({ turfId: centralBase.turfId });

            // Si es la primera vez que ponemos la base, la creamos en MongoDB
            if (!dbTurf) {
                dbTurf = await Turf.create({
                    turfId: centralBase.turfId,
                    name: "Base Central",
                    hp: 5000, maxHp: 5000,
                    // Valores por defecto para una base nueva
                    hitboxW: 32,
                    hitboxH: 32
                });
            }

            // Inyectamos los datos persistentes a la memoria RAM
            centralBase.name = dbTurf.name;
            centralBase.hp = dbTurf.hp;
            centralBase.maxHp = dbTurf.maxHp;
            centralBase.currentOwnerSquadId = dbTurf.ownerSquadName;
            centralBase.srcIdle = dbTurf.srcIdle || "";
            centralBase.srcHit = dbTurf.srcHit || "";
            centralBase.spriteOffsetX = dbTurf.spriteOffsetX || 0;
            centralBase.spriteOffsetY = dbTurf.spriteOffsetY || 0;
            centralBase.hitboxOffsetX = dbTurf.hitboxOffsetX || 0;
            centralBase.hitboxOffsetY = dbTurf.hitboxOffsetY || 0;

            // 👇 NUEVO: CARGAMOS EL ANCHO Y ALTO DEL HITBOX A LA RAM 👇
            centralBase.hitboxW = dbTurf.hitboxW || 32;
            centralBase.hitboxH = dbTurf.hitboxH || 32;

            centralBase.lastHitTime = centralBase.lastHitTime || 0;
            // Mantenemos el damageTracker vacío al reiniciar el servidor
            centralBase.damageTracker = {};

            console.log(`🏰 [${centralBase.name}] cargada en RAM. Dueño actual: ${centralBase.currentOwnerSquadId || 'Nadie'}. Hitbox: ${centralBase.hitboxW}x${centralBase.hitboxH}`);
        }
        console.log(`🌍 Mapa Físico cargado en RAM del servidor (${allTiles.length} bloques).`);
    } catch (err) {
        console.error("Error cargando el mapa:", err);
    }
}

// --- CARGAR ARENAS EN LA RAM AL INICIAR EL SERVIDOR ---
async function loadArenasFromDB() {
    try {
        const allArenas = await Arena.find({});
        arenasRAM = {}; // Limpiamos por si acaso

        allArenas.forEach(a => {
            arenasRAM[a.arenaId] = {
                arenaId: a.arenaId,
                name: a.name,
                gameType: a.gameType || "spar",
                p1X: a.p1X || 0, p1Y: a.p1Y || 0,
                p2X: a.p2X || 0, p2Y: a.p2Y || 0,
                config: a.config || {},
                team1Size: a.team1Size || 1,
                team2Size: a.team2Size || 1,
                maxPlayers: a.maxPlayers || 2,
                queue: [], // Inician vacías al reiniciar el server
                isOccupied: false,
                team1: [],
                team2: [],
                isRanked: a.isRanked || false,
                aliveTeam1: 0,
                aliveTeam2: 0,
                doorX: parseInt(a.arenaId.split('_')[1]) || 0,
                doorY: parseInt(a.arenaId.split('_')[2]) || 0,
                ball: a.gameType === 'soccer' ? {
                    x: (a.config?.ballX || 0) * 16,
                    y: (a.config?.ballY || 0) * 16,
                    vx: 0,
                    vy: 0,
                    spawnX: (a.config?.ballX || 0) * 16,
                    spawnY: (a.config?.ballY || 0) * 16,
                    goal1X1: (a.config?.goal1X1 || 0) * 16,
                    goal1X2: (a.config?.goal1X2 || 0) * 16,
                    goal1Y: (a.config?.goal1Y || 0) * 16,
                    goal2X1: (a.config?.goal2X1 || 0) * 16,
                    goal2X2: (a.config?.goal2X2 || 0) * 16,
                    goal2Y: (a.config?.goal2Y || 0) * 16,
                    score1: 0,
                    score2: 0
                } : null
            };
        });
        console.log(`🥊 Arenas cargadas en RAM: ${allArenas.length} arenas activas.`);
    } catch (err) {
        console.error("Error cargando Arenas:", err);
    }
}

// Función que usaremos para detectar hackers traspasando paredes
const TILE_SIZE = 16;
function serverCheckCollision(x, y) {
    const hitX = 5;
    const hitY = 5;
    const offsetY = 3;
    // 👇 NUEVO: HACER LA BASE SÓLIDA (CUADRADO EXACTO) 👇
    if (centralBase) {
        const bx = centralBase.worldX + (centralBase.hitboxOffsetX || 0);
        const by = centralBase.worldY + (centralBase.hitboxOffsetY || 0);
        const hw = (centralBase.hitboxW || 32) / 2;
        const hh = (centralBase.hitboxH || 32) / 2;

        // Función para ver si un punto entra en el rectángulo
        const isInsideRect = (px, py) => (px >= bx - hw && px <= bx + hw && py >= by - hh && py <= by + hh);

        // Si alguna de las 4 esquinas del jugador toca el rectángulo, choca
        if (isInsideRect(x - hitX, y - hitY + offsetY) ||
            isInsideRect(x + hitX, y - hitY + offsetY) ||
            isInsideRect(x - hitX, y + hitY + offsetY) ||
            isInsideRect(x + hitX, y + hitY + offsetY)) {
            return true;
        }
    }
    const checkWall = (cx, cy) => {
        const gx = Math.floor(cx / TILE_SIZE);
        const gy = Math.floor(cy / TILE_SIZE);
        // Escaneamos las 16 capas buscando colisiones
        for (let l = 0; l <= 15; l++) {
            if (serverWorldMap[`${gx},${gy},${l}`] && serverWorldMap[`${gx},${gy},${l}`].hasCollision) return true;
        }
        return false;
    };

    return checkWall(x - hitX, y - hitY + offsetY) ||
        checkWall(x + hitX, y - hitY + offsetY) ||
        checkWall(x - hitX, y + hitY + offsetY) ||
        checkWall(x + hitX, y + hitY + offsetY);
}
// 👆 HASTA AQUÍ 👆

// --- ESQUEMA DE MENSAJES PRIVADOS (AHORA POR ID) ---
const pmSchema = new mongoose.Schema({
    participants: [String], // Array con los 2 accountIds (IDs de MongoDB)
    messages: [{
        senderId: String,   // accountId del que envía
        text: String,
        timestamp: { type: Date, default: Date.now }
    }]
});
const PM = mongoose.model('PM', pmSchema);

// Use the port Render gives us, or default to 8080 for local testing
const PORT = process.env.PORT || 8080;
const app = express();

// Stripe Webhook MUST use express.raw to preserve the raw body for signature verification
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error("⚠️ Stripe Webhook Error:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the checkout session completed event
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const email = session.metadata.email;
        const packageId = session.metadata.packageId;
        const gemsToAdd = parseInt(session.metadata.gemsAmount, 10);

        try {
            // Give gems to the user in the database
            const user = await User.findOneAndUpdate(
                { email: email },
                { $inc: { gems: gemsToAdd } },
                { new: true }
            );

            console.log(`💰 Stripe Webhook: Granted ${gemsToAdd} gems to ${email}`);

            // Find if the player is currently online to instantly update their game!
            for (let id in players) {
                if (players[id].username === user.username) {
                    players[id].gems = user.gems;
                    // Find their specific WebSocket connection
                    wss.clients.forEach(client => {
                        if (client.playerId === id && client.readyState === WebSocket.OPEN) {
                            client.send(encode({
                                type: 'gems_purchase_success',
                                newGems: user.gems,
                                message: `Payment Success! +${gemsToAdd} Argems!`
                            }));
                        }
                    });
                    break;
                }
            }
        } catch (e) {
            console.error("Error updating user gems from webhook:", e);
        }
    }

    res.json({ received: true });
});

// Serve frontend static files
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
// This object acts as the server's memory. It holds every player's current state.
const players = {};

// ==========================================
// 🗺️ SPATIAL PARTITIONING ENGINE (ANTI-LAG)
// ==========================================
// A chunk of 512x512 pixels (32x32 tiles) is perfect for a 2D MMO.
const CHUNK_SIZE = 512;

function getChunkId(x, y) {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    return `${cx},${cy}`;
}

// Gets the player's chunk + the 8 chunks surrounding them (3x3 grid)
function getVisibleChunks(chunkId) {
    if (!chunkId) return [];
    const [cx, cy] = chunkId.split(',').map(Number);
    return [
        `${cx - 1},${cy - 1}`, `${cx},${cy - 1}`, `${cx + 1},${cy - 1}`,
        `${cx - 1},${cy}`, `${cx},${cy}`, `${cx + 1},${cy}`,
        `${cx - 1},${cy + 1}`, `${cx},${cy + 1}`, `${cx + 1},${cy + 1}`
    ];
}

// ==========================================================
// 💥 SERVER-AUTHORITATIVE COMBAT ENGINE
// ==========================================================
let activeProjectiles = [];

function applyDamageToPlayer(targetId, shooterId, weaponId) {
    const shooter = players[shooterId];
    const target = players[targetId];
    if (!shooter || !target || target.isDead) return;

    if (shooter.isSparring && target.isSparring && shooter.currentArena === target.currentArena) {
        if (shooter.arenaTeam === target.arenaTeam) return;
    }

    const stats = WEAPONS[weaponId] || { damage: 10 };
    const now = Date.now();

    // 🥊 Squad protection bypassed during spar
    const bothSparring = shooter.isSparring && target.isSparring && shooter.currentArena === target.currentArena;
    if (!bothSparring && shooter.squad && target.squad && shooter.squad === target.squad) return;
    if (isInSafeZone(shooter.worldX, shooter.worldY) || isInSafeZone(target.worldX, target.worldY)) return;
    if (target.invulnerableUntil && now < target.invulnerableUntil) return;

    // 🛡️ 3. DAÑO AUTORITATIVO REAL
    const actualDamage = Number(stats.damage) || 10;
    target.hp = (Number(target.hp) || 100) - actualDamage;
    target.lastHitTime = Date.now();

    // 💥 KNOCKBACK
    let knockbackForce = 0;
    if (stats.dirStats) {
        const kbDir = stats.dirStats['0'] || stats.dirStats['1'] || stats.dirStats['2'] || stats.dirStats['3'] || {};
        knockbackForce = Number(kbDir.kb) || 0;
    }
    if (knockbackForce > 0 && !target.isDead) {
        const angle = Math.atan2(target.worldY - shooter.worldY, target.worldX - shooter.worldX);
        let stepForce = knockbackForce / 5;
        for (let i = 0; i < 5; i++) {
            let nextX = target.worldX + (Math.cos(angle) * stepForce);
            let nextY = target.worldY + (Math.sin(angle) * stepForce);
            if (!serverCheckCollision(nextX, nextY)) {
                target.worldX = nextX;
                target.worldY = nextY;
            } else break;
        }
        wss.clients.forEach(c => {
            if (c.playerId === targetId && c.readyState === WebSocket.OPEN) {
                c.send(encode({ type: 'force_position', x: target.worldX, y: target.worldY, reason: 'knockback' }));
            }
        });
        broadcast({ type: 'update', id: targetId, player: target });
    }

    // --- SISTEMA DE MUERTE ---
    if (target.hp <= 0) {
        target.hp = 0;
        target.isDead = true;
        shooter.kills = (shooter.kills || 0) + 1;
        target.losses = (target.losses || 0) + 1;

        if (target.isSparring && shooter.isSparring && target.currentArena === shooter.currentArena) {
            const arena = arenasRAM[target.currentArena];
            if (arena) {
                // Si es minijuego de Soccer, simplemente reviven al instante en sus bases
                if (arena.gameType === 'soccer') {
                    target.hp = 100;
                    target.isDead = false;
                    target.worldX = (target.arenaTeam === 1) ? (arena.p1X * 16) + 8 : (arena.p2X * 16) + 8;
                    target.worldY = (target.arenaTeam === 1) ? (arena.p1Y * 16) + 8 : (arena.p2Y * 16) + 8;
                    target.invulnerableUntil = Date.now() + 2000;

                    wss.clients.forEach(c => {
                        if (c.playerId === targetId && c.readyState === WebSocket.OPEN) {
                            c.send(encode({ type: 'force_position', x: target.worldX, y: target.worldY, reason: 'wall' }));
                        }
                    });

                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(encode({ type: 'hp_update', targetId: targetId, newHp: 100, damageDealt: actualDamage, isDead: false, respawnX: target.worldX, respawnY: target.worldY, shieldUntil: target.invulnerableUntil }));
                        }
                    });
                    return; // Terminamos aquí, no cerramos la arena ni contamos bajas
                }

                if (target.arenaTeam === 1) arena.aliveTeam1--;
                if (target.arenaTeam === 2) arena.aliveTeam2--;

                if (arena.aliveTeam1 <= 0 || arena.aliveTeam2 <= 0) {
                    const winningTeam = arena.aliveTeam1 <= 0 ? 2 : 1;
                    endArenaMatch(arena, winningTeam);
                } else {
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(encode({ type: 'hp_update', targetId: targetId, newHp: 0, damageDealt: actualDamage, isDead: true, shooterId: shooterId, shooterKills: shooter.kills, targetLosses: target.losses }));
                        }
                    });
                }
            }
        } else {
            const turfZone = safeZonesRAM.find(z => z.zoneType === 'turf' && z.spawnX != null && z.spawnY != null && target.worldX >= z.xMin && target.worldX <= z.xMax && target.worldY >= z.yMin && target.worldY <= z.yMax);
            setTimeout(() => {
                const p = players[targetId];
                if (p) {
                    p.hp = 100; p.isDead = false; p.lastHitTime = Date.now(); p.invulnerableUntil = Date.now() + 2000;
                    let respawnX = null, respawnY = null;
                    if (turfZone) { p.worldX = turfZone.spawnX; p.worldY = turfZone.spawnY; respawnX = turfZone.spawnX; respawnY = turfZone.spawnY; }
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(encode({ type: 'hp_update', targetId: targetId, newHp: 100, damageDealt: 0, isDead: false, respawnX, respawnY, shieldUntil: p.invulnerableUntil }));
                        }
                    });
                }
            }, 3000);
            broadcastToZone({ type: 'hp_update', targetId: targetId, newHp: target.hp, damageDealt: actualDamage, isDead: true, shooterId: shooterId, shooterKills: shooter.kills, targetLosses: target.losses }, target.chunkId);
        }
    } else {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(encode({ type: 'hp_update', targetId: targetId, newHp: target.hp, damageDealt: actualDamage, isDead: false, shooterId: shooterId, shooterKills: shooter.kills, targetLosses: target.losses }));
            }
        });
    }
}

// --- PROJECTILE PHYSICS LOOP ---
setInterval(() => {
    const dtScale = 33.3 / 16.666; // approx 2.0 frames per tick

    for (let i = activeProjectiles.length - 1; i >= 0; i--) {
        let p = activeProjectiles[i];
        p.x += p.vx * dtScale;
        p.y += p.vy * dtScale;
        p.life -= dtScale;

        if (p.life <= 0 || serverCheckCollision(p.x, p.y)) {
            activeProjectiles.splice(i, 1);
            continue;
        }

        let hitSomeone = false;
        for (let targetId in players) {
            let target = players[targetId];
            if (targetId === p.owner || target.isDead) continue;

            // ⚡ THE FIX: Increased from 14 to 22. 
            // Gives a margin of error for network latency so bullets that visually hit on client don't miss on server.
            const HITBOX_RADIUS = 22;
            if (Math.hypot(p.x - target.worldX, p.y - target.worldY) < HITBOX_RADIUS) {
                hitSomeone = true;
                applyDamageToPlayer(targetId, p.owner, p.weapon);
                break;
            }
        }

        if (hitSomeone) {
            activeProjectiles.splice(i, 1);
        }
    }
}, 33);
// ==========================================================

// The New Targeted Broadcast (AoI)
function broadcastToZone(data, targetChunkId, excludeWs = null) {
    if (!targetChunkId) return;
    if (data && data.player && data.player.invisibleEnabled) return; // Completely hide from zone broadcasts

    // ⚡ ENCODE ONCE, SEND TO MANY
    const payload = encode(data);
    const visibleChunks = getVisibleChunks(targetChunkId);

    wss.clients.forEach((client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN && client.playerId) {
            const targetPlayer = players[client.playerId];
            if (targetPlayer && visibleChunks.includes(targetPlayer.chunkId)) {
                client.send(payload);
            }
        }
    });
}

// --- WEBSOCKET LOGIC ---
wss.on('connection', async (ws) => {
    const id = Math.random().toString(36).substring(2, 9);
    ws.playerId = id; // <--- ¡AÑADE ESTA LÍNEA! Es crucial para encontrar a quién enviarle el PM.

    let isAuthenticated = false;
    // Generate a random guest name like "Guest_482"
    let currentUser = `Guest_${Math.floor(Math.random() * 1000)}`;

    // 1. INSTANTLY SPAWN THEM AS A GUEST
    players[id] = {
        username: currentUser,
        worldX: 0, worldY: 0,
        frameX: 0, frameY: 0,
        isMoving: false, message: "", messageTimer: 0, isTyping: false,

        // --- MEMORIA ANTI-CHEAT DEL SERVIDOR ---
        hp: 100,
        isDead: false,
        ammo: 8,
        weaponAmmo: {},
        lastShotTime: 0,
        isReloading: false,
        equipped: { head: 'head_default', body: 'body_default', hands: 'none' },
        chunkId: getChunkId(0, 0),

        // 🛑 EL FIX 1: ¡El servidor necesita saber que los invitados SÍ tienen la Ghost Gun!
        inventory: ["ghost_gun"],
        equippedWeapon: "ghost_gun"
    };

    ws.on('message', async (message) => {

        // --- 🛡️ ESCUDO ANTI-DDOS (RATE LIMITING) 🛡️ ---
        const now = Date.now();
        if (!ws.rateLimit) ws.rateLimit = { count: 0, lastReset: now };

        // Reiniciamos el contador cada segundo (1000 milisegundos)
        if (now - ws.rateLimit.lastReset > 1000) {
            ws.rateLimit.count = 0;
            ws.rateLimit.lastReset = now;
        }

        ws.rateLimit.count++;

        // Un jugador legal envía ~20 paquetes por segundo.
        // Si manda más de 40, está usando macros o lag switch. Lo ignoramos.
        if (ws.rateLimit.count > 40) {

            // Si el ataque es masivo (ej. un script malicioso enviando 100+), le cortamos el cable.
            if (ws.rateLimit.count > 100) {
                console.warn(`[ANTI-DDOS] Desconectando atacante por spam masivo.`);
                ws.close(); // Lo pateamos del servidor instantáneamente
            }
            return; // Detenemos la ejecución aquí. Salvamos la CPU del servidor.
        }

        // ⚡ Decode the incoming binary buffer back into a Javascript Object
        const data = decode(message);

        // 1. HANDLE REGISTRATION
        if (data.type === 'register') {
            try {
                const existingUser = await User.findOne({ email: data.email });
                if (existingUser) return ws.send(encode({ type: 'auth_error', message: 'Email already registered' }));

                const hashedPassword = await bcrypt.hash(data.password, 10);

                // --- NUEVO: GENERAR GAME ID ---
                const counter = await Counter.findOneAndUpdate(
                    { id: 'userId' },
                    { $inc: { seq: 1 } },
                    { new: true, upsert: true }
                );
                // Offset de 999 para que el primer jugador empiece en A1000
                const seqNumber = counter.seq + 999;
                const newGameId = "A" + seqNumber;

                const newUser = new User({
                    email: data.email,
                    username: data.username, // Give them a default display name
                    password: hashedPassword,
                    gameId: newGameId
                });
                await newUser.save();

                ws.send(encode({ type: 'register_success', message: 'Account created! You can now log in.' }));
            } catch (err) { console.error(err); ws.send(encode({ type: 'auth_error', message: 'Server error.' })); }
        }

        // 2. HANDLE LOGIN
        if (data.type === 'login') {
            try {
                // Search by EMAIL instead of username
                const user = await User.findOne({ email: data.email });
                if (!user) return ws.send(encode({ type: 'auth_error', message: 'Email not found' }));

                const isMatch = await bcrypt.compare(data.password, user.password);
                if (!isMatch) return ws.send(encode({ type: 'auth_error', message: 'Incorrect password' }));

                // --- NEW: RETROACTIVELY GIVE EXISTING PLAYERS THE GUN ---
                if (!user.inventory || user.inventory.length === 0) {
                    user.inventory = ["ghost_gun"];
                    user.markModified('inventory'); // <--- THE FIX: Force MongoDB to see the change!
                    await user.save();
                }

                // --- NUEVO: RETROACTIVELY GIVE EXISTING PLAYERS A GAME ID ---
                if (!user.gameId) {
                    const counter = await Counter.findOneAndUpdate(
                        { id: 'userId' },
                        { $inc: { seq: 1 } },
                        { new: true, upsert: true }
                    );
                    const seqNumber = counter.seq + 999;
                    user.gameId = "A" + seqNumber;
                    await user.save();
                }

                const newToken = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
                user.token = newToken;
                await user.save();

                isAuthenticated = true;
                currentUser = user.email; // Track session by email internally

                // Pass their data to the lobby memory
                players[id].email = user.email; // Hidden from other players
                players[id].username = user.username;
                players[id].gameId = user.gameId; // <--- NUEVO
                players[id].role = user.role; // <--- ADMIN ROLE
                players[id].worldX = user.worldX;
                players[id].worldY = user.worldY;
                players[id].friends = user.friends;
                // --- THE FIX: Give the server memory their inventory! ---
                players[id].inventory = user.inventory;

                players[id].equippedWeapon = user.equippedWeapon || "none";
                players[id].weaponAmmo = {};
                players[id].equipped = user.equipped || { head: 'head_default', body: 'body_default', hands: 'none' };

                // --- THE HOTBAR PERSISTENCE FIX ---
                players[id].hotbar = user.hotbar || ["none", "none", "none"];
                players[id].quickSwaps = user.quickSwaps || []; // 🆕 Nueva línea

                // --- NUEVO: CARGAR MONEDAS A LA RAM ---
                players[id].coins = user.coins || 0;
                players[id].gems = user.gems || 0; // Cargar Argems

                // 👇 NUEVO: CARGAR KILLS Y LOSSES 👇
                players[id].kills = user.kills || 0;
                players[id].losses = user.losses || 0;
                players[id].elo = user.elo || 1000;
                // 👇 NUEVO: CARGAR SALUD A LA RAM 👇
                players[id].hp = user.hp !== undefined ? user.hp : 100;
                players[id].isDead = user.isDead || false;

                // --- 🌟 NUEVO: CARGAR TAREAS Y LOGROS A LA RAM 🌟 ---
                players[id].taskProgress = {};
                players[id].claimedTasks = {};

                const parseMongoMap = (source, target, isDate) => {
                    if (!source) return;
                    if (source instanceof Map) {
                        source.forEach((v, k) => target[k] = isDate ? new Date(v).getTime() : Number(v));
                    } else {
                        Object.entries(source).forEach(([k, v]) => target[k] = isDate ? new Date(v).getTime() : Number(v));
                    }
                };
                const rawUser = user.toObject();
                parseMongoMap(rawUser.taskProgress, players[id].taskProgress, false);
                parseMongoMap(rawUser.claimedTasks, players[id].claimedTasks, true);

                // 🛑 EL FIX: REINICIAR EL TEMPORIZADOR DE COMBATE AL ENTRAR 🛑
                // Esto evita que los que recargan la página se curen mágicamente
                players[id].lastHitTime = Date.now();

                // Agrega esta línea para guardar el ID único de MongoDB en RAM:
                players[id].accountId = user._id.toString();

                // --- NUEVO: PASAR EL ROL A LA MEMORIA ---
                players[id].role = user.role || 'player';

                // 👇 EL FIX ANTI-COMA: Si te conectas y estabas muerto, revives automáticamente 👇
                if (players[id].isDead || players[id].hp <= 0) {
                    players[id].hp = 100;
                    players[id].isDead = false;
                    // Forzamos a que MongoDB también se entere de que ya no estás muerto
                    User.findByIdAndUpdate(user._id, { hp: 100, isDead: false }).catch(console.error);
                }

                // --- NUEVO: CARGAR EL TAG DEL SQUAD EN RAM ---
                if (user.squad) {
                    const mySquad = await Squad.findById(user.squad);
                    if (mySquad) {
                        players[id].squad = mySquad._id.toString();
                        players[id].squadName = mySquad.name;
                        players[id].squadLogo = mySquad.logo;

                        // 🛑 EL FIX: Revisar si soy líder o si tengo el permiso de invitar
                        const isLeader = mySquad.leader.toString() === user._id.toString();
                        const myData = mySquad.members.find(m => m.accountId.toString() === user._id.toString());
                        players[id].squadCanInvite = isLeader || (myData && myData.canInvite) || false;
                    }
                }
                // Send success and include their friends list!
                ws.send(encode({
                    type: 'login_success',
                    player: players[id],
                    token: newToken,
                    friends: user.friends,
                    globalTasks: GLOBAL_TASKS,
                    taskProgress: players[id].taskProgress,
                    claimedTasks: players[id].claimedTasks,
                    hasSeenTutorial: user.hasSeenTutorial
                }));
                console.log(`[LOGIN_SUCCESS] Sending claimedTasks for ${user.email}:`, players[id].claimedTasks);

                // Move the closing bracket so 'ws' is the second argument!
                broadcast({ type: 'update', id: id, player: players[id] }, ws);

                // --- NUEVO: TRIGGER TUTORIAL IF NEEDED ---
                if (!user.hasSeenTutorial) {
                    ws.send(encode({ type: 'trigger_tutorial' }));
                }
            } catch (err) { console.error(err); }
        }

        // --- NUEVO: HANDLE FEEDBACK ---
        if (data.type === 'submit_feedback' && isAuthenticated) {
            try {
                const newFeedback = new Feedback({
                    gameId: players[id].gameId,
                    category: data.category || 'Ideas',
                    message: data.message
                });
                await newFeedback.save();
                ws.send(encode({ type: 'feedback_success', message: 'Thanks for your feedback! If reviewed and useful we will reward you with an item or something' }));
            } catch (err) {
                console.error(err);
                ws.send(encode({ type: 'system_message', text: 'Error submitting feedback.' }));
            }
        }

        // --- NUEVO: TUTORIAL COMPLETED ---
        if (data.type === 'tutorial_completed' && isAuthenticated) {
            try {
                await User.findOneAndUpdate({ email: currentUser }, { hasSeenTutorial: true });
            } catch (err) { console.error(err); }
        }

        // --- NUEVO: ADMIN TOOLS ---
        if (['admin_teleport', 'admin_summon', 'admin_kick', 'admin_respawn', 'admin_invisible', 'admin_noclip'].includes(data.type) && isAuthenticated) {
            if ((players[id].role || '').toLowerCase() !== 'admin') {
                ws.send(encode({ type: 'system_message', text: 'You do not have permission to use admin tools.', isAlert: true }));
                return;
            }

            // Find target player by gameId
            let targetWs = null;
            let targetId = null;
            for (const client of wss.clients) {
                if (client.readyState === WebSocket.OPEN && client.playerId && players[client.playerId] && players[client.playerId].gameId === data.targetGameId) {
                    targetWs = client;
                    targetId = client.playerId;
                    break;
                }
            }

            if (!targetWs && data.type !== 'admin_invisible' && data.type !== 'admin_noclip') {
                if (data.type === 'admin_teleport') {
                    try {
                        const offlineUser = await User.findOne({ gameId: data.targetGameId });
                        if (!offlineUser) {
                            ws.send(encode({ type: 'system_message', text: `Player ${data.targetGameId} does not exist in database.`, isAlert: true }));
                            return;
                        }
                        players[id].worldX = offlineUser.worldX || 0;
                        players[id].worldY = offlineUser.worldY || 0;
                        ws.send(encode({ type: 'force_position', x: players[id].worldX, y: players[id].worldY, reason: 'teleport' }));
                        broadcast({ type: 'update', id: id, player: players[id] }, ws);
                        ws.send(encode({ type: 'system_message', text: `Teleported to offline player ${data.targetGameId}.` }));
                        return;
                    } catch (e) {
                        console.error("Offline teleport error", e);
                        ws.send(encode({ type: 'system_message', text: 'Database error looking up player.', isAlert: true }));
                        return;
                    }
                } else {
                    const onlineIds = Array.from(wss.clients).map(c => {
                        let p = players[c.playerId];
                        if (!p) return 'Null';
                        return `${p.email || 'Guest'}[${p.gameId || 'None'}]`;
                    }).join(', ');
                    ws.send(encode({ type: 'system_message', text: `Player ${data.targetGameId} not found. Online: ${onlineIds}`, isAlert: true }));
                    return;
                }
            }

            if (data.type === 'admin_teleport') {
                players[id].worldX = players[targetId].worldX;
                players[id].worldY = players[targetId].worldY;
                ws.send(encode({ type: 'force_position', x: players[id].worldX, y: players[id].worldY, reason: 'teleport' }));
                broadcast({ type: 'update', id: id, player: players[id] }, ws);
                ws.send(encode({ type: 'system_message', text: `Teleported to ${data.targetGameId}.` }));
            }
            else if (data.type === 'admin_summon') {
                players[targetId].worldX = players[id].worldX;
                players[targetId].worldY = players[id].worldY;
                targetWs.send(encode({ type: 'force_position', x: players[id].worldX, y: players[id].worldY, reason: 'teleport' }));
                broadcast({ type: 'update', id: targetId, player: players[targetId] }, targetWs);
                ws.send(encode({ type: 'system_message', text: `Summoned ${data.targetGameId} to your location.` }));
            }
            else if (data.type === 'admin_kick') {
                targetWs.send(encode({ type: 'auth_error', message: 'You have been kicked by an administrator.' }));
                targetWs.close();
                ws.send(encode({ type: 'system_message', text: `Kicked ${data.targetGameId}.` }));
            }
            else if (data.type === 'admin_respawn') {
                players[targetId].worldX = 0;
                players[targetId].worldY = 0;
                targetWs.send(encode({ type: 'force_position', x: 0, y: 0, reason: 'teleport' }));
                broadcast({ type: 'update', id: targetId, player: players[targetId] }, targetWs);
                ws.send(encode({ type: 'system_message', text: `Sent ${data.targetGameId} to spawn.` }));
            }
            else if (data.type === 'admin_invisible') {
                players[id].invisibleEnabled = data.enabled;
                if (data.enabled) {
                    broadcast({ type: 'left', id: id });
                } else {
                    broadcast({ type: 'update', id: id, player: players[id] });
                }
                ws.send(encode({ type: 'system_message', text: `Invisible mode: ${data.enabled ? 'ON' : 'OFF'}`, color: '#38ef7d' }));
            }
            else if (data.type === 'admin_noclip') {
                ws.send(encode({ type: 'system_message', text: `Noclip mode: ${data.enabled ? 'ON' : 'OFF'}`, color: '#38ef7d' }));
            }
        }

        if (data.type === 'admin_clearenas' && isAuthenticated) {
            if ((players[id].role || '').toLowerCase() !== 'admin') {
                ws.send(encode({ type: 'system_message', text: 'You do not have permission.', isAlert: true }));
                return;
            }
            try {
                const count = Object.keys(arenasRAM).length;
                for (const arenaId in arenasRAM) {
                    delete arenasRAM[arenaId];
                    wss.clients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) {
                            c.send(encode({ type: 'delete_minigame', arenaId: arenaId }));
                        }
                    });
                }
                await Arena.deleteMany({});
                ws.send(encode({ type: 'system_message', text: `Cleared ${count} minigame arenas successfully!`, color: '#38ef7d' }));
                console.log(`🧹 ADMIN NUKE: Cleared ${count} arenas.`);
            } catch (e) {
                console.error("Error clearing arenas:", e);
                ws.send(encode({ type: 'system_message', text: 'Error clearing arenas from database.', isAlert: true }));
            }
        }

        if (data.type === 'admin_announce' && isAuthenticated) {
            if ((players[id].role || '').toLowerCase() !== 'admin') {
                ws.send(encode({ type: 'system_message', text: 'You do not have permission to use admin tools.', isAlert: true }));
                return;
            }
            if (data.message) {
                const msgPacket = encode({ type: 'global_announcement', message: data.message });
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(msgPacket);
                    }
                });
                console.log(`[GLOBAL ANNOUNCEMENT] ${data.message}`);
                ws.send(encode({ type: 'system_message', text: 'Announcement sent successfully.' }));
            }
        }

        // 3. HANDLE PROFILE EDITS (Ahora es limpio gracias a los IDs)
        if (data.type === 'change_username' && isAuthenticated) {
            try {
                const newUsername = data.newUsername;
                await User.findOneAndUpdate({ email: currentUser }, { username: newUsername });
                players[id].username = newUsername;
                broadcast({ type: 'update', id: id, player: players[id] }, ws);
                ws.send(encode({ type: 'profile_updated', username: newUsername }));
            } catch (err) { console.error("Error cambiando nombre:", err); }
        }

        // 4. AÑADIR AMIGOS (POR ID)
        if (data.type === 'add_friend' && isAuthenticated) {
            try {
                // 1. Lo añadimos a tu base de datos usando su AccountID
                await User.findOneAndUpdate(
                    { email: currentUser },
                    { $addToSet: { friends: data.friendAccountId } }
                );

                // 2. Si es una solicitud nueva (no una respuesta), le avisamos en vivo
                if (!data.isReply) {
                    let targetWsId = null;
                    for (let pid in players) {
                        if (players[pid].accountId === data.friendAccountId) targetWsId = pid;
                    }

                    if (targetWsId) {
                        wss.clients.forEach(client => {
                            if (client.playerId === targetWsId && client.readyState === WebSocket.OPEN) {
                                client.send(encode({
                                    type: 'friend_request',
                                    senderAccountId: players[id].accountId, // Enviamos el ID del que lo pide
                                    senderUsername: players[id].username,
                                    senderFrameX: players[id].frameX,
                                    senderFrameY: players[id].frameY
                                }));
                            }
                        });
                    }
                }
            } catch (err) { console.error(err); }
        }

        // 5. HANDLE WORLD BUILDING
        if (data.type === 'place_tile') {
            // --- EL CANDADO DE SEGURIDAD ABSOLUTA ---
            if (!players[id] || players[id].role !== 'admin') return;


            try {
                // SMART QUERY: Catch tiles on the active layer, OR legacy ghost tiles with no layer (if L0)
                const query = { x: data.x, y: data.y };
                if (data.l === 0) {
                    query.$or = [{ l: 0 }, { l: { $exists: false } }, { l: null }];
                } else {
                    query.l = data.l;
                }

                if (data.tileId === -1) {
                    // 🗑 ERASER: Wipe ALL ghost tiles and duplicates at this coordinate
                    await Tile.deleteMany(query);

                    // LIMPIEZA EN RAM!
                    const key = `${data.x},${data.y},${data.l}`;
                    delete serverWorldMap[key];

                    // BORRAR MINIJUEGOS SI EXISTEN EN ESTA COORDENADA
                    const uniqueArenaId = `arena_${data.x}_${data.y}`;
                    if (arenasRAM[uniqueArenaId]) {
                        await Arena.deleteOne({ arenaId: uniqueArenaId });
                        delete arenasRAM[uniqueArenaId];

                        // Avisar a todos los clientes para que escondan el marcador y borren el balon
                        wss.clients.forEach(c => {
                            if (c.readyState === WebSocket.OPEN) {
                                c.send(encode({ type: 'delete_minigame', arenaId: uniqueArenaId }));
                            }
                        });
                        console.log(`🗑️ Minigame eliminado con el Borrador: ${uniqueArenaId}`);
                    }

                    // 👇 EL FIX: Si pasamos el borrador por encima de la base, la destruimos
                    // 👇 EL FIX: Solo destruimos la base si borramos en la Capa 15 (Lógica)
                    if (centralBase && centralBase.gridX === data.x && centralBase.gridY === data.y && data.l === 15) {
                        await Turf.deleteOne({ turfId: centralBase.turfId });
                        centralBase = null;
                        wss.clients.forEach(c => {
                            if (c.readyState === WebSocket.OPEN) c.send(encode({ type: 'base_update', base: null }));
                        });
                        console.log("🗑️ Base destruida con el Borrador.");
                    }
                } else {
                    // 🎨 PAINT: Destroy old corrupted tiles first, then insert the clean new one
                    await Tile.deleteMany(query);
                    await Tile.create({ x: data.x, y: data.y, l: data.l, tileId: data.tileId });

                    // RAM UPDATE
                    const key = `${data.x},${data.y},${data.l}`;
                    serverWorldMap[key] = { tileId: data.tileId, l: data.l };
                }

                // EN LA SECCIÓN 5 (place_tile):
                wss.clients.forEach(client => {
                    // --- EL FIX: Agregamos client !== ws para no mandarnos ecos ---
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(encode({
                            type: 'tile_update', x: data.x, y: data.y, l: data.l, tileId: data.tileId
                        }));
                    }
                });
            } catch (err) { console.error('Tile Save Error:', err); }
        }

        // 5.5 HANDLE BULK BUILDING (SÚPER GUARDADO MULTI-CAPA ANTI-LAG)
        if (data.type === 'save_blueprint') {
            if (!players[id] || players[id].role !== 'admin') return;
            const bp = new Blueprint(data.blueprint);
            bp.save().then(() => {
                ws.send(encode({ type: 'server_msg', msg: 'Prefab guardado con éxito: ' + data.blueprint.name, color: '#2ecc71' }));
                Blueprint.find().lean().then(bps => {
                    wss.clients.forEach(client => {
                        const pid = client.playerId;
                        if (client.readyState === WebSocket.OPEN && players[pid] && players[pid].role === 'admin') {
                            client.send(encode({ type: 'blueprint_list', blueprints: bps }));
                        }
                    });
                });
            }).catch(err => console.error(err));
        }

        if (data.type === 'load_blueprints') {
            if (!players[id] || players[id].role !== 'admin') return;
            Blueprint.find().lean().then(bps => {
                ws.send(encode({ type: 'blueprint_list', blueprints: bps }));
            }).catch(err => console.error(err));
        }

        if (data.type === 'place_tiles_bulk') {
            // --- EL CANDADO DE SEGURIDAD ABSOLUTA ---
            if (!players[id] || players[id].role !== 'admin') return;

            try {
                const bulkOps = [];
                for (let t of data.tiles) {
                    if (t.tileId === -1) {
                        // BORRADOR: Solo borramos el bloque específico en su capa
                        bulkOps.push({ deleteMany: { filter: { x: t.x, y: t.y, l: t.l } } });

                        // LIMPIEZA EN RAM!
                        const key = `${t.x},${t.y},${t.l}`;
                        delete serverWorldMap[key];

                        // 👇 EL FIX: Si borramos la base con el borrador de arrastre masivo
                        // 👇 EL FIX: Solo si borramos con arrastre masivo en la Capa 15
                        if (centralBase && centralBase.gridX === t.x && centralBase.gridY === t.y && t.l === 15) {
                            await Turf.deleteOne({ turfId: centralBase.turfId });
                            centralBase = null;
                            wss.clients.forEach(c => {
                                if (c.readyState === WebSocket.OPEN) c.send(encode({ type: 'base_update', base: null }));
                            });
                        }
                    } else {
                        let updateObj = { tileId: t.tileId, rotation: t.rotation || 0 };
                        if (t.hasCollision !== undefined) updateObj.hasCollision = t.hasCollision;
                        if (t.isSit !== undefined) updateObj.isSit = t.isSit;
                        if (t.triggerType !== undefined) updateObj.triggerType = t.triggerType;
                        if (t.destX !== undefined) updateObj.destX = t.destX;
                        if (t.destY !== undefined) updateObj.destY = t.destY;
                        if (t.itemId !== undefined) updateObj.itemId = t.itemId;
                        if (t.requiresClick !== undefined) updateObj.requiresClick = t.requiresClick;
                        if (t.npcMessage !== undefined) updateObj.npcMessage = t.npcMessage;
                        if (t.itemRow !== undefined) updateObj.itemRow = t.itemRow;
                        if (t.shelfX !== undefined) updateObj.shelfX = t.shelfX;
                        if (t.shelfY !== undefined) updateObj.shelfY = t.shelfY;

                        // RAM UPDATE
                        const key = `${t.x},${t.y},${t.l}`;
                        if (!serverWorldMap[key]) serverWorldMap[key] = { l: t.l };
                        Object.assign(serverWorldMap[key], updateObj);

                        // UPSERT: Si existe, lo sobrescribe. Si no existe, lo crea. ¡1 sola operación!
                        bulkOps.push({
                            updateOne: {
                                filter: { x: t.x, y: t.y, l: t.l },
                                update: { $set: updateObj },
                                upsert: true
                            }
                        });
                    }
                }

                if (bulkOps.length > 0) {
                    // LA MAGIA: ordered: false permite a MongoDB procesar todo en paralelo a máxima velocidad
                    await Tile.bulkWrite(bulkOps, { ordered: false });
                }

                // EN LA SECCIÓN 5.5 (place_tiles_bulk):
                wss.clients.forEach(client => {
                    // --- EL FIX: Agregamos client !== ws ---
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(encode({
                            type: 'tile_update_bulk', tiles: data.tiles
                        }));
                    }
                });
            } catch (err) { console.error('Bulk Save Error:', err); }
        }

        // 6. HANDLE TILE INSPECTOR UPDATES
        if (data.type === 'update_tile_metadata') {
            // --- EL CANDADO DE SEGURIDAD ABSOLUTA ---
            if (!players[id] || players[id].role !== 'admin') return;

            try {
                const query = { x: data.x, y: data.y };
                if (data.layer === 0) {
                    query.$or = [{ l: 0 }, { l: { $exists: false } }, { l: null }];
                } else {
                    query.l = data.layer;
                }

                const updateData = { hasCollision: data.hasCollision, isSit: data.isSit, l: data.layer };

                // --- NUEVO: ACTUALIZAR LA RAM DEL SERVIDOR EN TIEMPO REAL ---
                const key = `${data.x},${data.y},${data.layer}`;
                if (!serverWorldMap[key]) serverWorldMap[key] = {};
                serverWorldMap[key].hasCollision = data.hasCollision;
                serverWorldMap[key].isSit = data.isSit;
                serverWorldMap[key].l = data.layer;

                if (data.triggerType) {
                    updateData.triggerType = data.triggerType;
                    updateData.destX = data.destX;
                    updateData.destY = data.destY;
                    updateData.itemId = data.itemId;
                    updateData.requiresClick = data.requiresClick;
                    updateData.npcMessage = data.npcMessage;
                    updateData.itemRow = data.itemRow || 0; // <--- AÑADE ESTO PARA MONGODB
                    updateData.shelfX = data.shelfX || 0; // <--- MONGODB
                    updateData.shelfY = data.shelfY || 0;
                    // Guardar también en RAM
                    serverWorldMap[key].triggerType = data.triggerType;
                    serverWorldMap[key].destX = data.destX;
                    serverWorldMap[key].destY = data.destY;
                    serverWorldMap[key].requiresClick = data.requiresClick;
                    serverWorldMap[key].npcMessage = data.npcMessage;
                    serverWorldMap[key].itemRow = data.itemRow || 0; // <--- AÑADE ESTO
                    serverWorldMap[key].shelfX = data.shelfX || 0;
                    serverWorldMap[key].shelfY = data.shelfY || 0;
                }

                await Tile.updateMany(query, updateData);

                // 🛑 EL FIX: CREAR O ACTUALIZAR LA BASE EN VIVO CON SUS DATOS REALES 🛑
                if (data.triggerType === 'base') {
                    const uniqueTurfId = `base_${data.x}_${data.y}`;

                    // upsert: true crea la base si no existe, o la actualiza si ya existe
                    const dbTurf = await Turf.findOneAndUpdate(
                        { turfId: uniqueTurfId },
                        {
                            name: data.turfName || "Base Central",
                            maxHp: data.turfHp || 5000,
                            spriteOffsetX: data.turfOffsetX || 0, // <--- GUARDAR EN BD
                            spriteOffsetY: data.turfOffsetY || 0,  // <--- GUARDAR EN BD
                            hitboxOffsetX: data.turfHitX || 0, // <--- GUARDAR EN BD
                            hitboxOffsetY: data.turfHitY || 0,  // <--- GUARDAR EN BD
                            hitboxW: data.turfHitW || 32, // <--- GUARDAR W
                            hitboxH: data.turfHitH || 32  // <--- GUARDAR H
                            // 🛑 YA NO GUARDAMOS "src" AQUÍ. SE HACE DIRECTO EN MONGODB.
                        },
                        { upsert: true, returnDocument: 'after' } // <--- EL FIX
                    );

                    // La cargamos a la memoria RAM instantáneamente
                    centralBase = {
                        turfId: uniqueTurfId,
                        gridX: data.x, gridY: data.y,
                        worldX: (data.x * 16) + 8, worldY: (data.y * 16) + 8,
                        hp: dbTurf.hp, maxHp: dbTurf.maxHp,
                        currentOwnerSquadId: dbTurf.ownerSquadName,
                        name: dbTurf.name,
                        srcIdle: dbTurf.srcIdle || "",
                        srcHit: dbTurf.srcHit || "",
                        spriteOffsetX: dbTurf.spriteOffsetX || 0, // <--- RAM
                        spriteOffsetY: dbTurf.spriteOffsetY || 0, // <--- RAM
                        hitboxOffsetX: dbTurf.hitboxOffsetX || 0, // <--- RAM
                        hitboxOffsetY: dbTurf.hitboxOffsetY || 0, // <--- RAM
                        hitboxW: dbTurf.hitboxW || 32, // <--- RAM W
                        hitboxH: dbTurf.hitboxH || 32, // <--- RAM H
                        lastHitTime: centralBase ? centralBase.lastHitTime : 0, // Conservar el tiempo si ya existía
                        damageTracker: {}
                    };

                    console.log(`🏰 Base Guardada/Actualizada en vivo: ${centralBase.name} (${centralBase.maxHp} HP)`);

                    wss.clients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) c.send(encode({ type: 'base_update', base: centralBase }));
                    });
                } // 🥊 NUEVO: CREAR O ACTUALIZAR ARENA DE SPARRING
                else if (data.triggerType === 'arena') {
                    const uniqueArenaId = `arena_${data.x}_${data.y}`;

                    const dbArena = await Arena.findOneAndUpdate(
                        { arenaId: uniqueArenaId },
                        {
                            name: data.arenaName || "Coliseo",
                            gameType: data.gameType || "spar",
                            maxPlayers: data.maxPlayers || 2,
                            team1Size: data.team1Size || 1,
                            team2Size: data.team2Size || 1,
                            isRanked: data.isRanked || false,
                            p1X: data.arenaP1X, p1Y: data.arenaP1Y,
                            p2X: data.arenaP2X, p2Y: data.arenaP2Y,
                            config: {
                                ballX: data.ballX, ballY: data.ballY,
                                goal1X1: data.goal1X1, goal1X2: data.goal1X2, goal1Y: data.goal1Y,
                                goal2X1: data.goal2X1, goal2X2: data.goal2X2, goal2Y: data.goal2Y,
                                brMinX: data.brMinX, brMaxX: data.brMaxX,
                                brMinY: data.brMinY, brMaxY: data.brMaxY
                            }
                        },
                        { upsert: true, returnDocument: 'after' } // <--- EL FIX
                    );

                    // Mantener el estado en vivo (Si ya había gente en cola, no borrarlos)
                    if (!arenasRAM[uniqueArenaId]) {
                        arenasRAM[uniqueArenaId] = {
                            queue: [],
                            isOccupied: false,
                            fighter1: null,
                            fighter2: null
                        };
                    }

                    // Actualizar memoria RAM
                    arenasRAM[uniqueArenaId].arenaId = uniqueArenaId;
                    arenasRAM[uniqueArenaId].name = dbArena.name;
                    arenasRAM[uniqueArenaId].gameType = dbArena.gameType;
                    arenasRAM[uniqueArenaId].maxPlayers = dbArena.maxPlayers;
                    arenasRAM[uniqueArenaId].team1Size = dbArena.team1Size;
                    arenasRAM[uniqueArenaId].team2Size = dbArena.team2Size;
                    arenasRAM[uniqueArenaId].isRanked = dbArena.isRanked;
                    arenasRAM[uniqueArenaId].config = dbArena.config || {};

                    // Maintain backward compatibility for Spar
                    arenasRAM[uniqueArenaId].p1X = dbArena.p1X || dbArena.config?.p1X || 0;
                    arenasRAM[uniqueArenaId].p1Y = dbArena.p1Y || dbArena.config?.p1Y || 0;
                    arenasRAM[uniqueArenaId].p2X = dbArena.p2X || dbArena.config?.p2X || 0;
                    arenasRAM[uniqueArenaId].p2Y = dbArena.p2Y || dbArena.config?.p2Y || 0;

                    if (dbArena.gameType === 'soccer') {
                        if (!arenasRAM[uniqueArenaId].ball) {
                            arenasRAM[uniqueArenaId].ball = { vx: 0, vy: 0, score1: 0, score2: 0 };
                        }
                        arenasRAM[uniqueArenaId].ball.x = (dbArena.config?.ballX || 0) * 16;
                        arenasRAM[uniqueArenaId].ball.y = (dbArena.config?.ballY || 0) * 16;
                        arenasRAM[uniqueArenaId].ball.spawnX = (dbArena.config?.ballX || 0) * 16;
                        arenasRAM[uniqueArenaId].ball.spawnY = (dbArena.config?.ballY || 0) * 16;
                        arenasRAM[uniqueArenaId].ball.goal1X1 = (dbArena.config?.goal1X1 || 0) * 16;
                        arenasRAM[uniqueArenaId].ball.goal1X2 = (dbArena.config?.goal1X2 || 0) * 16;
                        arenasRAM[uniqueArenaId].ball.goal1Y = (dbArena.config?.goal1Y || 0) * 16;
                        arenasRAM[uniqueArenaId].ball.goal2X1 = (dbArena.config?.goal2X1 || 0) * 16;
                        arenasRAM[uniqueArenaId].ball.goal2X2 = (dbArena.config?.goal2X2 || 0) * 16;
                        arenasRAM[uniqueArenaId].ball.goal2Y = (dbArena.config?.goal2Y || 0) * 16;
                    }

                    arenasRAM[uniqueArenaId].doorX = data.x; // Donde está el letrero para salir
                    arenasRAM[uniqueArenaId].doorY = data.y;

                    console.log(`🎮 Minigame Guardado en vivo: ${dbArena.name} (${dbArena.gameType})`);
                } else if (data.triggerType !== undefined) {
                    // Si cambias el bloque para quitar el minijuego, lo destruimos
                    if (data.triggerType !== 'arena') {
                        const uniqueArenaId = `arena_${data.x}_${data.y}`;
                        if (arenasRAM[uniqueArenaId]) {
                            await Arena.deleteOne({ arenaId: uniqueArenaId });
                            delete arenasRAM[uniqueArenaId];

                            // Avisar a todos los clientes para que escondan el marcador y borren el balon
                            wss.clients.forEach(c => {
                                if (c.readyState === WebSocket.OPEN) {
                                    c.send(encode({ type: 'delete_minigame', arenaId: uniqueArenaId }));
                                }
                            });
                            console.log(`🗑️ Minigame eliminado mediante el Inspector: ${uniqueArenaId}`);
                        }
                    }

                    // Si cambias el bloque a "Normal" estando en la Capa 15, DESTRUIMOS LA BASE
                    if (centralBase && centralBase.gridX === data.x && centralBase.gridY === data.y && data.layer === 15) {
                        await Turf.deleteOne({ turfId: centralBase.turfId });
                        centralBase = null;
                        wss.clients.forEach(c => {
                            if (c.readyState === WebSocket.OPEN) c.send(encode({ type: 'base_update', base: null }));
                        });
                        console.log(`🗑️ Base eliminada mediante el Inspector.`);
                    }
                }

                wss.clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(encode({
                            type: 'tile_meta_update',
                            x: data.x, y: data.y, layer: data.layer, hasCollision: data.hasCollision, isSit: data.isSit,
                            triggerType: data.triggerType, destX: data.destX, destY: data.destY,
                            itemId: data.itemId,
                            requiresClick: data.requiresClick,
                            npcMessage: data.npcMessage,
                            itemRow: data.itemRow || 0, // <--- AÑADE ESTE ENVÍO AL CLIENTE
                            shelfX: data.shelfX || 0, // <--- AL CLIENTE
                            shelfY: data.shelfY || 0
                        }));
                    }
                });
            } catch (err) { console.error('Meta Update Error:', err); }
        }// --- 🥊 SISTEMA DE SPARRING (MULTIARENAS) ---
        if (data.type === 'get_arena_info' && isAuthenticated) {
            const arena = arenasRAM[data.arenaId];
            if (arena) {
                // Traducir los IDs a nombres para que el frontend los lea bonito
                const queueNames = arena.queue.map(pid => players[pid] ? players[pid].username : "Desconectado");
                const f1Name = arena.fighter1 && players[arena.fighter1] ? players[arena.fighter1].username : null;
                const f2Name = arena.fighter2 && players[arena.fighter2] ? players[arena.fighter2].username : null;

                ws.send(encode({
                    type: 'arena_info_update',
                    arenaId: data.arenaId,
                    name: arena.name,
                    queue: queueNames,
                    inQueue: arena.queue.includes(id),
                    fighter1: f1Name,
                    fighter2: f2Name
                }));
            }
        }

        if (data.type === 'join_arena_queue' && isAuthenticated) {
            const arena = arenasRAM[data.arenaId];
            if (arena && !arena.queue.includes(id) && arena.fighter1 !== id && arena.fighter2 !== id) {
                arena.queue.push(id);
                // Guardar dónde estaba para devolverlo después de pelear
                players[id].preSparX = players[id].worldX;
                players[id].preSparY = players[id].worldY;
                players[id].currentArena = data.arenaId; // Marcamos en qué arena se metió

                // Actualizar a todos los que estén viendo el letrero
                broadcast({ type: 'refresh_arena_ui', arenaId: data.arenaId });
                ws.send(encode({ type: 'refresh_arena_ui', arenaId: data.arenaId }));
            }
        }

        if (data.type === 'leave_arena_queue' && isAuthenticated) {
            const arena = arenasRAM[data.arenaId];
            if (arena) {
                arena.queue = arena.queue.filter(pId => pId !== id);
                players[id].currentArena = null;
                broadcast({ type: 'refresh_arena_ui', arenaId: data.arenaId });
                ws.send(encode({ type: 'refresh_arena_ui', arenaId: data.arenaId }));
            }
        }// 🛑 NUEVO: GUARDAR ATUENDO DEL GUARDARROPA (WARDROBE)
        if (data.type === 'update_wardrobe' && isAuthenticated) {
            try {
                const p = players[id];
                if (!p) return;

                const ownsHead = data.head === 'head_default' || (p.inventory && p.inventory.some(i => (typeof i === 'object' ? i.id : i) === data.head));
                const ownsBody = data.body === 'body_default' || (p.inventory && p.inventory.some(i => (typeof i === 'object' ? i.id : i) === data.body));
                const ownsHat = data.hat === 'none' || (p.inventory && p.inventory.some(i => (typeof i === 'object' ? i.id : i) === data.hat));

                if (ownsHead && ownsBody && ownsHat) {
                    if (!p.equipped) p.equipped = { head: 'head_default', body: 'body_default', hands: 'none', hat: 'none' };
                    p.equipped.head = data.head;
                    p.equipped.body = data.body;
                    p.equipped.hat = data.hat;

                    broadcast({ type: 'update', id: id, player: p }, ws);
                }
            } catch (err) { console.error("Error actualizando guardarropa:", err); }
        }
        // --- NUEVO: CREAR ZONA UNIVERSAL (ADMIN) ---
        if (data.type === 'create_safezone') {
            if (!players[id] || players[id].role !== 'admin') return;

            try {
                const newZone = new SafeZone({
                    name: data.name,
                    zoneType: data.zoneType || 'safe',
                    xMin: data.xMin, xMax: data.xMax,
                    yMin: data.yMin, yMax: data.yMax,
                    // 🏴 TURF: guardar el punto de spawn si lo manda el cliente
                    spawnX: (data.spawnX != null) ? Number(data.spawnX) : null,
                    spawnY: (data.spawnY != null) ? Number(data.spawnY) : null
                });
                await newZone.save();

                // 🛑 EL FIX: Convertir el Documento de Mongoose a Objeto Plano y limpiar el ID
                const plainZone = newZone.toObject();
                plainZone._id = plainZone._id.toString();

                // Guardarlo en la RAM
                safeZonesRAM.push(plainZone);

                // Enviarlo a los clientes (Ahora MessagePack lo empaquetará sin problemas)
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(encode({ type: 'new_safezone', zone: plainZone }));
                    }
                });
            } catch (err) { console.error("Error guardando Zona:", err); }
        }// --- NUEVO: ELIMINAR ZONA SEGURA (ADMIN) ---
        if (data.type === 'delete_safezone' && isAuthenticated) {
            if (!players[id] || players[id].role !== 'admin') return;

            try {
                // 1. Borrar de MongoDB usando su ID único
                await SafeZone.findByIdAndDelete(data.id);

                // 2. Borrar de la memoria RAM del servidor
                safeZonesRAM = safeZonesRAM.filter(z => z._id.toString() !== data.id);

                // 3. Avisarle a todos los jugadores que esa zona ya no existe
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(encode({ type: 'safezone_deleted', id: data.id }));
                    }
                });
                console.log(`🛡️ Zona Segura eliminada: ${data.id}`);
            } catch (err) {
                console.error("Error eliminando SafeZone:", err);
            }
        }

        // 4. HANDLE AUTO-LOGIN
        if (data.type === 'auto_login') {
            try {
                // Find the user by their secret token
                const user = await User.findOne({ token: data.token });

                if (!user) {
                    return ws.send(encode({ type: 'auth_error', message: 'Session expired. Please log in again.' }));
                }

                // --- NEW: RETROACTIVELY GIVE EXISTING PLAYERS THE GUN ---
                if (!user.inventory || user.inventory.length === 0) {
                    user.inventory = ["ghost_gun"];
                    user.markModified('inventory'); // <--- THE FIX: Force MongoDB to see the change!
                    await user.save();
                }

                // --- NUEVO: RETROACTIVELY GIVE EXISTING PLAYERS A GAME ID ---
                if (!user.gameId) {
                    const counter = await Counter.findOneAndUpdate(
                        { id: 'userId' },
                        { $inc: { seq: 1 } },
                        { new: true, upsert: true }
                    );
                    const seqNumber = counter.seq + 999;
                    user.gameId = "A" + seqNumber;
                    await user.save();
                }

                isAuthenticated = true;
                currentUser = user.email; // We track the session by email now!

                // Pass their data to the lobby memory
                players[id].email = user.email;
                players[id].username = user.username;
                players[id].gameId = user.gameId; // <--- NUEVO
                players[id].role = user.role; // <--- ADMIN ROLE
                players[id].worldX = user.worldX;
                players[id].worldY = user.worldY;
                players[id].friends = user.friends; // Don't forget the friends list!
                // --- FIX: Give the server memory their inventory! ---
                players[id].inventory = user.inventory;

                // --- THE PERSISTENCE FIX: Load the saved weapon! ---
                players[id].equippedWeapon = user.equippedWeapon || "none";
                players[id].equipped = user.equipped || { head: 'head_default', body: 'body_default', hands: 'none' }; players[id].hotbar = user.hotbar || ["none", "none", "none"];
                players[id].quickSwaps = user.quickSwaps || []; // 🆕 Nueva línea

                // --- NUEVO: CARGAR MONEDAS A LA RAM ---
                players[id].coins = user.coins || 0;
                players[id].gems = user.gems || 0; // Cargar Argems

                // 👇 NUEVO: CARGAR KILLS Y LOSSES 👇
                players[id].kills = user.kills || 0;
                players[id].losses = user.losses || 0;
                players[id].elo = user.elo || 1000; // <--- AÑADIR ESTO
                // 👇 NUEVO: CARGAR SALUD A LA RAM 👇
                players[id].hp = user.hp !== undefined ? user.hp : 100;
                players[id].isDead = user.isDead || false;

                // --- 🌟 NUEVO: CARGAR TAREAS Y LOGROS A LA RAM (AUTO LOGIN) 🌟 ---
                players[id].taskProgress = {};
                players[id].claimedTasks = {};

                const parseMongoMapAuto = (source, target, isDate) => {
                    if (!source) return;
                    if (source instanceof Map) {
                        source.forEach((v, k) => target[k] = isDate ? new Date(v).getTime() : Number(v));
                    } else {
                        Object.entries(source).forEach(([k, v]) => target[k] = isDate ? new Date(v).getTime() : Number(v));
                    }
                };
                const rawUser = user.toObject();
                parseMongoMapAuto(rawUser.taskProgress, players[id].taskProgress, false);
                parseMongoMapAuto(rawUser.claimedTasks, players[id].claimedTasks, true);
                console.log(`[INIT] Loaded claimedTasks from DB for ${user.email}:`, players[id].claimedTasks);

                // 🛑 EL FIX: REINICIAR EL TEMPORIZADOR DE COMBATE AL ENTRAR 🛑
                // Esto evita que los que recargan la página se curen mágicamente
                players[id].lastHitTime = Date.now();

                // Agrega esta línea para guardar el ID único de MongoDB en RAM:
                players[id].accountId = user._id.toString();

                // --- NUEVO: PASAR EL ROL A LA MEMORIA ---
                players[id].role = user.role || 'player';
                // 👇 EL FIX ANTI-COMA: Si te conectas y estabas muerto, revives automáticamente 👇
                if (players[id].isDead || players[id].hp <= 0) {
                    players[id].hp = 100;
                    players[id].isDead = false;
                    // Forzamos a que MongoDB también se entere de que ya no estás muerto
                    User.findByIdAndUpdate(user._id, { hp: 100, isDead: false }).catch(console.error);
                }
                // --- NUEVO: CARGAR EL TAG DEL SQUAD EN RAM ---
                if (user.squad) {
                    const mySquad = await Squad.findById(user.squad);
                    if (mySquad) {
                        players[id].squad = mySquad._id.toString();
                        players[id].squadName = mySquad.name;
                        players[id].squadLogo = mySquad.logo;

                        // 🛑 EL FIX: Revisar si soy líder o si tengo el permiso de invitar
                        const isLeader = mySquad.leader.toString() === user._id.toString();
                        const myData = mySquad.members.find(m => m.accountId.toString() === user._id.toString());
                        players[id].squadCanInvite = isLeader || (myData && myData.canInvite) || false;
                    }
                }

                // Send success back to the browser
                ws.send(encode({
                    type: 'login_success',
                    player: players[id],
                    token: user.token,
                    friends: user.friends,
                    globalTasks: GLOBAL_TASKS,
                    taskProgress: players[id].taskProgress,
                    claimedTasks: players[id].claimedTasks,
                    hasSeenTutorial: user.hasSeenTutorial
                }));
                console.log(`[LOGIN_SUCCESS] Sending claimedTasks for ${user.email}:`, players[id].claimedTasks);

                // Tell everyone else you arrived (excluding yourself so no ghost clone appears!)
                broadcast({ type: 'update', id: id, player: players[id] }, ws);

                // --- NUEVO: TRIGGER TUTORIAL IF NEEDED ---
                if (!user.hasSeenTutorial) {
                    ws.send(encode({ type: 'trigger_tutorial' }));
                }
            } catch (err) { console.error(err); }
        }

        // 3. MOVIMIENTO AUTORITATIVO (ANTI-SPEEDHACK Y ANTI-NOCLIP)
        if (data.type === 'update') {
            if (!players[id]) players[id] = { worldX: 0, worldY: 0, lastUpdate: Date.now() };
            let p = players[id];

            const requestedX = data.player.worldX;
            const requestedY = data.player.worldY;

            const now = Date.now();
            const timeSinceLastUpdate = Math.max(1, now - (p.lastUpdate || now));
            p.lastUpdate = now;

            const dist = Math.hypot(requestedX - p.worldX, requestedY - p.worldY);

            // EL FIX (ANTI-JITTER): 
            // 1. Subimos la velocidad teórica a 400px por segundo para dar más holgura al lag.
            let MAX_ALLOWED_DIST = (400 * timeSinceLastUpdate) / 1000;

            // 2. Subimos el "Piso Mínimo" de 15 a 45 píxeles. 
            // Esto evita que el servidor te castigue cuando recibe 2 paquetes amontonados al mismo tiempo.
            MAX_ALLOWED_DIST = Math.max(45, MAX_ALLOWED_DIST);

            // --- NUEVO: ¿ESTÁ CERCA DE UN TELETRANSPORTADOR LEGAL? ---
            const oldGridX = Math.floor(p.worldX / TILE_SIZE);
            const oldGridY = Math.floor(p.worldY / TILE_SIZE);

            let isLegalTeleport = false;

            // Escaneamos un radio de 5x5 alrededor de la puerta
            for (let ox = -2; ox <= 2; ox++) {
                for (let oy = -2; oy <= 2; oy++) {
                    const checkX = oldGridX + ox;
                    const checkY = oldGridY + oy;
                    const logicTile = serverWorldMap[`${checkX},${checkY},15`]; // Revisa capa 15

                    if (logicTile && logicTile.triggerType === 'teleport') {
                        // Calculamos a dónde lleva esta puerta teóricamente
                        const expectedX = (logicTile.destX * TILE_SIZE) + (TILE_SIZE / 2);
                        const expectedY = (logicTile.destY * TILE_SIZE) + (TILE_SIZE / 2);

                        // EL FIX DEFINITIVO: 150 píxeles de tolerancia.
                        // Al salir de edificios, el cliente suele "escupir" al jugador lejos de la puerta.
                        // Mientras caiga en un radio de 150px del destino, el salto es 100% legal.
                        if (Math.abs(requestedX - expectedX) < 150 && Math.abs(requestedY - expectedY) < 150) {
                            isLegalTeleport = true;
                            break;
                        }
                    }
                }
                if (isLegalTeleport) break;
            }

            const isColliding = serverCheckCollision(requestedX, requestedY);
            const isAdmin = (p.role === 'admin');

            // EL FIX: Agregamos !isLegalTeleport para que no lo castigue si usó una puerta
            if (!isAdmin && !isLegalTeleport && (dist > MAX_ALLOWED_DIST || isColliding)) {

                // Distinguir: ¿colisión limpia con pared o speedhack real?
                // 'wall'     → el cliente se reposiciona silenciosamente, sin flash rojo
                // 'antihack' → el cliente muestra flash rojo y resetea velocidad
                const rejectReason = isColliding ? 'wall' : 'antihack';

                ws.send(encode({
                    type: 'force_position',
                    x: p.worldX,
                    y: p.worldY,
                    reason: rejectReason
                }));

            } else {
                // Movimiento legal (o Teleport Autorizado)
                const oldChunk = p.chunkId;
                p.worldX = requestedX;
                p.worldY = requestedY;
                p.chunkId = getChunkId(p.worldX, p.worldY);

                // GHOST-BUSTER: Did they cross a chunk border?
                if (oldChunk !== p.chunkId) {
                    const oldVisible = getVisibleChunks(oldChunk);
                    const newVisible = getVisibleChunks(p.chunkId);

                    // Find chunks they left behind and tell those players to delete their avatar
                    const chunksLeftBehind = oldVisible.filter(c => !newVisible.includes(c));

                    if (chunksLeftBehind.length > 0) {
                        const despawnPayload = encode({ type: 'left', id: id });
                        wss.clients.forEach(client => {
                            if (client !== ws && client.readyState === WebSocket.OPEN && client.playerId) {
                                const observer = players[client.playerId];
                                if (observer && chunksLeftBehind.includes(observer.chunkId)) {
                                    client.send(despawnPayload);
                                }
                            }
                        });
                    }
                }

                // --- ⚽ SOCCER KICK LOGIC ---
                if (p.currentArena && arenasRAM[p.currentArena] && arenasRAM[p.currentArena].gameType === 'soccer') {
                    const arena = arenasRAM[p.currentArena];
                    if (arena.ball) {
                        const dx = p.worldX - arena.ball.x;
                        const dy = p.worldY - arena.ball.y;
                        const distToBall = Math.hypot(dx, dy);
                        if (distToBall < 24) { // Kick distance threshold
                            const kickStrength = 15; // Max velocity
                            arena.ball.vx = (dx / distToBall) * -kickStrength;
                            arena.ball.vy = (dy / distToBall) * -kickStrength;
                        }
                    }
                }
            }

            p.frameX = data.player.frameX;
            p.frameY = data.player.frameY;
            p.isMoving = data.player.isMoving;
            p.isTyping = data.player.isTyping;
            p.isSitting = data.player.isSitting;

            // 🛑 EL FIX 2: Sincronizar el arma para que los demás la vean en tu mano
            if (data.player.equippedWeapon !== undefined) {
                p.equippedWeapon = data.player.equippedWeapon;
            }

            let safeMsg = data.player.message || "";
            p.message = safeMsg.substring(0, 100);
            p.messageTimer = Math.min(data.player.messageTimer || 0, 600);

            // 🎯 SEND MOVEMENT ONLY TO LOCAL CHUNK
            broadcastToZone({ type: 'update', id: id, player: p }, p.chunkId, ws);
        }

        // --- NUEVO: RUTA SEGURA PARA EQUIPAR ARMAS ---
        if (data.type === 'equip_weapon') {
            const p = players[id];
            if (!p) return;

            // 🛡️ ANTI-HACK: Escáner de inventario a prueba de formatos mixtos
            let ownsWeapon = false;
            if (data.weaponId === "none") {
                ownsWeapon = true;
            } else if (p.inventory) {
                ownsWeapon = p.inventory.some(item => {
                    const itemId = (typeof item === 'object') ? item.id : item;
                    return itemId === data.weaponId;
                });
            }

            if (ownsWeapon) {
                p.equippedWeapon = data.weaponId;

                // Inicializamos la memoria de balas del servidor si es un arma nueva
                const stats = WEAPONS[data.weaponId];
                if (stats && stats.type === 'ranged') {
                    if (p.weaponAmmo[data.weaponId] === undefined) {
                        p.weaponAmmo[data.weaponId] = stats.magSize;
                    }
                }

                // Avisamos a los demás jugadores qué arma traes en la mano
                broadcast({ type: 'update', id: id, player: p }, ws);
            } else {
                console.warn(`[ANTI-HACK] ${p.username} intentó equipar un arma fantasma: ${data.weaponId}`);
            }
        }

        // --- NUEVO: RUTA SEGURA PARA ACTUALIZAR EL HOTBAR ---
        if (data.type === 'update_hotbar') {
            const p = players[id];
            if (!p) return;

            // 🛡️ ANTI-HACK: Escáner de inventario a prueba de formatos mixtos
            let ownsWeapon = false;
            if (data.weaponId === "none") {
                ownsWeapon = true;
            } else if (p.inventory) {
                ownsWeapon = p.inventory.some(item => {
                    const itemId = (typeof item === 'object') ? item.id : item;
                    return itemId === data.weaponId;
                });
            }

            if (ownsWeapon) {
                if (!p.hotbar) p.hotbar = ["none", "none", "none"];
                p.hotbar[data.slotIndex] = data.weaponId;
            } else {
                console.warn(`[ANTI-HACK] ${p.username} intentó equipar ${data.weaponId} sin comprarlo.`);
            }
        }
        // 🔄 NUEVO: AVISO DE RECARGA AL SERVIDOR
        if (data.type === 'reload_weapon') {
            const p = players[id];
            const stats = WEAPONS[data.weaponId];
            if (p && stats && stats.type === 'ranged') {
                p.weaponAmmo[data.weaponId] = stats.magSize;
            }
        }
        // --- NUEVO: RUTA SEGURA PARA ACTUALIZAR QUICK SWAPS ---
        if (data.type === 'update_quickswaps' && isAuthenticated) {
            if (players[id]) {
                players[id].quickSwaps = data.quickSwaps;
            }
        }// 🛠️ COMANDO DE RESCATE (/fix)
        if (data.type === 'force_unstuck' && isAuthenticated) {
            const p = players[id];
            if (p) {
                // Limpiamos los estados de trabado
                p.isReloading = false;

                if (ws.reloadTimeout) {
                    clearTimeout(ws.reloadTimeout);
                    delete ws.reloadTimeout;
                }

                // 🛡️ EL FIX: Solo revivir si realmente su HP era 0
                if (p.hp <= 0 || p.isDead) {
                    p.hp = 100;
                    p.isDead = false;
                }

                // Avisar a todos del estado actualizado
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(encode({
                            type: 'hp_update', targetId: id, newHp: p.hp, damageDealt: 0, isDead: p.isDead
                        }));
                    }
                });

                ws.send(encode({
                    type: 'system_message',
                    text: "🛠️ Tu personaje ha sido desbugueado.",
                    color: "#2ecc71"
                }));
            }
        }
        // 7. HANDLE SHOOTING (SINCRO VISUAL ABSOLUTA ANTI-FANTASMAS)
        if (data.type === 'shoot') {
            const shooter = players[id];

            // 🛑 EL FIX 3: Usar el ID del arma que manda el gatillo, no el de la memoria lenta
            const weaponId = data.weaponId || shooter.equippedWeapon || "none";
            const stats = WEAPONS[weaponId];

            if (!stats || weaponId === "none" || isInSafeZone(shooter.worldX, shooter.worldY)) return;

            const now = Date.now();

            // 🛡️ ANTI-HACK: Control de Spam (Fire Rate)
            if (now - (shooter.lastShotTime || 0) < ((stats.fireRate || 300) - 50)) return;
            shooter.lastShotTime = now;

            // 🛡️ ANTI-HACK: Control de Balas Mágicas
            if (stats.type === 'ranged') {
                if (shooter.weaponAmmo[weaponId] === undefined) shooter.weaponAmmo[weaponId] = stats.magSize;
                if (shooter.weaponAmmo[weaponId] <= 0) return; // 🛑 HACKER INTENTANDO DISPARAR SIN BALAS
                shooter.weaponAmmo[weaponId]--; // Descontamos la bala oficial
            }

            // 🛑 EL FIX 4: Reenviar usando weaponId para que tu oponente dibuje la bala y escuche tu disparo
            broadcastToZone({ type: 'shoot', id: id, x: data.x, y: data.y, angle: data.angle, weaponId: weaponId, t: now }, shooter.chunkId, ws);

            if (stats && stats.type !== 'melee') {
                // ⚡ LAG COMPENSATION: Advance bullet by 50ms of travel time (1.5 server frames)
                // This puts the server bullet exactly where the shooter's visual bullet is right now.
                const latencyAdvance = 50 / 33.0; // 50ms average ping / 33ms per tick
                const bVx = Math.cos(data.angle) * stats.speed;
                const bVy = Math.sin(data.angle) * stats.speed;

                activeProjectiles.push({
                    x: data.x + (bVx * latencyAdvance),
                    y: data.y + (bVy * latencyAdvance),
                    vx: bVx,
                    vy: bVy,
                    life: stats.range - latencyAdvance,
                    owner: id,
                    weapon: weaponId,
                    chunkId: shooter.chunkId
                });
            }
        }
        // 7b. DISPARAR (ESCOPETA)
        if (data.type === 'shoot_shotgun') {
            const p = players[id];
            if (!p) return;
            const now = Date.now();

            broadcastToZone({
                type: 'shoot_shotgun', id: id, x: data.x, y: data.y, angles: data.angles, weaponId: data.weaponId, t: now
            }, p.chunkId, ws);

            const stats = WEAPONS[data.weaponId];
            if (stats && stats.type !== 'melee') {
                const latencyAdvance = 50 / 33.0; // 50ms lag compensation
                for (let a of data.angles) {
                    const bVx = Math.cos(a) * stats.speed;
                    const bVy = Math.sin(a) * stats.speed;
                    activeProjectiles.push({
                        x: data.x + (bVx * latencyAdvance),
                        y: data.y + (bVy * latencyAdvance),
                        vx: bVx,
                        vy: bVy,
                        life: stats.range - latencyAdvance,
                        owner: id,
                        weapon: data.weaponId,
                        chunkId: p.chunkId
                    });
                }
            }
        }
        // --- 1. SINCRONIZAR ANIMACIÓN MELEE Y CALCULAR DAÑO ---
        if (data.type === 'melee_swing') {
            const shooter = players[id];
            if (!shooter || shooter.isDead) return;

            const weaponId = data.weaponId || "none";
            const currentWeaponStats = WEAPONS[weaponId] || WEAPONS["none"] || { type: 'melee' };

            // Anti-metralleta melee
            const now = Date.now();
            const lastDamage = shooter.lastDamageTime || 0;
            if (now - lastDamage < ((currentWeaponStats.fireRate || 300) - 50)) return;
            shooter.lastDamageTime = now;

            // 🎯 SEND SWING ANIMATION ONLY TO LOCAL CHUNK
            broadcastToZone({
                type: 'player_swing',
                id: id,
                weaponId: weaponId
            }, shooter.chunkId, ws);

            // 💥 SERVER-AUTHORITATIVE MELEE HIT DETECTION 💥
            const dir = shooter.frameY || 0;
            let aimAngle = 0; let dirMult = 1;
            if (dir === 0) aimAngle = Math.PI / 2;
            else if (dir === 1) { aimAngle = Math.PI; dirMult = -1; }
            else if (dir === 2) { aimAngle = 0; }
            else if (dir === 3) { aimAngle = -Math.PI / 2; dirMult = -1; }

            const d = currentWeaponStats.dirStats ? (currentWeaponStats.dirStats[dir] || {}) : {};
            const hitRotRad = (d.hitRot || 0) * Math.PI / 180;
            const trueHitAngle = aimAngle + (hitRotRad * dirMult);
            const halfWidRad = ((d.hitWid || 60) / 2) * Math.PI / 180;
            const hitRange = d.hitLen || 40;

            const hitOriginX = shooter.worldX + (d.hitX || 0);
            const hitOriginY = shooter.worldY + (d.hitY || 0);

            const visibleChunks = getVisibleChunks(shooter.chunkId);
            for (let targetId in players) {
                if (targetId === id) continue;
                let enemy = players[targetId];
                if (enemy.worldX !== undefined && !enemy.isDead && visibleChunks.includes(enemy.chunkId)) {
                    const dist = Math.hypot(enemy.worldX - hitOriginX, enemy.worldY - hitOriginY);
                    if (dist <= hitRange) {
                        const angleToEnemy = Math.atan2(enemy.worldY - hitOriginY, enemy.worldX - hitOriginX);
                        let angleDiff = angleToEnemy - trueHitAngle;

                        while (angleDiff <= -Math.PI) angleDiff += Math.PI * 2;
                        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;

                        if (Math.abs(angleDiff) <= halfWidRad) {
                            applyDamageToPlayer(targetId, id, weaponId);
                        }
                    }
                }
            }
        }

        // 9. ENVIAR MENSAJE PRIVADO
        if (data.type === 'send_pm' && isAuthenticated) {

            // --- NUEVO ANTI-SPAM (Rate Limit: 1 mensaje por segundo) ---
            const now = Date.now();
            if (players[id].lastPMTime && now - players[id].lastPMTime < 1000) {
                return; // Lo ignoramos silenciosamente
            }
            players[id].lastPMTime = now;

            // --- SANEAMIENTO: Máximo 250 caracteres ---
            let safeText = data.text || "";
            if (safeText.length > 250) safeText = safeText.substring(0, 250);

            try {
                const myAccountId = players[id].accountId;
                const targetAccountId = data.targetAccountId;

                let conv = await PM.findOne({ participants: { $all: [myAccountId, targetAccountId] } });
                if (!conv) {
                    conv = new PM({ participants: [myAccountId, targetAccountId], messages: [] });
                }

                // Usamos "safeText" en lugar de "data.text"
                conv.messages.push({ senderId: myAccountId, text: safeText });
                if (conv.messages.length > 15) conv.messages = conv.messages.slice(-15);
                await conv.save();

                let targetWsId = null;
                for (let pid in players) {
                    if (players[pid].accountId === targetAccountId) targetWsId = pid;
                }

                // 🛡️ Convert Mongoose docs to plain objects before encoding (avoids 'Too deep' error)
                const plainMessages = conv.messages.map(m => ({
                    senderId: m.senderId ? m.senderId.toString() : '',
                    text: m.text || '',
                    _id: m._id ? m._id.toString() : ''
                }));

                if (targetWsId) {
                    wss.clients.forEach(client => {
                        if (client.playerId === targetWsId && client.readyState === WebSocket.OPEN) {
                            client.send(encode({
                                type: 'receive_pm',
                                senderAccountId: myAccountId,
                                senderUsername: players[id].username,
                                history: plainMessages
                            }));
                        }
                    });
                }

                // Also confirm back to the sender so message shows immediately
                ws.send(encode({ type: 'pm_history', targetAccountId: targetAccountId, targetUsername: data.targetUsername, history: plainMessages }));
            } catch (err) { console.error("Error en PM:", err); }
        }

        // 10. PEDIR HISTORIAL DE CHAT
        if (data.type === 'get_pm_history' && isAuthenticated) {
            try {
                const myAccountId = players[id].accountId;
                const targetAccountId = data.targetAccountId;

                // 🛑 EL FIX: Añadir .lean() para limpiar el objeto de Mongoose
                const targetUser = await User.findById(targetAccountId).lean();
                const currentTargetName = targetUser ? targetUser.username : "Usuario Desconocido";
                const targetEquipped = targetUser && targetUser.equipped ? targetUser.equipped : { head: 'head_default' };

                // 🛑 EL FIX: Añadir .lean() al historial de mensajes
                const conv = await PM.findOne({ participants: { $all: [myAccountId, targetAccountId] } }).lean();

                ws.send(encode({
                    type: 'pm_history',
                    targetAccountId: targetAccountId,
                    targetUsername: currentTargetName,
                    targetEquipped: targetEquipped,
                    history: conv ? conv.messages : []
                }));
            } catch (err) { console.error("Error pidiendo historial:", err); }
        }

        // 11. PEDIR LISTA DE INBOX
        if (data.type === 'get_inbox' && isAuthenticated) {
            try {
                const myAccountId = players[id].accountId;

                // 🛑 EL FIX: Añadir .lean()
                const convos = await PM.find({ participants: myAccountId }).lean();

                const inboxData = [];
                for (let c of convos) {
                    const otherPersonId = c.participants.find(p => p !== myAccountId);

                    // 🛑 EL FIX: Añadir .lean()
                    const otherUser = await User.findById(otherPersonId).lean();
                    const currentName = otherUser ? otherUser.username : "Usuario Desconocido";
                    const currentHead = (otherUser && otherUser.equipped) ? otherUser.equipped.head : 'head_default';

                    const lastMsg = c.messages.length > 0 ? c.messages[c.messages.length - 1] : null;

                    inboxData.push({
                        targetAccountId: otherPersonId,
                        targetUser: currentName,
                        targetHeadId: currentHead,
                        lastMessage: lastMsg ? lastMsg.text : "Comienza a chatear...",
                        time: lastMsg ? lastMsg.timestamp : 0
                    });
                }

                inboxData.sort((a, b) => new Date(b.time) - new Date(a.time));
                ws.send(encode({ type: 'inbox_data', inbox: inboxData }));
            } catch (err) { console.error("Error pidiendo inbox:", err); }
        }
        // ==========================================
        // 💬 SQUAD CHAT (RAM-DRIVEN)
        // ==========================================

        // A. Fetch History when opening the clan menu
        if (data.type === 'get_squad_chat' && isAuthenticated) {
            const myUser = await User.findOne({ email: currentUser });
            if (!myUser || !myUser.squad) return;
            const sqId = myUser.squad.toString();

            // If the RAM array doesn't exist for this squad yet, create it
            if (!SQUAD_CHATS_RAM[sqId]) SQUAD_CHATS_RAM[sqId] = [];

            ws.send(encode({
                type: 'squad_chat_history',
                history: SQUAD_CHATS_RAM[sqId]
            }));
        }

        // B. Receive and Broadcast a new message
        if (data.type === 'send_squad_chat' && isAuthenticated) {
            const myUser = await User.findOne({ email: currentUser });
            if (!myUser || !myUser.squad) return;
            const sqId = myUser.squad.toString();

            if (!SQUAD_CHATS_RAM[sqId]) SQUAD_CHATS_RAM[sqId] = [];

            const chatMsg = {
                senderId: myUser._id.toString(),
                senderName: myUser.username,
                // 🛑 EL FIX: Guardar la cabeza actual en el historial
                senderHead: players[id] && players[id].equipped ? players[id].equipped.head : 'head_default',
                text: data.text.substring(0, 150),
                timestamp: new Date().toISOString()
            };

            // Push to RAM
            SQUAD_CHATS_RAM[sqId].push(chatMsg);

            // Limit to the last 30 messages
            if (SQUAD_CHATS_RAM[sqId].length > 30) {
                SQUAD_CHATS_RAM[sqId].shift();
            }

            // Broadcast instantly to all ONLINE members of this exact squad
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && players[client.playerId] && players[client.playerId].squad === sqId) {
                    client.send(encode({
                        type: 'new_squad_chat',
                        message: chatMsg
                    }));
                }
            });
        }
        // 12. PEDIR LISTA DE AMIGOS ACTUALIZADA (Versión Optimizada y con Ropa)
        if (data.type === 'get_friends_list' && isAuthenticated) {
            try {
                const myUser = await User.findOne({ email: currentUser });

                // Filtramos en milisegundos solo los IDs que sí son válidos
                const validFriendIds = (myUser.friends || []).filter(id => mongoose.Types.ObjectId.isValid(id));

                // LA MAGIA: Le pedimos a MongoDB que nos traiga TODOS esos usuarios
                // Usamos .lean() para que la consulta sea hiper-rápida
                const friendsUsers = await User.find({ _id: { $in: validFriendIds } }).lean();

                // Armamos el paquete incluyendo TODA la ropa y stats
                const friendsData = friendsUsers.map(fUser => ({
                    accountId: fUser._id.toString(),
                    username: fUser.username,
                    role: fUser.role || 'player',
                    equipped: fUser.equipped || { head: 'head_default', body: 'body_default', hat: 'none' },
                    elo: fUser.elo || 1000,
                    kills: fUser.kills || 0,
                    losses: fUser.losses || 0,
                    coins: fUser.coins || 0
                }));

                ws.send(encode({ type: 'friends_list_data', friends: friendsData }));
            } catch (err) { console.error("Error pidiendo amigos:", err); }
        }// 27. BÚSQUEDA GLOBAL DE JUGADORES
        if (data.type === 'search_players' && isAuthenticated) {
            try {
                const query = data.query.trim();
                // Bloqueo de seguridad: Mínimo 3 caracteres para no saturar la base de datos
                if (query.length < 3) return;

                // Buscar en MongoDB (Ignora mayúsculas y busca en cualquier parte del nombre)
                const users = await User.find({
                    username: { $regex: query, $options: 'i' }
                }).limit(20).lean(); // Límite de 20 resultados para no crear lag

                // Empaquetamos TODOS los datos para que el perfil offline se dibuje perfecto
                const searchResults = users.map(u => ({
                    accountId: u._id.toString(),
                    username: u.username,
                    role: u.role || 'player',
                    equipped: u.equipped || { head: 'head_default', body: 'body_default', hat: 'none' },
                    elo: u.elo || 1000,
                    kills: u.kills || 0,
                    losses: u.losses || 0,
                    coins: u.coins || 0
                }));

                ws.send(encode({ type: 'search_players_results', results: searchResults }));
            } catch (err) {
                console.error("Error buscando jugadores:", err);
            }
        }

        // 🌟 13. SISTEMA DE LOGROS Y TAREAS DIARIAS 🌟
        if (data.type === 'claim_task' && isAuthenticated) {
            const p = players[id];
            if (!p) return;

            const taskId = data.taskId;
            const task = GLOBAL_TASKS[taskId];

            if (!task) return ws.send(encode({ type: 'claim_error', message: 'Invalid task.' }));

            // 1. Verificar si ya fue cobrada y si está en cooldown
            const lastClaimed = p.claimedTasks[taskId];
            const now = Date.now();

            if (lastClaimed) {
                if (!task.isRepeatable) {
                    return ws.send(encode({ type: 'claim_error', message: 'You already claimed this reward.' }));
                }
                const timeSinceClaim = now - new Date(lastClaimed).getTime();
                if (timeSinceClaim < task.resetIntervalMs) {
                    return ws.send(encode({ type: 'claim_error', message: 'You must wait before claiming this again.' }));
                }
            }

            // 2. Verificar progreso (Engine Genérico)
            let hasCompleted = false;
            if (task.requirementType === 'login') {
                hasCompleted = true; // Si está enviando el paquete, ya está logueado
            } else if (task.requirementType === 'kills') {
                hasCompleted = (p.kills >= task.requirementValue);
            } else if (task.requirementType === 'elo') {
                hasCompleted = (p.elo >= task.requirementValue);
            } else if (task.requirementType === 'play_hours') {
                const currentVal = p.taskProgress[taskId] || 0;
                hasCompleted = (currentVal >= task.requirementValue);
            } else if (task.requirementType === 'squad_base_minutes') {
                if (p.squad) {
                    const squadData = await Squad.findById(p.squad).lean();
                    if (squadData && squadData.territoryTimeMinutes >= task.requirementValue) {
                        // Anti-cheat: Check if player joined AFTER the milestone was achieved
                        const isLeader = squadData.leader.toString() === p.accountId;
                        let canClaim = isLeader; // Leader inherently has been there since start
                        let errorMessage = 'You cannot claim this reward.';

                        if (!isLeader) {
                            const memberInfo = squadData.members.find(m => m.accountId.toString() === p.accountId);
                            if (memberInfo) {
                                let milestoneDate = null;
                                if (squadData.milestonesAchieved && squadData.milestonesAchieved[taskId]) {
                                    milestoneDate = new Date(squadData.milestonesAchieved[taskId]).getTime();
                                }

                                if (memberInfo.joinedAt) {
                                    const joinedTime = new Date(memberInfo.joinedAt).getTime();

                                    if (milestoneDate && joinedTime > milestoneDate) {
                                        // Player joined AFTER the milestone was achieved
                                        canClaim = false;
                                        errorMessage = 'This squad achieved this milestone before you joined.';
                                    } else {
                                        // Fallback 15-day rule
                                        const daysInSquad = (Date.now() - joinedTime) / (1000 * 60 * 60 * 24);
                                        if (daysInSquad >= 15 || milestoneDate) {
                                            canClaim = true;
                                        } else {
                                            canClaim = false;
                                            errorMessage = 'You must be in the Squad for 15 days to claim this reward.';
                                        }
                                    }
                                } else {
                                    // For existing veterans before joinedAt was added
                                    canClaim = true;
                                }
                            }
                        }

                        if (canClaim) {
                            hasCompleted = true;
                        } else {
                            return ws.send(encode({ type: 'claim_error', message: errorMessage }));
                        }
                    } else {
                        hasCompleted = false;
                    }
                } else {
                    hasCompleted = false;
                }
            }
            if (!hasCompleted) {
                return ws.send(encode({ type: 'claim_error', message: 'Requirement not met yet.' }));
            }

            // 3. Pagar Recompensa
            p.claimedTasks[taskId] = now; // Guardar tiempo de cobro

            if (task.rewardType === 'coins') {
                p.coins += task.rewardValue;
                ws.send(encode({ type: 'coins_update', coins: p.coins }));
            } else if (task.rewardType === 'item') {
                if (!p.inventory.includes(task.rewardValue)) {
                    p.inventory.push(task.rewardValue);
                    ws.send(encode({ type: 'inventory_update', inventory: p.inventory }));
                }
            }

            // 4. Avisar al cliente que fue un éxito
            p.claimedTasks[taskId] = now;
            ws.send(encode({ type: 'task_claimed', taskId: taskId, claimedTasks: p.claimedTasks }));

            // EL FIX DEFINITIVO: Mongoose .updateOne() directo
            const updateData = { $set: { coins: p.coins, inventory: p.inventory } };
            updateData.$set[`claimedTasks.${taskId}`] = now;

            User.updateOne({ email: currentUser }, updateData).then((res) => {
                console.log(`[CLAIM] Successfully saved claimedTasks to DB for ${currentUser}. Modified:`, res.modifiedCount);
            }).catch(err => console.error("Error al guardar en MongoDB:", err));
        }

        // --- NUEVO: SISTEMA DE ARGEMS (TIENDA PREMIUM) ---
        if (data.type === 'get_argem_packages' && isAuthenticated) {
            ws.send(encode({ type: 'argem_packages_data', packages: ARGEM_PACKAGES }));
        }

        if (data.type === 'request_purchase_gems' && isAuthenticated) {
            const p = players[id];
            if (!p) return;

            const pkg = ARGEM_PACKAGES.find(pkg => pkg.id === data.packageId);
            if (!pkg) {
                return ws.send(encode({ type: 'system_message', text: "Error: Paquete no encontrado.", color: '#e74c3c' }));
            }

            try {
                // Generate a real Stripe Checkout Session
                stripe.checkout.sessions.create({
                    payment_method_types: ['card'],
                    line_items: [{
                        price_data: {
                            currency: 'usd',
                            product_data: {
                                name: pkg.title,
                                description: pkg.gemsAmount + " Argems for your account"
                            },
                            unit_amount: pkg.priceCents,
                        },
                        quantity: 1,
                    }],
                    mode: 'payment',
                    success_url: `${process.env.CLIENT_URL || 'http://localhost:8080'}/payment_success.html`,
                    cancel_url: `${process.env.CLIENT_URL || 'http://localhost:8080'}/payment_cancel.html`,
                    metadata: {
                        email: currentUser,
                        packageId: pkg.id,
                        gemsAmount: pkg.gemsAmount
                    }
                }).then(session => {
                    // Send the secure checkout URL back to the client
                    ws.send(encode({ type: 'stripe_checkout_url', url: session.url }));
                }).catch(err => {
                    console.error("Stripe Error:", err);
                    ws.send(encode({ type: 'system_message', text: "Payment system unavailable.", color: '#e74c3c' }));
                });
            } catch (err) {
                console.error("Stripe Error:", err);
                ws.send(encode({ type: 'system_message', text: "Payment system unavailable.", color: '#e74c3c' }));
            }
        }

        // 13. SISTEMA DE COMPRAS SEGURAS (TIENDA)
        if (data.type === 'buy_item' && isAuthenticated) {
            const p = players[id];
            if (!p) return;

            const itemId = data.itemId;

            // 🛑 EL FIX: Buscar en TODO el catálogo maestro, no solo en la carpeta de armas
            const itemStats = WEAPONS[itemId] || MASTER_CATALOG[itemId];

            if (!itemStats) return ws.send(encode({ type: 'buy_error', message: 'Este objeto no existe en la base de datos.' }));

            // Verificamos si ya lo tiene en su inventario
            const alreadyOwned = p.inventory && p.inventory.some(i => (typeof i === 'object' ? i.id : i) === itemId);
            if (alreadyOwned) return ws.send(encode({ type: 'buy_error', message: 'Ya posees este objeto.' }));

            if (p.coins < itemStats.price) return ws.send(encode({ type: 'buy_error', message: 'Monedas insuficientes.' }));

            try {
                // Cobrar y entregar el ítem
                p.coins -= itemStats.price;
                if (!p.inventory) p.inventory = [];
                p.inventory.push(itemId);

                // Avisar al jugador que la compra fue un éxito
                ws.send(encode({
                    type: 'buy_success',
                    message: `¡Compraste ${itemStats.name}!`,
                    newCoins: p.coins,
                    newInventory: p.inventory
                }));

                // Actualizar al jugador en vivo para todos
                broadcast({ type: 'update', id: id, player: p }, ws);
                ws.send(encode({ type: 'update', id: id, player: p }));
            } catch (err) {
                console.error("Error al comprar:", err);
                ws.send(encode({ type: 'buy_error', message: 'Error interno del servidor.' }));
            }
        }

        // 14. CREAR SQUAD (CLAN)
        if (data.type === 'create_squad' && isAuthenticated) {
            try {
                const myUser = await User.findOne({ email: currentUser });
                if (!myUser) return;

                // 🛑 EL FIX: Borrar la validación que bloqueaba si ya tenías un Tag equipado.
                // En su lugar, revisamos en la base de datos si ya eres DUEÑO de un clan.
                const alreadyLeader = await Squad.findOne({ leader: myUser._id });
                if (alreadyLeader) {
                    return ws.send(encode({
                        type: 'squad_error',
                        message: 'Ya eres fundador de un Squad. Solo puedes ser dueño de uno.'
                    }));
                }

                // Revisar el dinero
                if (myUser.coins < 2000) {
                    return ws.send(encode({
                        type: 'squad_error',
                        message: 'No tienes suficientes Argons (Cuesta 2000 🪙).'
                    }));
                }

                // Revisar si el nombre ya está en uso por otro clan
                const existingName = await Squad.findOne({ name: data.squadName });
                if (existingName) {
                    return ws.send(encode({
                        type: 'squad_error',
                        message: 'Ese nombre ya está registrado.'
                    }));
                }

                // 1. Cobrar y Crear
                myUser.coins -= 2000;

                const newSquad = new Squad({
                    name: data.squadName,
                    logo: data.logo || "",
                    leader: myUser._id,
                    members: [] // Entra sin miembros, él es el líder
                });
                await newSquad.save();

                // 2. Equiparle automáticamente su nuevo Tag de Fundador
                myUser.squad = newSquad._id;
                await myUser.save();

                // 3. Actualizar la memoria RAM del servidor
                if (players[id]) {
                    players[id].coins = myUser.coins;
                    players[id].gems = myUser.gems;
                    players[id].squad = newSquad._id.toString();
                    players[id].squadName = newSquad.name;
                    players[id].squadLogo = newSquad.logo;
                    players[id].squadCanInvite = true; // El líder siempre puede invitar
                }

                // 4. Avisar al jugador que fue un éxito
                ws.send(encode({
                    type: 'squad_success',
                    message: `¡Has fundado el Squad [${newSquad.name}]!`,
                    newCoins: myUser.coins,
                    squadName: newSquad.name,
                    squadLogo: newSquad.logo,
                    squadId: newSquad._id.toString()
                }));

                // 5. Avisar al resto del mapa para que vean su nueva placa
                broadcast({ type: 'update', id: id, player: players[id] }, ws);

            } catch (err) {
                console.error("Error creando squad:", err);
            }
        }
        // 15. ELIMINAR AMIGO
        if (data.type === 'remove_friend' && isAuthenticated) {
            try {
                const myUser = await User.findOne({ email: currentUser });
                const friendUser = await User.findById(data.targetId);

                if (myUser && friendUser) {
                    // 1. Filtrar las listas para borrar el ID del otro
                    myUser.friends = myUser.friends.filter(fId => fId.toString() !== data.targetId);
                    friendUser.friends = friendUser.friends.filter(fId => fId.toString() !== myUser._id.toString());

                    // 2. Guardar en MongoDB
                    await myUser.save();
                    await friendUser.save();

                    // 3. Actualizar la memoria RAM si tú estás conectado
                    if (players[id]) {
                        players[id].friends = myUser.friends.map(fid => fid.toString());
                    }

                    // 4. (Opcional) Actualizar la memoria RAM del amigo si él también está conectado jugando
                    const friendSocket = Object.keys(players).find(key => players[key].accountId === data.targetId);
                    if (friendSocket && players[friendSocket]) {
                        players[friendSocket].friends = friendUser.friends.map(fid => fid.toString());
                    }

                    // 5. Avisarte que fue un éxito
                    ws.send(encode({ type: 'friend_removed', targetId: data.targetId }));
                }
            } catch (err) {
                console.error("Error eliminando amigo:", err);
            }
        }

        // 16. OBTENER LISTA DE TODOS MIS SQUADS (Con Logo)
        if (data.type === 'get_my_squads_list' && isAuthenticated) {
            try {
                const myUser = await User.findOne({ email: currentUser });
                const mySquads = await Squad.find({ $or: [{ leader: myUser._id }, { 'members.accountId': myUser._id }] });

                if (mySquads.length === 0) return ws.send(encode({ type: 'no_squads_found' }));

                mySquads.sort((a, b) => {
                    const aIsLeader = a.leader.toString() === myUser._id.toString();
                    const bIsLeader = b.leader.toString() === myUser._id.toString();
                    if (aIsLeader && !bIsLeader) return -1;
                    if (!aIsLeader && bIsLeader) return 1;
                    return 0;
                });

                const listData = mySquads.map(sq => ({
                    id: sq._id.toString(), // 🛑 EL FIX: Forzar a que sea texto
                    name: sq.name,
                    logo: sq.logo,
                    isLeader: sq.leader.toString() === myUser._id.toString(),
                    memberCount: sq.members.length + 1
                }));

                ws.send(encode({ type: 'my_squads_list_data', squads: listData }));
            } catch (err) { console.error(err); }
        }

        // 17. OBTENER DETALLES DE UN SQUAD ESPECÍFICO (Con Logo y Stats)
        if (data.type === 'get_squad_details' && isAuthenticated) {
            try {
                const squad = await Squad.findById(data.squadId)
                    // 🛑 EL FIX: Pedir explícitamente los stats de combate y economía
                    .populate('leader', 'username equipped elo kills losses coins')
                    .populate('members.accountId', 'username equipped elo kills losses coins');

                if (!squad) return;

                const squadData = {
                    id: squad._id.toString(),
                    name: squad.name,
                    logo: squad.logo,
                    territoryTimeMinutes: squad.territoryTimeMinutes || 0,
                    milestonesAchieved: squad.milestonesAchieved ? Object.fromEntries(squad.milestonesAchieved) : {},
                    leader: {
                        accountId: squad.leader._id.toString(), // Estandarizado a accountId
                        name: squad.leader.username,
                        equipped: squad.leader.equipped || { head: 'head_default', body: 'body_default', hat: 'none' },
                        elo: squad.leader.elo || 1000,
                        kills: squad.leader.kills || 0,
                        losses: squad.leader.losses || 0,
                        coins: squad.leader.coins || 0
                    },
                    members: squad.members.map(m => {
                        if (!m.accountId) return null;
                        return {
                            accountId: m.accountId._id.toString(),
                            name: m.accountId.username,
                            equipped: m.accountId.equipped || { head: 'head_default', body: 'body_default', hat: 'none' },
                            elo: m.accountId.elo || 1000,
                            kills: m.accountId.kills || 0,
                            losses: m.accountId.losses || 0,
                            coins: m.accountId.coins || 0,
                            title: m.customTitle,
                            canInvite: m.canInvite,
                            canKick: m.canKick,
                            canAssignRoles: m.canAssignRoles,
                            joinedAt: m.joinedAt
                        };
                    }).filter(m => m !== null)
                };

                ws.send(encode({ type: 'my_squad_data', squad: squadData }));
            } catch (err) { console.error(err); }
        }
        // 26. SOLICITAR EL LEADERBOARD (PUNTAJES DE SQUADS Y BASES EN VIVO)
        if (data.type === 'get_squad_leaderboard' && isAuthenticated) {
            try {
                // 1. Obtener a todos los clanes
                const allSquads = await Squad.find({}, 'name logo dailyTimeMinutes weeklyTimeMinutes territoryTimeMinutes').lean();

                // 🛑 EL FIX ARQUITECTÓNICO: Convertir los ObjectId a Strings ligeros antes de enviarlos
                const cleanSquads = allSquads.map(sq => ({
                    ...sq,
                    _id: sq._id.toString()
                }));

                // 2. Preparar la vista "En Vivo"
                const liveBases = [];
                if (centralBase) {
                    let ownerLogo = "";
                    if (centralBase.currentOwnerSquadId) {
                        const sq = await Squad.findOne({ name: centralBase.currentOwnerSquadId });
                        if (sq) ownerLogo = sq.logo;
                    }

                    liveBases.push({
                        name: centralBase.name,
                        owner: centralBase.currentOwnerSquadId || "Nadie",
                        ownerLogo: ownerLogo,
                        hp: centralBase.hp,
                        maxHp: centralBase.maxHp
                    });
                }

                ws.send(encode({
                    type: 'squad_leaderboard_data',
                    squads: cleanSquads, // 👈 Enviamos la lista sanitizada
                    liveBases: liveBases
                }));
            } catch (err) {
                console.error("Error cargando el Leaderboard:", err);
            }
        }
        // 18. NUEVO: EDITAR SQUAD (COBRO DE 350 SOLO SI CAMBIA EL NOMBRE)
        if (data.type === 'edit_squad' && isAuthenticated) {
            try {
                const p = players[id];
                const squad = await Squad.findById(data.squadId);
                const myUser = await User.findOne({ email: currentUser });

                // Seguridad: Verificar si existe y si soy el líder
                if (!squad || squad.leader.toString() !== myUser._id.toString()) {
                    return ws.send(encode({ type: 'edit_squad_error', message: 'No tienes permisos de Líder.' }));
                }

                const newName = data.newName.trim();
                const newLogo = data.newLogo ? data.newLogo.trim() : "";

                if (newName.length < 3 || newName.length > 20) return ws.send(encode({ type: 'edit_squad_error', message: 'El nombre debe tener entre 3 y 20 letras.' }));
                if (newLogo !== "" && !newLogo.startsWith("https://i.pinimg.com/")) return ws.send(encode({ type: 'edit_squad_error', message: 'El logo debe ser una imagen de Pinterest.' }));

                // ¿Cambió el nombre? Si es así, validamos y cobramos 350
                let nameChanged = (newName !== squad.name);
                if (nameChanged) {
                    if (p.coins < 350) return ws.send(encode({ type: 'edit_squad_error', message: 'Necesitas 350 🪙 para cambiar el nombre.' }));

                    const existingSquad = await Squad.findOne({ name: new RegExp('^' + newName + '$', 'i') });
                    if (existingSquad) return ws.send(encode({ type: 'edit_squad_error', message: 'Ese nombre ya está en uso por otra banda.' }));

                    // Cobrar
                    p.coins -= 350;
                    myUser.coins = p.coins;
                    await myUser.save();

                    squad.name = newName;
                }

                squad.logo = newLogo;
                await squad.save();

                ws.send(encode({ type: 'edit_squad_success', message: '¡Actualizado!', newCoins: p.coins, squadId: squad._id, squadName: p.squadName, squadLogo: p.squadLogo }));;
            } catch (err) { ws.send(encode({ type: 'edit_squad_error', message: 'Error del servidor.' })); }
        }// 🔍 BUSCAR SQUADS EN LA BASE DE DATOS
        if (data.type === 'search_squads' && isAuthenticated) {
            try {
                const query = data.query ? data.query.trim() : "";
                let filter = {};

                // Si hay texto, buscamos por nombre (insensible a mayúsculas)
                if (query.length > 0) {
                    filter = { name: { $regex: query, $options: 'i' } };
                }

                // Traemos los resultados (limitado a 20 para no saturar) ordenados por popularidad (territorio)
                const squads = await Squad.find(filter)
                    .sort({ territoryTimeMinutes: -1 })
                    .limit(20)
                    .lean();

                // Empaquetamos TODOS los datos para que el perfil offline se dibuje perfecto
                const results = squads.map(sq => ({
                    id: sq._id.toString(), // 🛑 EL FIX: Forzar a que sea texto
                    name: sq.name,
                    logo: sq.logo,
                    memberCount: (sq.members ? sq.members.length : 0) + 1,
                    infamia: sq.territoryTimeMinutes || 0
                }));

                ws.send(encode({ type: 'squad_search_results', results: results }));
            } catch (err) {
                console.error("Error al buscar squads:", err);
            }
        }

        // 19. EQUIPAR O QUITAR TAG DE SQUAD
        if (data.type === 'toggle_squad_tag' && isAuthenticated) {
            try {
                const myUser = await User.findOne({ email: currentUser });
                const p = players[id];
                const squadId = data.squadId;

                // 1. Verificar que el jugador realmente pertenezca a este clan
                const squad = await Squad.findById(squadId);
                if (!squad) return;

                const isLeader = squad.leader.toString() === myUser._id.toString();
                const isMember = squad.members.some(m => m.accountId.toString() === myUser._id.toString());

                if (!isLeader && !isMember) {
                    return ws.send(encode({ type: 'squad_error', message: 'No perteneces a este squad.' }));
                }

                // 2. Lógica del "Interruptor" (Toggle)
                let isActive = false;

                // Si el squad que me envió es el mismo que ya tengo equipado, significa que lo quiero QUITAR
                if (myUser.squad && myUser.squad.toString() === squadId) {
                    myUser.squad = null; p.squad = null; p.squadName = null; p.squadLogo = null;
                    p.squadCanInvite = false; // Pierdes el permiso
                    isActive = false;

                } else {
                    // Si es distinto o estaba en null, lo quiero EQUIPAR (reemplaza a cualquier otro)
                    myUser.squad = squad._id; p.squad = squad._id.toString(); p.squadName = squad.name; p.squadLogo = squad.logo;
                    p.squadCanInvite = isLeader || (isMember && squad.members.find(m => m.accountId.toString() === myUser._id.toString()).canInvite);
                    isActive = true;
                }

                // 3. Guardar en Base de Datos y avisar a todos
                await myUser.save();

                ws.send(encode({ type: 'toggle_squad_success', isActive: isActive, squadId: squadId, squadName: p.squadName, squadLogo: p.squadLogo }));

                // Avisarle a los demás jugadores conectados que cambiaste tu Tag
                broadcast({ type: 'update', id: id, player: p }, ws);

            } catch (err) {
                console.error("Error al hacer toggle del tag:", err);
            }
        }// 20. ENVIAR INVITACIÓN AL CLAN
        if (data.type === 'send_squad_invite' && isAuthenticated) {
            try {
                const p = players[id];
                if (!p.squad) return ws.send(encode({ type: 'squad_error', message: 'Primero equipa tu Tag para invitar.' }));

                const squad = await Squad.findById(p.squad);
                if (!squad) return;

                const myUser = await User.findOne({ email: currentUser });
                const isLeader = squad.leader.toString() === myUser._id.toString();
                const memberData = squad.members.find(m => m.accountId.toString() === myUser._id.toString());
                const canInvite = isLeader || (memberData && memberData.canInvite);

                if (!canInvite) return ws.send(encode({ type: 'squad_error', message: 'No tienes permisos para reclutar.' }));

                // --- NUEVA VALIDACIÓN: ¿El objetivo ya está en ESTE clan? ---
                const targetIsLeader = squad.leader.toString() === data.targetAccountId;
                const targetIsMember = squad.members.some(m => m.accountId.toString() === data.targetAccountId);

                if (targetIsLeader || targetIsMember) {
                    return ws.send(encode({ type: 'squad_error', message: 'Este jugador ya pertenece a tu clan.' }));
                }

                // Buscar al objetivo y ver si está conectado
                let targetWsId = null;
                for (let pid in players) {
                    if (players[pid].accountId === data.targetAccountId) targetWsId = pid;
                }

                if (targetWsId) {
                    wss.clients.forEach(client => {
                        if (client.playerId === targetWsId && client.readyState === WebSocket.OPEN) {
                            client.send(encode({
                                type: 'squad_invite',
                                squadId: squad._id.toString(), // 🛑 EL FIX 2: Evita enviar como Buffer Binario
                                squadName: squad.name,
                                senderUsername: p.username,
                                senderFrameX: p.frameX,
                                senderFrameY: p.frameY
                            }));
                        }
                    });
                    ws.send(encode({ type: 'squad_success', message: 'Invitación enviada.' }));
                } else {
                    ws.send(encode({ type: 'squad_error', message: 'El jugador no está en línea.' }));
                }
            } catch (err) { console.error("Error invitando al clan:", err); }
        }

        // 21. ACEPTAR INVITACIÓN AL CLAN
        if (data.type === 'accept_squad_invite' && isAuthenticated) {
            try {
                // 🛑 ESCUDO ANTI-BUFFER
                const cleanSquadId = data.squadId.buffer ? Buffer.from(data.squadId).toString('hex') : data.squadId.toString();

                const squad = await Squad.findById(cleanSquadId);
                if (!squad) return ws.send(encode({ type: 'squad_error', message: 'El clan ya no existe.' }));

                const myUser = await User.findOne({ email: currentUser });

                // Regla 1: Límite de miembros
                if (squad.members.length >= 24) return ws.send(encode({ type: 'squad_error', message: 'El clan está lleno.' }));

                // Regla 2: ¿Ya estoy en este clan?
                const isMember = squad.members.some(m => m.accountId.toString() === myUser._id.toString());
                const isLeader = squad.leader.toString() === myUser._id.toString();

                if (!isMember && !isLeader) {

                    // 1. Agregar al jugador a la Base de Datos del Clan
                    squad.members.push({ accountId: myUser._id });
                    await squad.save();

                    // 2. 🛑 EL FIX 3: Sellar el Clan en la Base de Datos del Jugador
                    myUser.squad = squad._id;
                    await myUser.save();

                    // 3. Actualizar la RAM del servidor
                    if (players[id]) {
                        players[id].squad = squad._id.toString();
                        players[id].squadName = squad.name;
                        players[id].squadLogo = squad.logo;
                        players[id].squadCanInvite = false; // Entra sin poderes
                    }

                    // 4. Avisar al jugador del éxito (Enviando sus nuevos datos)
                    ws.send(encode({
                        type: 'squad_success',
                        message: `¡Te has unido al clan [${squad.name}]!`,
                        squadName: squad.name,
                        squadLogo: squad.logo,
                        squadId: squad._id.toString() // 🛑 EL FIX: Enviar el ID a la RAM
                    }));

                    // 5. Avisar a todo el mapa que el jugador tiene nuevo Tag
                    broadcast({ type: 'update', id: id, player: players[id] }, ws);

                } else {
                    ws.send(encode({ type: 'squad_error', message: 'Ya eres miembro de este clan.' }));
                }
            } catch (err) { console.error("Error aceptando clan:", err); }
        }
        // 22. GUARDAR PIVOTE DE ARMA (GANI WEAPON MODE)
        if (data.type === 'update_weapon_pivot' && isAuthenticated) {
            try {
                if (players[id].role !== 'admin') return;

                await Item.findOneAndUpdate(
                    { id: data.weaponId },
                    { $set: { "stats.pivotX": data.pivotX, "stats.pivotY": data.pivotY } }
                );

                if (WEAPONS[data.weaponId]) {
                    WEAPONS[data.weaponId].pivotX = data.pivotX;
                    WEAPONS[data.weaponId].pivotY = data.pivotY;
                }

                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(encode({ type: 'sync_weapon_pivot', weaponId: data.weaponId, pivotX: data.pivotX, pivotY: data.pivotY }));
                    }
                });
            } catch (err) { console.error("Error guardando pivote:", err); }
        }

        // 23. GUARDAR ESTADÍSTICAS MELEE (SISTEMA DIRECCIONAL WASD)
        if (data.type === 'update_melee_stats' && isAuthenticated) {
            try {
                if (players[id].role !== 'admin') return;

                let itemDoc = await Item.findOne({ id: data.weaponId });
                if (!itemDoc) return;

                if (!itemDoc.stats) itemDoc.stats = {};
                if (!itemDoc.stats.dirStats) itemDoc.stats.dirStats = {};

                itemDoc.stats.dirStats[String(data.direction)] = data.stats;
                itemDoc.markModified(`stats.dirStats.${data.direction}`);
                await itemDoc.save();

                if (!WEAPONS[data.weaponId]) WEAPONS[data.weaponId] = { type: "melee", dirStats: {} };
                if (!WEAPONS[data.weaponId].dirStats) WEAPONS[data.weaponId].dirStats = {};
                WEAPONS[data.weaponId].dirStats[data.direction] = data.stats;

                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(encode({ type: 'sync_melee_stats', weaponId: data.weaponId, direction: data.direction, stats: data.stats }));
                    }
                });
            } catch (err) { console.error("💥 ERROR al guardar en MongoDB:", err); }
        }// 24. RECOGER BASURA CON EL TRASH PICKER
        if (data.type === 'pickup_trash' && isAuthenticated) {
            const itemId = data.itemId;
            const item = groundItems[itemId];
            const p = players[id];

            if (item && p.equippedWeapon === 'trash_picker') {
                delete groundItems[itemId];

                if (!p.inventory) p.inventory = [];

                // 🛑 EL FIX: SISTEMA APILABLE (STACKABLE)
                // Buscamos si ya tiene un "montón" de este tipo de basura
                let existingStack = p.inventory.find(i => typeof i === 'object' && i.id === item.templateId);

                if (existingStack) {
                    existingStack.quantity += 1; // Le sumamos 1 a su montón
                } else {
                    // Si no lo tiene, creamos el primer montón
                    p.inventory.push({ id: item.templateId, quantity: 1 });
                }

                broadcast({ type: 'remove_item', id: itemId });

                // Avisamos visualmente que entró a la mochila
                ws.send(encode({
                    type: 'system_message',
                    text: `🎒 Recogiste: ${item.name}`,
                    color: '#3498db'
                }));

                // 🛑 EL FIX: El servidor le envía a tu pantalla tu nueva mochila
                ws.send(encode({
                    type: 'inventory_update',
                    inventory: p.inventory
                }));

                broadcast({ type: 'update', id: id, player: p }, ws);
            }
        }// 25. VENDER TODA LA BASURA EN EL YONKE
        if (data.type === 'sell_all_trash' && isAuthenticated) {
            const p = players[id];
            if (!p.inventory) return;

            let totalEarned = 0;
            let newInventory = [];

            // Separar la basura de las armas a prueba de errores
            for (let item of p.inventory) {
                let isTrash = false;

                // A. Formato Nuevo (Objeto: {id: "trash_lata", quantity: 5})
                if (typeof item === 'object' && item.id && item.id.startsWith('trash_')) {
                    let catalogItem = TRASH_CATALOG.find(t => t.id === item.id);
                    if (catalogItem) {
                        // Si por algún error no tiene quantity, asumimos que es 1
                        const qty = item.quantity || 1;
                        totalEarned += (catalogItem.value * qty);
                        isTrash = true;
                    }
                }
                // B. Formato Viejo de Pruebas Anteriores (String: "trash_lata")
                else if (typeof item === 'string' && item.startsWith('trash_')) {
                    let catalogItem = TRASH_CATALOG.find(t => t.id === item);
                    if (catalogItem) {
                        totalEarned += catalogItem.value;
                        isTrash = true;
                    }
                }

                // C. Conservar si NO es basura (Ej. Armas o items no registrados)
                if (!isTrash) {
                    newInventory.push(item);
                }
            }

            // Si encontró dinero, hacemos la transacción
            if (totalEarned > 0) {
                p.coins += totalEarned;
                p.inventory = newInventory;

                ws.send(encode({
                    type: 'sell_success',
                    earned: totalEarned,
                    newCoins: p.coins,
                    newInventory: p.inventory
                }));
                broadcast({ type: 'update', id: id, player: p }, ws);
            } else {
                // 🛑 EL FIX: Si por algo falla, que el servidor te avise en pantalla en lugar de ignorarte
                ws.send(encode({ type: 'system_message', text: "Error: No se encontró basura válida para vender.", color: '#e74c3c' }));
            }
        }// 28. ACTUALIZAR ROL DE UN MIEMBRO DEL CLAN
        if (data.type === 'update_squad_member' && isAuthenticated) {
            try {
                const myUser = await User.findOne({ email: currentUser });
                if (!myUser.squad) return;

                const squad = await Squad.findById(myUser.squad);
                if (!squad) return;

                // 1. Verificar si tengo permisos
                const isLeader = squad.leader.toString() === myUser._id.toString();
                const myData = squad.members.find(m => m.accountId.toString() === myUser._id.toString());
                const iCanAssignRoles = isLeader || (myData && myData.canAssignRoles);

                if (!iCanAssignRoles) return ws.send(encode({ type: 'system_message', text: "No tienes permisos de Administrador en el Clan.", color: "#e74c3c" }));

                // 2. Buscar al miembro que queremos editar
                const targetMember = squad.members.find(m => m.accountId.toString() === data.targetAccountId);
                if (!targetMember) return;

                // 3. Aplicar cambios
                targetMember.customTitle = data.title;
                targetMember.canInvite = data.canInvite;
                targetMember.canKick = data.canKick;
                targetMember.canAssignRoles = data.canAssignRoles;

                await squad.save();
                ws.send(encode({ type: 'get_squad_details', squadId: squad._id.toString() }));

                // 🛑 NUEVO: Avisarle al miembro afectado en TIEMPO REAL si le cambiaron sus poderes
                let targetWsId = Object.keys(players).find(key => players[key].accountId === data.targetAccountId);
                if (targetWsId && players[targetWsId]) {
                    players[targetWsId].squadCanInvite = data.canInvite;
                    wss.clients.forEach(c => {
                        if (c.playerId === targetWsId && c.readyState === WebSocket.OPEN) {
                            c.send(encode({ type: 'update_permissions', canInvite: data.canInvite }));
                        }
                    });
                }

            } catch (err) {
                console.error("Error editando roles del squad:", err);
            }
        } // =========================================================
        // 🛑 NUEVO: VENDER CANTIDAD ESPECÍFICA DE UN ÍTEM INDIVIDUAL (YONKE) 🛑
        // =========================================================
        if (data.type === 'sell_individual_trash' && isAuthenticated) {
            const p = players[id];
            const requestedItemId = data.itemId;
            const requestedQty = parseInt(data.quantity);

            // 1. Validaciones de seguridad básicas
            if (!p.inventory || !requestedItemId || !requestedQty || requestedQty <= 0) return;

            // 2. Buscar el ítem en el Catálogo de MongoDB (TRASH_CATALOG) para saber su valor
            const catalogItem = TRASH_CATALOG.find(t => t.id === requestedItemId);
            if (!catalogItem) return; // Trampa o ítem no existe

            // 3. Buscar el montón (Stack) de ese ítem en tu inventario apilable
            let stackIndex = -1;
            let existingStack = p.inventory.find((item, index) => {
                if (typeof item === 'object' && item.id === requestedItemId) {
                    stackIndex = index;
                    return true;
                }
                return false;
            });

            // 4. Validar que tengas suficientes para vender
            if (!existingStack || existingStack.quantity < requestedQty) {
                ws.send(encode({ type: 'system_message', text: "🛑 No tienes suficiente cantidad de este ítem.", color: '#e74c3c' }));
                return;
            }

            // 5. HACER LA TRANSACCIÓN
            const totalEarned = catalogItem.value * requestedQty;
            p.coins += totalEarned;

            // Descontar cantidad del inventario
            existingStack.quantity -= requestedQty;

            // Si el montón llegó a 0, borrar el objeto del array por completo
            if (existingStack.quantity <= 0) {
                p.inventory.splice(stackIndex, 1);
            }

            console.log(`🏗️ Venta Individual: ${p.name} vendió x${requestedQty} ${catalogItem.name} por ${totalEarned} 🪙`);

            // 7. Avisar al cliente del éxito (Reusamos el paquete sell_success existente en demo.html)
            ws.send(encode({
                type: 'sell_success',
                earned: totalEarned, // Monto de esta venta específica
                newCoins: p.coins,
                newInventory: p.inventory
            }));

            broadcast({ type: 'update', id: id, player: p }, ws);
        }// ⛏️ NUEVO: SISTEMA DE EXCAVACIÓN (CON FATIGA DINÁMICA BASADA EN EL ARMA)
        if (data.type === 'dig' && isAuthenticated) {
            const p = players[id];
            if (!p) return;

            const now = Date.now();

            // 👇 NUEVO: LEER ESTADÍSTICAS DE LA PALA DESDE LA RAM DEL SERVIDOR 👇
            const weaponId = p.equippedWeapon || 'none';
            const weaponStats = WEAPONS[weaponId] || {};

            // Extraemos la resistencia de la pala (Por defecto 15 si es básica o no está configurada)
            const maxSwingsAllowed = weaponStats.maxFatigue || 15;

            // ==========================================
            // 🛡️ CAPA 1: FATIGA DE MINERO (DINÁMICA)
            // ==========================================
            // Si pasaron más de 8 segundos sin excavar, el jugador recupera su energía
            if (now - (p.lastDigTime || 0) > 8000) {
                p.digFatigue = 0;
            }

            // Cooldown básico de 1 segundo entre palazos
            if (now - (p.lastDigTime || 0) < 1000) return;

            p.digFatigue = (p.digFatigue || 0) + 1;
            p.lastDigTime = now;

            // 🛑 EL FIX: Comparamos contra la resistencia de LA PALA, no un número fijo
            if (p.digFatigue > maxSwingsAllowed) {
                ws.send(encode({
                    type: 'system_message',
                    text: `Estás exhausto. ${maxSwingsAllowed} golpes seguidos. Descansa.`,
                    color: '#e74c3c'
                }));
                // Engañamos al timer poniéndolo en el futuro para forzar el descanso
                p.lastDigTime = now + 8000;
                return;
            }

            const hitX = data.hitX;
            const hitY = data.hitY;

            // 🛡️ ANTI-HACK: Validar que la pala alcance la tierra
            const distToDig = Math.hypot(p.worldX - hitX, p.worldY - hitY);
            if (distToDig > 80) { // 80 píxeles es un buen margen
                return; // Ignorar si intenta minar a distancia
            }

            // ==========================================
            // 🛡️ CAPA 2: TIERRA AGOTADA (ANTI-AUTO-CLICK)
            // ==========================================
            p.lastDigLocationX = p.lastDigLocationX || 0;
            p.lastDigLocationY = p.lastDigLocationY || 0;

            const distFromLastDig = Math.hypot(p.worldX - p.lastDigLocationX, p.worldY - p.lastDigLocationY);

            if (p.lastDigLocationX !== 0 && distFromLastDig < 40) {
                ws.send(encode({
                    type: 'system_message',
                    text: "Ya escarbaste todo aquí. ¡Camina hacia otro lado!",
                    color: '#e67e22'
                }));
                broadcast({ type: 'spawn_hole', x: hitX, y: hitY }, ws);
                ws.send(encode({ type: 'spawn_hole', x: hitX, y: hitY }));
                return;
            }

            // ==========================================
            // 🌍 LÓGICA NORMAL DE ZONAS Y PREMIOS
            // ==========================================
            let inDigZone = false;
            for (let z of safeZonesRAM) {
                if (z.zoneType === 'dig' && hitX >= z.xMin && hitX <= z.xMax && hitY >= z.yMin && hitY <= z.yMax) {
                    inDigZone = true;
                    break;
                }
            }

            if (!inDigZone) {
                ws.send(encode({ type: 'system_message', text: "Aquí no hay tierra blanda para excavar.", color: '#e67e22' }));
                return;
            }

            p.lastDigLocationX = p.worldX;
            p.lastDigLocationY = p.worldY;

            broadcast({ type: 'spawn_hole', x: hitX, y: hitY }, ws);
            ws.send(encode({ type: 'spawn_hole', x: hitX, y: hitY }));

            if (Math.random() <= 0.40 && METALS_CATALOG.length > 0) {
                const foundItem = METALS_CATALOG[Math.floor(Math.random() * METALS_CATALOG.length)];

                if (!p.inventory) p.inventory = [];
                let existingStack = p.inventory.find(i => typeof i === 'object' && i.id === foundItem.id);
                if (existingStack) {
                    existingStack.quantity += 1;
                } else {
                    p.inventory.push({ id: foundItem.id, quantity: 1 });
                }

                User.findByIdAndUpdate(p.accountId, { inventory: p.inventory }).catch(console.error);

                ws.send(encode({ type: 'system_message', text: `💎 Desenterraste: ${foundItem.name}!`, color: '#3498db' }));
                ws.send(encode({ type: 'inventory_update', inventory: p.inventory }));
                broadcast({ type: 'update', id: id, player: p }, ws);
            }
        }// =========================================================
        // 💎 VENDER TODOS LOS METALES (JOYERÍA)
        // =========================================================
        if (data.type === 'sell_all_metals' && isAuthenticated) {
            const p = players[id];
            if (!p.inventory) return;

            let totalEarned = 0;
            let newInventory = [];

            for (let item of p.inventory) {
                let isMetal = false;
                if (typeof item === 'object' && item.id) {
                    let catalogItem = METALS_CATALOG.find(m => m.id === item.id);
                    if (catalogItem) {
                        const qty = item.quantity || 1;
                        totalEarned += (catalogItem.value * qty);
                        isMetal = true;
                    }
                }

                if (!isMetal) {
                    newInventory.push(item); // Conservamos lo que no sea metal
                }
            }

            if (totalEarned > 0) {
                p.coins += totalEarned;
                p.inventory = newInventory;
                ws.send(encode({ type: 'sell_success', earned: totalEarned, newCoins: p.coins, newInventory: p.inventory }));
                broadcast({ type: 'update', id: id, player: p }, ws);
            } else {
                ws.send(encode({ type: 'system_message', text: "Error: No se encontraron metales para vender.", color: '#e74c3c' }));
            }
        }
        // =========================================================
        // 💎 VENDER METAL INDIVIDUAL
        // =========================================================
        if (data.type === 'sell_individual_metal' && isAuthenticated) {
            const p = players[id];
            const requestedItemId = data.itemId;
            const requestedQty = parseInt(data.quantity);

            if (!p.inventory || !requestedItemId || !requestedQty || requestedQty <= 0) return;

            const catalogItem = METALS_CATALOG.find(m => m.id === requestedItemId);
            if (!catalogItem) return;

            let stackIndex = -1;
            let existingStack = p.inventory.find((item, index) => {
                if (typeof item === 'object' && item.id === requestedItemId) {
                    stackIndex = index;
                    return true;
                }
                return false;
            });

            if (!existingStack || existingStack.quantity < requestedQty) {
                ws.send(encode({ type: 'system_message', text: "🛑 No tienes suficiente cantidad de este metal.", color: '#e74c3c' }));
                return;
            }

            const totalEarned = catalogItem.value * requestedQty;
            p.coins += totalEarned;
            existingStack.quantity -= requestedQty;

            if (existingStack.quantity <= 0) {
                p.inventory.splice(stackIndex, 1);
            }

            // Reusamos sell_success para que el cliente procese la animación de monedas y cierre la tienda
            ws.send(encode({ type: 'sell_success', earned: totalEarned, newCoins: p.coins, newInventory: p.inventory }));
            broadcast({ type: 'update', id: id, player: p }, ws);

        } else if (data.type === 'sync_weapon_pivot') {
            if (weaponsDB[data.weaponId]) {
                weaponsDB[data.weaponId].pivotX = data.pivotX;
                weaponsDB[data.weaponId].pivotY = data.pivotY;
            }
        }
        else if (data.type === 'save_skeleton_data') {
            skeletonRAM = data.anchors;
            const globalHandTile = data.handTile; // Guardarlo en memoria

            // Guardar permanentemente en MongoDB
            Skeleton.findOneAndUpdate({}, {
                anchors: skeletonRAM,
                handTile: globalHandTile
            }, { upsert: true })

            // 2. ¡MAGIA! Rebotamos la animación a TODOS los jugadores en vivo
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(encode({
                        type: 'sync_skeleton',
                        anchors: skeletonRAM
                    }));
                }
            });

            // 3. Guardar en MongoDB para que NUNCA se borre al reiniciar el server
            Skeleton.findOneAndUpdate({}, { anchors: skeletonRAM }, { upsert: true })
                .then(() => console.log("🦴 Animación Gani guardada en la Base de Datos!"))
                .catch(err => console.error("Error guardando Gani:", err));
        }// --- NUEVO: SISTEMA DE DAÑO A LA BASE DE CLANES (TURF WARS) ---
        if (data.type === 'damage_base' && isAuthenticated) {
            const shooter = players[id];

            // 1. Reglas: Tienes que tener un arma, un clan, y la base debe existir
            if (!shooter || !shooter.squad || !centralBase) return;

            const stats = WEAPONS[data.weaponId];
            if (!stats) return;

            // 2. Anti-spam de daño/curación
            const now = Date.now();
            if (now - (shooter.lastBaseDamageTime || 0) < ((stats.fireRate || 300) - 50)) return;
            shooter.lastBaseDamageTime = now;

            const actualDamage = Number(stats.damage) || 10;

            // 🛑 EL FIX: BIFURCACIÓN DE LÓGICA (CURAR VS DESTRUIR)
            // Comparamos si el dueño actual es exactamente el nombre de tu clan
            if (centralBase.currentOwnerSquadId === shooter.squadName) {

                // 3A. RUTINA DE REPARACIÓN (Fuego Amigo)
                // Si la base ya está al 100%, no hacemos nada
                if (centralBase.hp >= centralBase.maxHp) return;

                centralBase.hp += actualDamage;

                // Evitamos sobrecurar la base
                if (centralBase.hp > centralBase.maxHp) {
                    centralBase.hp = centralBase.maxHp;
                }

            } else {

                // 3B. RUTINA DE ATAQUE (Enemigos)
                centralBase.hp -= actualDamage;
                centralBase.lastHitTime = Date.now(); // ⏱️ ¡REGISTRAMOS EL GOLPE!

                // Registrar en la "Libreta de Daño" quién le está pegando
                if (!centralBase.damageTracker[shooter.squadName]) centralBase.damageTracker[shooter.squadName] = 0;
                centralBase.damageTracker[shooter.squadName] += actualDamage;

                // ¿SE DESTRUYÓ LA BASE? (Llegó a 0)
                if (centralBase.hp <= 0) {
                    let topSquad = null;
                    let maxDamage = 0;
                    for (let sqName in centralBase.damageTracker) {
                        if (centralBase.damageTracker[sqName] > maxDamage) {
                            maxDamage = centralBase.damageTracker[sqName];
                            topSquad = sqName;
                        }
                    }

                    centralBase.currentOwnerSquadId = topSquad;
                    centralBase.hp = centralBase.maxHp;
                    centralBase.damageTracker = {};

                    console.log(`🏆 El Squad [${topSquad}] ha capturado ${centralBase.name}!`);

                    // 🛑 EL FIX: GUARDAR EL NUEVO DUEÑO EN MONGODB
                    Turf.findOneAndUpdate(
                        { turfId: centralBase.turfId },
                        { ownerSquadName: topSquad, hp: centralBase.maxHp }
                    ).catch(err => console.error("Error guardando Turf:", err));
                }
            }

            // 4. Avisar a todas las pantallas cómo va la vida de la base (sea daño o curación)
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(encode({ type: 'base_update', base: centralBase }));
                }
            });
        }

    });

    /// 4. DISCONNECT
    ws.on('close', async () => {
        // ONLY save if they logged in! We don't want to save Guest coordinates to the DB
        if (isAuthenticated && players[id]) {
            try {
                const user = await User.findOne({ email: currentUser });
                if (user) {
                    user.worldX = players[id].worldX;
                    user.worldY = players[id].worldY;
                    user.equippedWeapon = players[id].equippedWeapon;
                    user.hotbar = players[id].hotbar;
                    user.quickSwaps = players[id].quickSwaps;
                    user.coins = players[id].coins;
                    user.gems = players[id].gems;
                    user.hp = players[id].hp;
                    user.isDead = players[id].isDead;
                    user.kills = players[id].kills;
                    user.losses = players[id].losses;
                    user.elo = players[id].elo;
                    user.inventory = players[id].inventory;
                    user.equipped = players[id].equipped;

                    // 🌟 Mongoose-safe way to save Mixed objects 🌟
                    user.taskProgress = players[id].taskProgress || {};
                    user.claimedTasks = players[id].claimedTasks || {};
                    user.markModified('taskProgress');
                    user.markModified('claimedTasks');

                    await user.save();
                }
            } catch (err) { console.error(err); }
        }

        delete players[id];
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(encode({ type: 'left', id: id }));
            }
        });
        broadcast({ type: 'player_count', count: Object.keys(players).length });
    });

    // 2. FETCH WORLD DATA
    // 2. FETCH WORLD DATA (Cleaned for MessagePack)
    const allTiles = await Tile.find({}, { _id: 0, __v: 0 }).lean();

    // 3. TELL THE NEW GUEST WHO THEY ARE (INIT)
    ws.send(encode({
        type: 'init',
        id: id,
        playlist: GLOBAL_BGM_PLAYLIST, // 🛑 LA SOLUCIÓN: Le decimos qué canción debe poner apenas entre
        players: Object.fromEntries(Object.entries(players).filter(([k, v]) => !v.invisibleEnabled || k === id)),
        worldMap: allTiles,
        weaponsDB: WEAPONS,
        tilesetsDB: TILESETS,
        safeZones: safeZonesRAM, // <--- ¡NUEVO: Enviamos los rectángulos de paz al jugador!
        skeleton: skeletonRAM, // <--- ¡ESTA ES LA LÍNEA QUE FALTABA!
        centralBase: centralBase, // 🛑 EL FIX: Añadimos la base a la memoria del cliente
        groundItems: groundItems, // 🛑 EL FIX: Mandar la basura a los jugadores nuevos
        trashCatalog: TRASH_CATALOG,
        masterCatalog: MASTER_CATALOG, // 📦 EL FIX: Enviamos toda la ropa e ítems
        zoneConfig: ZONE_CONFIG, // <--- 👇 AÑADE ESTA LÍNEA 👇
        ranksDB: RANKS_CACHE,
        patchNotes: PATCH_NOTES_CACHE, // 📰 NUEVO: Enviamos las noticias

        // 🌟 TAREAS Y LOGROS GLOBALES 🌟
        globalTasks: GLOBAL_TASKS,
        taskProgress: {}, // Guests start with empty progress
        claimedTasks: {}
    }));

    // 4. NOW TELL THE LOBBY A GUEST HAS ARRIVED
    wss.clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(encode({ type: 'joined', id: id, player: players[id] }));
        }
    });

    broadcast({ type: 'player_count', count: Object.keys(players).length });
});

// Global Broadcast (Only for things like server shutdown or global events)
function broadcast(data, excludeWs = null) {
    if (data && data.player && data.player.invisibleEnabled) return; // Completely hide from global broadcasts
    const payload = encode(data);
    wss.clients.forEach((client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

// =========================================================
// 🥊 MATCHMAKER GLOBAL (Soporta 1v1, 2v2, 3v1, 4v4, etc.)
// =========================================================
setInterval(() => {
    for (let aId in arenasRAM) {
        let arena = arenasRAM[aId];

        // 1. Limpiar desconectados de la cola
        arena.queue = arena.queue.filter(pid => players[pid] && !players[pid].isDead);

        // 🛑 EL FIX: Asegurar que los números sean reales, si no, por defecto 1v1
        const t1Needed = parseInt(arena.team1Size) || 1;
        const t2Needed = parseInt(arena.team2Size) || 1;
        const totalPlayersNeeded = t1Needed + t2Needed;

        // 2. Si la arena está libre y la cola tiene suficientes jugadores...
        if (!arena.isOccupied && arena.queue.length >= totalPlayersNeeded) {
            arena.isOccupied = true;
            arena.team1 = [];
            arena.team2 = [];
            arena.aliveTeam1 = t1Needed;
            arena.aliveTeam2 = t2Needed;

            // 3. Repartir a los jugadores de la fila en los equipos
            for (let i = 0; i < t1Needed; i++) {
                arena.team1.push(arena.queue.shift());
            }
            for (let i = 0; i < t2Needed; i++) {
                arena.team2.push(arena.queue.shift());
            }

            // Para la pantalla, marcamos a los primeros de la lista como los "Representantes"
            arena.fighter1 = arena.team1[0];
            arena.fighter2 = arena.team2[0];

            // Avisar a la UI que la lista cambió y la pelea empezó
            broadcast({ type: 'refresh_arena_ui', arenaId: aId });

            // 4. Preparar y Teletransportar al EQUIPO 1 (Azul)
            arena.team1.forEach((pid, index) => {
                let p = players[pid];
                p.isSparring = true;
                p.arenaTeam = 1;
                p.hp = 100;

                const spawnOffset = (index * 32) - (((t1Needed - 1) * 32) / 2);
                const worldSpawnX = (arena.p1X * 16) + 8 + spawnOffset;
                const worldSpawnY = (arena.p1Y * 16) + 8;

                // 👇 EL FIX: Guardar en RAM 👇
                p.worldX = worldSpawnX;
                p.worldY = worldSpawnY;

                wss.clients.forEach(c => {
                    if (c.playerId === pid && c.readyState === WebSocket.OPEN) {
                        c.send(encode({ type: 'match_found', targetX: worldSpawnX, targetY: worldSpawnY }));
                    }
                });
            });

            // 5. Preparar y Teletransportar al EQUIPO 2 (Rojo)
            arena.team2.forEach((pid, index) => {
                let p = players[pid];
                p.isSparring = true;
                p.arenaTeam = 2;
                p.hp = 100;

                const spawnOffset = (index * 32) - (((t2Needed - 1) * 32) / 2);
                const worldSpawnX = (arena.p2X * 16) + 8 + spawnOffset;
                const worldSpawnY = (arena.p2Y * 16) + 8;

                // 👇 EL FIX: Guardar en RAM 👇
                p.worldX = worldSpawnX;
                p.worldY = worldSpawnY;

                wss.clients.forEach(c => {
                    if (c.playerId === pid && c.readyState === WebSocket.OPEN) {
                        c.send(encode({ type: 'match_found', targetX: worldSpawnX, targetY: worldSpawnY }));
                    }
                });
            });
        }
    }
}, 3000);
// =========================================================
// 🗑️ SISTEMA DE BASURA (DENTRO DE "TRASH ZONES" UNIVERSALES)
// =========================================================
let groundItems = {};

setInterval(() => {
    if (TRASH_CATALOG.length === 0) return;

    const currentTrashCount = Object.keys(groundItems).length;

    if (currentTrashCount < 80) {

        // 1. Filtrar las zonas que sean específicamente para basura
        const trashZones = safeZonesRAM.filter(z => z.zoneType === 'trash');

        // Si el Admin no ha dibujado ninguna Zona de Basura, cancelamos el proceso
        if (trashZones.length === 0) return;

        const spawnAmount = Math.min(5, 80 - currentTrashCount);

        for (let i = 0; i < spawnAmount; i++) {
            let validPos = false;
            let sx, sy;
            let attempts = 0;

            while (!validPos && attempts < 20) {
                // 1. Elegimos una de las Zonas de Basura al azar
                const targetZone = trashZones[Math.floor(Math.random() * trashZones.length)];

                // 2. Spawneamos estrictamente DENTRO de esa zona
                sx = (Math.random() * (targetZone.xMax - targetZone.xMin)) + targetZone.xMin;
                sy = (Math.random() * (targetZone.yMax - targetZone.yMin)) + targetZone.yMin;

                // 👇 EL FIX ESTRICTO: Revisar el bloque completo (Grid) 👇
                const gridX = Math.floor(sx / 16); // 16 es tu TILE_SIZE
                const gridY = Math.floor(sy / 16);

                let hitWall = false;

                // Escaneamos las 16 capas de ESE cuadrito exacto
                for (let l = 0; l <= 15; l++) {
                    const tileKey = `${gridX},${gridY},${l}`;
                    if (serverWorldMap[tileKey] && serverWorldMap[tileKey].hasCollision) {
                        hitWall = true;
                        break; // Chocó con algo, detenemos la búsqueda en esta capa
                    }
                }

                let inSafeZone = isInSafeZone(sx, sy); // Evita conflictos de zonas cruzadas

                // Si el bloque está totalmente libre y no es zona segura, es válido
                if (!hitWall && !inSafeZone) {
                    validPos = true;
                }
                attempts++;
            }

            if (validPos) {
                const itemId = "trash_" + Math.random().toString(36).substr(2, 9);
                const tType = TRASH_CATALOG[Math.floor(Math.random() * TRASH_CATALOG.length)];

                groundItems[itemId] = {
                    x: sx, y: sy, type: "trash", templateId: tType.id,
                    sx: tType.sx, sy: tType.sy, value: tType.value, name: tType.name
                };

                broadcast({ type: 'spawn_item', id: itemId, item: groundItems[itemId] });
            }
        }
    }
}, 3000);

// =========================================================
// ⏱️ MOTOR DE RECOMPENSAS DE TURF WARS (ZONAS DE CAPTURA)
// =========================================================
setInterval(async () => {
    // 1. ¿Existe la base y tiene dueño actualmente?
    if (centralBase && centralBase.currentOwnerSquadId) {
        try {
            const ownerSquad = centralBase.currentOwnerSquadId;
            console.log(`🏰 [TURF WARS] El clan [${ownerSquad}] ha mantenido la base por otro minuto.`);

            // 2. GUARDAR EL TIEMPO EN MONGODB (Total, Diario y Semanal)
            const updatedSquad = await Squad.findOneAndUpdate(
                { name: ownerSquad },
                {
                    $inc: {
                        territoryTimeMinutes: 1,
                        dailyTimeMinutes: 1,
                        weeklyTimeMinutes: 1
                    }
                },
                { returnDocument: 'after' }
            );

            // --- NUEVO: REVISAR METAS CUMPLIDAS EXACTAMENTE AHORA ---
            if (updatedSquad) {
                let changed = false;
                if (!updatedSquad.milestonesAchieved) updatedSquad.milestonesAchieved = new Map();
                for (let taskId in GLOBAL_TASKS) {
                    const task = GLOBAL_TASKS[taskId];
                    if (task.requirementType === 'squad_base_minutes') {
                        // Si alcanzaron la meta y an no tiene fecha guardada
                        if (updatedSquad.territoryTimeMinutes >= task.requirementValue && !updatedSquad.milestonesAchieved.has(taskId)) {
                            updatedSquad.milestonesAchieved.set(taskId, Date.now());
                            changed = true;
                            console.log(`[LOGRO SQUAD] El clan [${ownerSquad}] alcanzo la meta: ${taskId}`);
                        }
                    }
                }
                if (changed) {
                    await updatedSquad.save();
                }
            }

        } catch (err) {
            console.error("💥 Error en el cronómetro de la base:", err);
        }
    }
}, 60000); // 60,000 milisegundos = 1 minuto exacto

// --- NUEVO: SISTEMA DE REGENERACIÓN DE VIDA (AUTO-HEAL) ---
setInterval(() => {
    const now = Date.now();
    for (let id in players) {
        let p = players[id];

        // Si el jugador existe, NO está muerto y le falta vida...
        if (p && !p.isDead && p.hp < 100) {

            // Si pasaron 60 segundos (60,000 ms) desde su último golpe...
            // (Nota: Cámbialo a 5000 para probarlo rápido)
            if (now - (p.lastHitTime || 0) >= 60000) {

                // Le sumamos 5 de vida, sin pasarnos del 100
                p.hp = Math.min(100, p.hp + 5);

                const hpMsg = encode({
                    type: 'hp_update',
                    targetId: id,
                    newHp: p.hp,
                    isDead: false,
                    damageDealt: -5
                });

                // Enviar a todos los clientes para que vean que este jugador se curó
                wss.clients.forEach(client => {
                    if (client.readyState === 1) client.send(hpMsg);
                });
            }
        }
    }
}, 1000); // Revisa a todos los jugadores 1 vez por segundo

// ==========================================
// 💾 ASYNC MEMORY FLUSHER (PRIORITY 3)
// ==========================================
// This worker wakes up every 60 seconds and saves EVERYONE in one massive, parallel swoop.
setInterval(async () => {
    const bulkOps = [];

    for (let id in players) {
        const p = players[id];
        // Only save registered users with a database ID
        if (p.accountId) {
            bulkOps.push({
                updateOne: {
                    filter: { _id: p.accountId },
                    update: {
                        $set: {
                            worldX: p.worldX,
                            worldY: p.worldY,
                            equippedWeapon: p.equippedWeapon,
                            hotbar: p.hotbar,
                            quickSwaps: p.quickSwaps,
                            coins: p.coins,
                            gems: p.gems,
                            hp: p.hp,
                            isDead: p.isDead,
                            kills: p.kills,
                            losses: p.losses,
                            elo: p.elo,
                            inventory: p.inventory,
                            equipped: p.equipped
                        }
                    }
                }
            });
        }
    }

    if (bulkOps.length > 0) {
        try {
            // ordered: false is the magic command. It tells Mongo to write everything at the same time.
            await User.bulkWrite(bulkOps, { ordered: false });
            console.log(`💾 [AUTO-SAVE] Flushed ${bulkOps.length} players to MongoDB.`);
        } catch (err) {
            console.error("🔥 Background Save Error:", err);
        }
    }
}, 60000); // 60,000 ms = 1 minute

// --- ⚽ SOCCER PHYSICS LOOP (30 FPS) ---
setInterval(() => {
    let anyUpdates = false;

    for (const arenaId in arenasRAM) {
        const arena = arenasRAM[arenaId];
        if (arena.gameType === 'soccer' && arena.ball) {
            const ball = arena.ball;

            // Apply friction
            ball.vx *= 0.95;
            ball.vy *= 0.95;

            // Stop ball if very slow
            if (Math.abs(ball.vx) < 0.1) ball.vx = 0;
            if (Math.abs(ball.vy) < 0.1) ball.vy = 0;

            // Player Collision (bounce off stationary or moving players)
            const allPlayers = [...(arena.team1 || []), ...(arena.team2 || [])];
            allPlayers.forEach(pid => {
                let p = players[pid];
                if (p) {
                    const dx = ball.x - p.worldX;
                    const dy = ball.y - p.worldY;
                    const dist = Math.hypot(dx, dy);
                    if (dist > 0 && dist < 24) { // 24px radius collision
                        const overlap = 24 - dist;
                        const nx = dx / dist;
                        const ny = dy / dist;

                        // Instead of pushing coordinates (which breaks wall collision), 
                        // we aggressively apply velocity so it bounces off the player naturally.
                        ball.vx += nx * 5;
                        ball.vy += ny * 5;
                    }
                }
            });

            if (ball.vx !== 0 || ball.vy !== 0) {
                // Separated Axis Collision Check for robust wall bouncing
                let nextX = ball.x + ball.vx;
                let gridX = Math.floor(nextX / 16);
                let gridY = Math.floor(ball.y / 16);
                let hitX = false;
                for (let l = 0; l <= 15; l++) {
                    if (serverWorldMap[`${gridX},${gridY},${l}`] && serverWorldMap[`${gridX},${gridY},${l}`].hasCollision) {
                        hitX = true; break;
                    }
                }

                if (hitX) {
                    ball.vx *= -0.8;
                } else {
                    ball.x = nextX;
                }

                let nextY = ball.y + ball.vy;
                gridX = Math.floor(ball.x / 16);
                gridY = Math.floor(nextY / 16);
                let hitY = false;
                for (let l = 0; l <= 15; l++) {
                    if (serverWorldMap[`${gridX},${gridY},${l}`] && serverWorldMap[`${gridX},${gridY},${l}`].hasCollision) {
                        hitY = true; break;
                    }
                }

                if (hitY) {
                    ball.vy *= -0.8;
                } else {
                    ball.y = nextY;
                }

                // Goal Detection (Top-Down Horizontal Lines)
                let minX1 = Math.min(ball.goal1X1, ball.goal1X2);
                let maxX1 = Math.max(ball.goal1X1, ball.goal1X2);
                // Blue Goal (Goal 1)
                if (Math.abs(ball.y - ball.goal1Y) < 16 && ball.x >= minX1 && ball.x <= maxX1) {
                    ball.score2++; // Red scores in Blue Goal
                    if (ball.score2 >= 3) {
                        endArenaMatch(arena, 2);
                    } else {
                        resetRound(arena);
                    }
                }

                let minX2 = Math.min(ball.goal2X1, ball.goal2X2);
                let maxX2 = Math.max(ball.goal2X1, ball.goal2X2);
                // Red Goal (Goal 2)
                if (Math.abs(ball.y - ball.goal2Y) < 16 && ball.x >= minX2 && ball.x <= maxX2) {
                    ball.score1++; // Blue scores in Red Goal
                    if (ball.score1 >= 3) {
                        endArenaMatch(arena, 1);
                    } else {
                        resetRound(arena);
                    }
                }

                anyUpdates = true;
            }

            // Mover el broadcast fuera del check de movimiento para que envíe la posición inicial aunque no se mueva
            const updatePayload = encode({
                type: 'soccer_update',
                arenaId: arena.arenaId,
                bx: Math.floor(ball.x),
                by: Math.floor(ball.y),
                s1: ball.score1,
                s2: ball.score2
            });

            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && client.playerId) {
                    const p = players[client.playerId];
                    if (p) {
                        if (p.currentArena === arena.arenaId) {
                            client.send(updatePayload);
                        } else {
                            // Proximity check for spectators (within 320 pixels instead of 800)
                            const dist = Math.hypot(p.worldX - ball.spawnX, p.worldY - ball.spawnY);
                            if (dist < 320) {
                                client.send(updatePayload);
                            }
                        }
                    }
                }
            });
        }
    }
}, 1000 / 30); // 30 FPS

function resetRound(arena) {
    if (arena.ball) {
        arena.ball.x = arena.ball.spawnX;
        arena.ball.y = arena.ball.spawnY;
        arena.ball.vx = 0;
        arena.ball.vy = 0;
    }

    // Teletransportar jugadores a sus spawns originales
    arena.team1.forEach((pid, index) => {
        let p = players[pid];
        if (p) {
            const t1Needed = parseInt(arena.team1Size) || 1;
            const spawnOffset = (index * 32) - (((t1Needed - 1) * 32) / 2);
            p.worldX = (arena.p1X * 16) + 8 + spawnOffset;
            p.worldY = (arena.p1Y * 16) + 8;
            p.vx = 0;
            p.vy = 0;
            wss.clients.forEach(c => {
                if (c.playerId === pid && c.readyState === WebSocket.OPEN) {
                    c.send(encode({ type: 'force_position', x: p.worldX, y: p.worldY, reason: 'round_reset' }));
                }
            });
        }
    });

    arena.team2.forEach((pid, index) => {
        let p = players[pid];
        if (p) {
            const t2Needed = parseInt(arena.team2Size) || 1;
            const spawnOffset = (index * 32) - (((t2Needed - 1) * 32) / 2);
            p.worldX = (arena.p2X * 16) + 8 + spawnOffset;
            p.worldY = (arena.p2Y * 16) + 8;
            p.vx = 0;
            p.vy = 0;
            wss.clients.forEach(c => {
                if (c.playerId === pid && c.readyState === WebSocket.OPEN) {
                    c.send(encode({ type: 'force_position', x: p.worldX, y: p.worldY, reason: 'round_reset' }));
                }
            });
        }
    });
}

function endArenaMatch(arena, winningTeam) {
    let maxWinnerHp = 0;
    if (arena.isRanked) {
        const winningPlayers = winningTeam === 1 ? arena.team1 : arena.team2;
        winningPlayers.forEach(pid => {
            if (players[pid] && !players[pid].isDead && players[pid].hp > maxWinnerHp) {
                maxWinnerHp = players[pid].hp;
            }
        });
    }
    let eloChange = 5;
    if (maxWinnerHp >= 90) eloChange = 10;
    else if (maxWinnerHp >= 75) eloChange = 8.5;
    else if (maxWinnerHp >= 50) eloChange = 7;

    [...arena.team1, ...arena.team2].forEach(pid => {
        let p = players[pid];
        if (p) {
            const isWinner = (winningTeam === 1 && arena.team1.includes(pid)) || (winningTeam === 2 && arena.team2.includes(pid));
            if (arena.isRanked) {
                if (isWinner) p.elo += eloChange; else p.elo -= eloChange;
                if (p.elo < 0) p.elo = 0;
                User.findByIdAndUpdate(p.accountId, { elo: p.elo }).catch(console.error);
            }
            p.isSparring = false;
            p.arenaTeam = null;
            p.currentArena = null;
            p.hp = 100;
            p.isDead = false;
            p.lastHitTime = Date.now();
            p.invulnerableUntil = Date.now() + 2000;

            p.worldX = p.preSparX || 0;
            p.worldY = p.preSparY || 0;

            let resultMsg = isWinner ? "¡VICTORIA! 🏆" : "DERROTA 💀";
            if (arena.gameType === 'soccer') {
                resultMsg += ` (${arena.ball.score1} - ${arena.ball.score2})`;
            }
            if (arena.isRanked) resultMsg += isWinner ? ` (+${eloChange} Elo)` : ` (-${eloChange} Elo)`;

            wss.clients.forEach(c => {
                if (c.playerId === pid && c.readyState === WebSocket.OPEN) {
                    c.send(encode({ type: 'match_finished', returnX: p.worldX, returnY: p.worldY, result: resultMsg, newElo: p.elo }));
                }
            });
        }
    });

    arena.isOccupied = false;
    arena.team1 = []; arena.team2 = [];
    arena.fighter1 = null; arena.fighter2 = null;

    if (arena.ball) {
        arena.ball.score1 = 0;
        arena.ball.score2 = 0;
        resetRound(arena);
    }

    broadcast({ type: 'refresh_arena_ui', arenaId: arena.arenaId });
}

server.listen(PORT, () => {
    console.log(`HTTP/WebSocket server running on port ${PORT}`);
});
