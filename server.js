const WebSocket = require('ws');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { encode, decode } = require('@msgpack/msgpack'); // <--- ADD THIS
require('dotenv').config(); // <--- ADD THIS LINE TO READ THE .ENV FILE

process.on('uncaughtException', (err) => {
    console.error('CRITICAL SERVER CRASH PREVENTED (Uncaught):', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL SERVER CRASH PREVENTED (Unhandled Rejection):', reason);
});
const express = require('express');
const http = require('http');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Global RAM for Squad Chats (Ultra-fast, ephemeral)
const { SQUAD_CHATS_RAM, arenasRAM, safeZonesRAM, RANKS_CACHE, ZONE_CONFIG, skeletonRAM, PATCH_NOTES_CACHE, GLOBAL_BGM_PLAYLIST, ARGEM_PACKAGES, GLOBAL_TASKS, MASTER_CATALOG, WEAPONS, TRASH_CATALOG, METALS_CATALOG, TILESETS, serverWorldMap, players, activeProjectiles, groundItems } = require('./src/state');
const state = require('./src/state');
// --- DATABASE CONNECTION ---
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI, { family: 4 })
    .then(async () => {
        console.log('ðŸ”¥ Connected to MongoDB!');

        // ðŸ›‘ EL FIX: Cargar la Playlist de MongoDB a la RAM
        let config = await ServerConfig.findOne();
        if (!config) {
            // Si es la primera vez que prendes el server, crea el documento base
            config = new ServerConfig({ bgmPlaylist: ["audio/music/track1.mp3"] }); // Pon la ruta real que tengas en Github luego
            await config.save();
        }
        GLOBAL_BGM_PLAYLIST.length = 0; GLOBAL_BGM_PLAYLIST.push(...config.bgmPlaylist);

        loadTilesetsFromDB();
        loadWorldMapFromDB();
        loadZoneConfigsFromDB();
        loadSafeZonesFromDB();
        loadSkeletonFromDB();
        loadArenasFromDB();
        loadRanksFromDB();
        loadPatchNotesFromDB();
        // ðŸ›‘ EL FIX: Solo llamamos al CatÃ¡logo Maestro. 
        // Ya no cargamos Weapons ni Trash por separado.
        loadMasterCatalog();
        loadTasksFromDB();
        loadArgemPackagesFromDB();
    })
    .catch(err => console.error('MongoDB Connection Error:', err));

const Tile = require('./src/models/Tile');

const Blueprint = require('./src/models/Blueprint');

// --- ESQUEMA DE MINIJUEGOS Y ARENAS (ESCALABLE) ---
const Arena = require('./src/models/Arena');
// Memoria RAM ultra-rÃ¡pida para manejar las colas y juegos en vivo

const Turf = require('./src/models/Turf');

// --- ESQUEMA UNIVERSAL DE ZONAS (VECTORES) ---
const SafeZone = require('./src/models/SafeZone');


async function loadSafeZonesFromDB() {
    try {
        const rawZones = await SafeZone.find({}).lean();
        // âš¡ Convert the complex ObjectId into a pure String for MessagePack
        safeZonesRAM.length = 0; safeZonesRAM.push(...rawZones.map(z => ({ ...z, _id: z._id.toString() })));
        console.log(`ðŸ—ºï¸ Zonas Universales cargadas en RAM (${safeZonesRAM.length} zonas).`);
    } catch (err) { console.error("Error cargando Zonas:", err); }
}

// --- ESCÃNER MATEMÃTICO: Â¿ESTOY EN UNA ZONA SEGURA? ---
function isInSafeZone(px, py) {
    for (let i = 0; i < safeZonesRAM.length; i++) {
        let z = safeZonesRAM[i];
        // ðŸ›‘ EL FIX: Solo nos protege si la zona es especÃ­ficamente de tipo 'safe'
        if ((z.zoneType === 'safe' || !z.zoneType) && px >= z.xMin && px <= z.xMax && py >= z.yMin && py <= z.yMax) {
            return true;
        }
    }
    return false;
}

// ==========================================
// ðŸ† ESQUEMA DE RANGOS ELO (MONGODB)
// ==========================================
const Rank = require('./src/models/Rank');


async function loadRanksFromDB() {
    try {
        let ranks = await Rank.find({}, { _id: 0, __v: 0 }).sort({ minElo: -1 }).lean();

        if (ranks.length === 0) {
            console.log("ðŸ† Inicializando Rangos por defecto en MongoDB...");
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
        RANKS_CACHE.length = 0; RANKS_CACHE.push(...ranks);
        console.log(`ðŸ† Rangos cargados: ${RANKS_CACHE.length} divisiones activas.`);
    } catch (err) { console.error("Error cargando Rangos:", err); }
}

// ==========================================
// ðŸ—ºï¸ ESQUEMA DE CONFIGURACIÃ“N DE ZONAS (MONGODB)
// ==========================================
const ZoneConfig = require('./src/models/ZoneConfig');

// Memoria RAM para consultas ultrarrÃ¡pidas

// FunciÃ³n para cargar desde la Base de Datos al iniciar el servidor
async function loadZoneConfigsFromDB() {
    try {
        let configs = await ZoneConfig.find({}, { _id: 0, __v: 0 }).lean();

        // Si la tabla estÃ¡ vacÃ­a, inyectamos los bÃ¡sicos
        if (configs.length === 0) {
            console.log("ðŸ› ï¸ Inicializando Tipos de Zona por defecto en MongoDB...");
            const defaultZones = [
                { id: "safe", name: "Zona Segura", icon: "ðŸ›¡ï¸", colorBorder: "rgba(46, 204, 113, 0.8)", colorFill: "rgba(46, 204, 113, 0.2)" },
                { id: "trash", name: "Basurero", icon: "ðŸ—‘ï¸", colorBorder: "rgba(230, 126, 34, 0.8)", colorFill: "rgba(230, 126, 34, 0.2)" },
                { id: "npc", name: "Zona NPC", icon: "ðŸ¤–", colorBorder: "rgba(155, 89, 182, 0.8)", colorFill: "rgba(155, 89, 182, 0.2)" },
                { id: "dig", name: "Zona de ExcavaciÃ³n", icon: "â›ï¸", colorBorder: "rgba(139, 69, 19, 0.8)", colorFill: "rgba(139, 69, 19, 0.2)" }
            ];
            await ZoneConfig.insertMany(defaultZones);
            configs = await ZoneConfig.find({}, { _id: 0, __v: 0 }).lean();
        }

        // ðŸ›‘ EL FIX: Si tu base de datos ya existÃ­a pero no tenÃ­a la zona "indoor", la inyectamos a la fuerza
        if (!configs.find(c => c.id === 'indoor')) {
            console.log("ðŸ  AÃ±adiendo nueva zona de Techos a la base de datos...");
            await ZoneConfig.create({ id: "indoor", name: "Interior (Sin Lluvia)", icon: "ðŸ ", colorBorder: "rgba(52, 152, 219, 0.8)", colorFill: "rgba(52, 152, 219, 0.2)" });
            configs = await ZoneConfig.find({}, { _id: 0, __v: 0 }).lean();
        }

        // ðŸ´ Inyectar zona Turf si no existe
        if (!configs.find(c => c.id === 'turf')) {
            console.log("ðŸ´ AÃ±adiendo zona Turf (Respawn personalizado) a la base de datos...");
            await ZoneConfig.create({ id: "turf", name: "Turf (Respawn)", icon: "ðŸ´", colorBorder: "rgba(231, 76, 60, 0.9)", colorFill: "rgba(231, 76, 60, 0.15)" });
            configs = await ZoneConfig.find({}, { _id: 0, __v: 0 }).lean();
        }

        // Limpiar la RAM y llenarla con los datos de Mongo
        for (let k in ZONE_CONFIG) delete ZONE_CONFIG[k];
        configs.forEach(c => {
            ZONE_CONFIG[c.id] = { name: c.name, icon: c.icon, colorBorder: c.colorBorder, colorFill: c.colorFill };
        });

        console.log(`ðŸŽ¨ Tipos de Zona cargados en RAM (${Object.keys(ZONE_CONFIG).length} tipos).`);
    } catch (err) {
        console.error("âŒ Error cargando ConfiguraciÃ³n de Zonas:", err);
    }
}

// --- HERRAMIENTA: ESCÃNER DE ZONAS SEGURAS ---
const SERVER_TILE_SIZE = 16;

// --- MODELO DEL ESQUELETO (GANI) ---
const Skeleton = require('./src/models/Skeleton');

// Variable global en RAM


// --- CARGAR ANIMACIONES GANI AL INICIAR (CORREGIDO) ---
async function loadSkeletonFromDB() {
    try {
        // Buscamos el registro sin filtros innecesarios
        const skel = await Skeleton.findOne({}, { _id: 0, __v: 0 }).lean();
        if (skel && skel.anchors) {
            for (let k in skeletonRAM) delete skeletonRAM[k]; Object.assign(skeletonRAM, skel.anchors);
            console.log("âœ… Animaciones Gani cargadas correctamente desde MongoDB!");
        } else {
            console.log("ðŸ¦´ No hay animaciones previas, iniciando Gani en blanco.");
            for (let k in skeletonRAM) delete skeletonRAM[k];
        }
    } catch (err) {
        console.error("âŒ Error al cargar las animaciones Gani:", err);
    }
}

// --- ESQUEMA DE ACTUALIZACIONES (PATCH NOTES) ---
const PatchNote = require('./src/models/PatchNote');

// Memoria RAM para enviarlo rÃ¡pido a los jugadores al conectar

async function loadPatchNotesFromDB() {
    try {
        // Traemos las Ãºltimas 10 actualizaciones ordenadas de la mÃ¡s nueva a la mÃ¡s vieja
        const __pn = await PatchNote.find({}, { _id: 0, __v: 0 }).sort({ date: -1 }).limit(10).lean(); PATCH_NOTES_CACHE.length = 0; PATCH_NOTES_CACHE.push(...__pn);
        // Si estÃ¡ vacÃ­a, creamos una de bienvenida automÃ¡ticamente
        if (PATCH_NOTES_CACHE.length === 0) {
            const welcomeNote = new PatchNote({
                title: "Â¡Bienvenidos a MMOARGON!",
                description: "El servidor alfa estÃ¡ oficialmente en lÃ­nea. Explora el mapa, Ãºnete a un clan y domina la ciudad.",
                version: "1.0.0"
            });
            await welcomeNote.save();
            PATCH_NOTES_CACHE.length = 0; PATCH_NOTES_CACHE.push(welcomeNote);
        }
        console.log(`ðŸ“° Noticias cargadas: ${PATCH_NOTES_CACHE.length} parches encontrados.`);
    } catch (err) {
        console.error("Error cargando Patch Notes:", err);
    }
}

// --- THE TASK (ACHIEVEMENTS) BLUEPRINT ---
const Task = require('./src/models/Task');

// --- NUEVO: BATTLE PASS SEASON (LIVEOPS) ---
const Season = require('./src/models/Season');

// --- THE PLAYER BLUEPRINT (SCHEMA) ---
const User = require('./src/models/User');

// --- NUEVO: CONTADOR GLOBAL PARA IDs ÃšNICOS (EJ: A1000) ---
const Counter = require('./src/models/Counter');

// --- NUEVO: SISTEMA DE FEEDBACK ---
const Feedback = require('./src/models/Feedback');



// --- ESQUEMA DE LOS SQUADS (CLANES) ---

// Sub-esquema para definir quÃ© puede hacer cada miembro
const Squad = require('./src/models/Squad');

// ==========================================
// CONFIGURACIÃ“N GLOBAL DEL SERVIDOR (MUSIC, ETC)
// ==========================================
const ServerConfig = require('./src/models/ServerConfig');


// ==========================================
// ðŸ“¦ TABLA MAESTRA DE ÃTEMS (MASTER CATALOG)
// ==========================================
const Item = require('./src/models/Item');

// --- ðŸŒŸ NUEVO: TAREAS Y LOGROS GLOBALES ðŸŒŸ ---
// --- NUEVO: ARGEMS PREMIUM PACKAGES ---
const ArgemPackage = require('./src/models/ArgemPackage');


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
            ARGEM_PACKAGES.length = 0; ARGEM_PACKAGES.push(...defaultPackages);
            console.log('ðŸ’Ž Argem Packages seeded into MongoDB.');
        } else {
            ARGEM_PACKAGES.length = 0; ARGEM_PACKAGES.push(...packages);
        }
    } catch (e) {
        console.error("Error loading Argem packages:", e);
    }
}

// --- NUEVO: BATTLE PASS XP SYSTEM ---
async function add_bp_xp(email, amount, ws, p) {
    if (!state.ACTIVE_SEASON) return;
    try {
        const user = await User.findOne({ email: email });
        if (!user) return;

        // Si no estï¿½ en la temporada correcta, reset
        if (user.bpSeasonId !== state.ACTIVE_SEASON.seasonId) {
            user.bpSeasonId = state.ACTIVE_SEASON.seasonId;
            user.bpXP = 0;
            user.bpPremium = false;
            user.bpClaimedFree = [];
            user.bpClaimedPremium = [];
        }

        user.bpXP += amount;
        await user.save();

        if (p) {
            p.bpSeasonId = user.bpSeasonId;
            p.bpXP = user.bpXP;
        }

        if (ws) {
            ws.send(encode({
                type: 'bp_xp_added',
                amount: amount,
                totalXP: user.bpXP
            }));
        }
    } catch (e) {
        console.error("Error adding BP XP", e);
    }
}
async function loadTasksFromDB() {
    try {
        const tasks = await Task.find({}).lean();
        if (tasks.length === 0) {
            // Inyectar tareas por defecto si la base de datos estÃ¡ vacÃ­a
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
            for (let k in GLOBAL_TASKS) delete GLOBAL_TASKS[k];
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




async function loadMasterCatalog() {
    try {
        console.log("ðŸ“¦ Cargando CatÃ¡logo Maestro...");

        // 1. Solo deja activos los que sean "Esenciales" o nuevos.
        // Si ya ajustaste la Katana en Compass, puedes comentar su 'findOneAndUpdate' 
        // para que el servidor solo la LEA de la DB y no intente re-escribirla.

        /* await Item.findOneAndUpdate({ id: "katana_azulado" }, { ... }, { upsert: true }); 
        */

        // âš¡ ADD { _id: 0, __v: 0 } PROJECTION:
        const items = await Item.find({}, { _id: 0, __v: 0 }).lean();

        for (let k in MASTER_CATALOG) delete MASTER_CATALOG[k];
        for (let k in WEAPONS) delete WEAPONS[k];
        TRASH_CATALOG.length = 0;
        METALS_CATALOG.length = 0;

        items.forEach(i => {
            MASTER_CATALOG[i.id] = i;
            // âš¡ REMOVE the .toObject() calls because .lean() already made them raw objects!
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

        console.log(`âœ… CatÃ¡logo cargado: ${Object.keys(MASTER_CATALOG).length} Ã­tems listos.`);
    } catch (err) {
        console.error("ðŸ’¥ Error cargando el CatÃ¡logo:", err);
    }
}

// --- EL ESQUEMA DE LOS TILESETS ---
const Tileset = require('./src/models/Tileset');


async function loadTilesetsFromDB() {
    try {
        const dbTilesets = await Tileset.find({}, { _id: 0, __v: 0 }).sort({ startId: 1 }).lean();

        if (dbTilesets.length === 0) {
            console.log('ðŸ“¦ Migrando TILESET_CONFIG a MongoDB por primera vez...');

            // --- 0. MULTI-TILESET SYSTEM (GLOBAL IDs) ---
            const defaultTilesets = [];

            await Tileset.insertMany(defaultTilesets);
            const __ts = await Tileset.find({}, { _id: 0, __v: 0 }).sort({ startId: 1 }).lean(); TILESETS.length = 0; TILESETS.push(...__ts);
            console.log('âœ… Â¡60 Tilesets migrados a MongoDB exitosamente!');
        } else {
            TILESETS.length = 0; TILESETS.push(...dbTilesets);
            console.log(`âœ… Base de datos de Tilesets cargada en RAM (${TILESETS.length} tilesets)`);
        }
    } catch (err) { console.error("Error cargando tilesets:", err); }
}

// --- LA NUEVA MEMORIA FÃSICA DEL SERVIDOR ---

// ðŸ’¥ NUEVO: EL CEREBRO DE LA BASE CENTRAL ðŸ’¥


async function loadWorldMapFromDB() {
    try {
        // 2. FETCH WORLD DATA
        const allTiles = await Tile.find({}, { _id: 0, __v: 0 }).lean();
        state.WORLD_TILES_CACHE = allTiles;

        // Reiniciamos las bases por si acaso recargamos el mapa
        state.turfBases = {};
        state.centralBase = null;

        const baseTiles = [];
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
                itemRow: t.itemRow || 0,
                shelfX: t.shelfX || 0,
                shelfY: t.shelfY || 0
            };

                        if (t.triggerType === 'base') {
                baseTiles.push(t);
            }
            if (t.triggerType === 'jail_spawn') {
                state.jailSpawnPos = { x: (t.x * 16) + 8, y: (t.y * 16) + 8, l: l };
            }
        });

        // --- RECUPERAR TODAS LAS BASES DESDE MONGODB ---
        for (const t of baseTiles) {
            const uniqueTurfId = `base_${t.x}_${t.y}`;
            let dbTurf = await Turf.findOne({ turfId: uniqueTurfId });

            if (!dbTurf) {
                dbTurf = await Turf.create({
                    turfId: uniqueTurfId,
                    name: "Base Central",
                    hp: 5000,
                    maxHp: 5000,
                    hitboxW: 32,
                    hitboxH: 32
                });
            }

            state.turfBases[uniqueTurfId] = {
                turfId: uniqueTurfId,
                gridX: t.x, gridY: t.y,
                worldX: (t.x * 16) + 8, worldY: (t.y * 16) + 8,
                name: dbTurf.name || "Base Central",
                hp: dbTurf.hp || dbTurf.maxHp || 5000,
                maxHp: dbTurf.maxHp || 5000,
                currentOwnerSquadId: dbTurf.ownerSquadName || null,
                srcIdle: dbTurf.srcIdle || "",
                srcHit: dbTurf.srcHit || "",
                spriteOffsetX: dbTurf.spriteOffsetX || 0,
                spriteOffsetY: dbTurf.spriteOffsetY || 0,
                hitboxOffsetX: dbTurf.hitboxOffsetX || 0,
                hitboxOffsetY: dbTurf.hitboxOffsetY || 0,
                hitboxW: dbTurf.hitboxW || 32,
                hitboxH: dbTurf.hitboxH || 32,
                frameWidth: dbTurf.frameWidth || 0,
                frameHeight: dbTurf.frameHeight || 0,
                frameCount: dbTurf.frameCount || 0,
                animSpeed: dbTurf.animSpeed || 0,
                renderScale: dbTurf.renderScale || 1.0,
                isHover: dbTurf.isHover !== undefined ? dbTurf.isHover : true,
                lastHitTime: 0,
                damageTracker: {}
            };
            console.log(`ðŸ° Base [${dbTurf.name}] (${uniqueTurfId}) cargada en RAM. DueÃ±o: ${dbTurf.ownerSquadName || 'Nadie'}`);
        }
        // TambiÃ©n cargar cualquier base Turf adicional en la colecciÃ³n Turf
        const allDbTurfs = await Turf.find({}).lean();
        for (const dbTurf of allDbTurfs) {
            if (dbTurf.turfId && !state.turfBases[dbTurf.turfId]) {
                const parts = dbTurf.turfId.split('_');
                const gx = parseInt(parts[1]) || 0;
                const gy = parseInt(parts[2]) || 0;
                state.turfBases[dbTurf.turfId] = {
                    turfId: dbTurf.turfId,
                    gridX: gx, gridY: gy,
                    worldX: (gx * 16) + 8, worldY: (gy * 16) + 8,
                    hp: dbTurf.hp || dbTurf.maxHp || 5000,
                    maxHp: dbTurf.maxHp || 5000,
                    currentOwnerSquadId: dbTurf.ownerSquadName || null,
                    name: dbTurf.name,
                    srcIdle: dbTurf.srcIdle || "",
                    srcHit: dbTurf.srcHit || "",
                    spriteOffsetX: dbTurf.spriteOffsetX || 0,
                    spriteOffsetY: dbTurf.spriteOffsetY || 0,
                    hitboxOffsetX: dbTurf.hitboxOffsetX || 0,
                    hitboxOffsetY: dbTurf.hitboxOffsetY || 0,
                    hitboxW: dbTurf.hitboxW || 32,
                    hitboxH: dbTurf.hitboxH || 32,
                    frameWidth: dbTurf.frameWidth || 0,
                    frameHeight: dbTurf.frameHeight || 0,
                    frameCount: dbTurf.frameCount || 0,
                    animSpeed: dbTurf.animSpeed || 0,
                    renderScale: dbTurf.renderScale || 1.0,
                    isHover: dbTurf.isHover !== undefined ? dbTurf.isHover : true,
                    lastHitTime: 0,
                    damageTracker: {}
                };
                console.log(`ðŸ° Base [${dbTurf.name}] (${dbTurf.turfId}) cargada desde colecciÃ³n Turf.`);
            }
        }
        state.centralBase = Object.values(state.turfBases)[0] || null;
        console.log(`ðŸŒ Mapa FÃ­sico cargado en RAM del servidor (${allTiles.length} bloques, ${Object.keys(state.turfBases).length} bases Turf activas).`);
    } catch (err) {
        console.error("Error cargando el mapa:", err);
    }
}

// --- CARGAR ARENAS EN LA RAM AL INICIAR EL SERVIDOR ---
async function loadArenasFromDB() {
    try {
        const allArenas = await Arena.find({});
        for (let k in arenasRAM) delete arenasRAM[k]; // Limpiamos por si acaso

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
                queue: [], // Inician vacÃ­as al reiniciar el server
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
        console.log(`ðŸ¥Š Arenas cargadas en RAM: ${allArenas.length} arenas activas.`);
    } catch (err) {
        console.error("Error cargando Arenas:", err);
    }
}

// FunciÃ³n que usaremos para detectar hackers traspasando paredes
const TILE_SIZE = 16;
// ðŸ‘† HASTA AQUÃ ðŸ‘†

// --- ESQUEMA DE MENSAJES PRIVADOS (AHORA POR ID) ---
const PM = require('./src/models/PM');

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
        console.error("âš ï¸ Stripe Webhook Error:", err.message);
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

            console.log(`ðŸ’° Stripe Webhook: Granted ${gemsToAdd} gems to ${email}`);

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

// ==========================================
// ðŸ—ºï¸ SPATIAL PARTITIONING ENGINE (ANTI-LAG)
// ==========================================
// A chunk of 512x512 pixels (32x32 tiles) is perfect for a 2D MMO.

// ==========================================================
// ðŸ’¥ GAME ENGINE INITIALIZATION
// ==========================================================
const initGameEngine = require('./src/game/engine');
const gameEngine = initGameEngine({
    wss, state, encode, decode, Tile, Blueprint, Arena, Turf, SafeZone, Rank, ZoneConfig, Skeleton, PatchNote, Task, Season, User, Counter, Feedback, Squad, ServerConfig, Item, ArgemPackage, Tileset, PM,
    add_bp_xp, isInSafeZone, broadcast, broadcastToZone
});
const { 
    serverCheckCollision, getChunkId, getVisibleChunks, 
    applyDamageToPlayer, resetRound, endArenaMatch
} = gameEngine;

// ==========================================================

// The New Targeted Broadcast (AoI)
function broadcastToZone(data, targetChunkId, excludeWs = null) {
    if (!targetChunkId) return;
    if (data && data.player && data.player.invisibleEnabled) return; // Completely hide from zone broadcasts

    // âš¡ ENCODE ONCE, SEND TO MANY
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
const createWsHandler = require('./src/network/wsHandler');
const wsHandler = createWsHandler({
    wss, state, encode, decode, bcrypt, Tile, Blueprint, Arena, Turf, SafeZone, Rank, ZoneConfig, Skeleton, PatchNote, Task, Season, User, Counter, Feedback, Squad, ServerConfig, Item, ArgemPackage, Tileset, PM,
    broadcast, broadcastToZone, applyDamageToPlayer, serverCheckCollision, getChunkId, getVisibleChunks, isInSafeZone,
    add_bp_xp, stripe});
wss.on('connection', wsHandler);

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
// ðŸ¥Š MATCHMAKER GLOBAL (Soporta 1v1, 2v2, 3v1, 4v4, etc.)


// --- API ENDPOINT FOR LANDING PAGE ---
app.get('/api/stats', async (req, res) => {
    try {
        // Allow CORS so landing page can fetch easily if hosted on different port/domain
        res.header('Access-Control-Allow-Origin', '*');

        const totalRegistered = await User.countDocuments();

        let onlineCount = 0;
        wss.clients.forEach(client => {
            if (client.readyState === 1 && client.playerId) onlineCount++;
        });

        res.json({ registered: totalRegistered, online: onlineCount });
    } catch (err) {
        console.error("Stats API error:", err);
        res.status(500).json({ error: 'Server error' });
    }
});

server.listen(PORT, () => {
    console.log(`HTTP/WebSocket server running on port ${PORT}`);
});

async function loadActiveSeason() {
    try {
        const now = new Date();
        // Buscar la primera temporada activa que estï¿½ dentro del rango de fechas
        const active = await Season.findOne({
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now }
        }, { _id: 0, __v: 0, "rewards._id": 0 }).lean();

        if (active) {
            state.ACTIVE_SEASON = active;
            console.log(`BATTLE PASS: Temporada activa cargada -> ${active.name}`);
        } else {
            console.log('BATTLE PASS: No hay temporada activa actualmente.');
            state.ACTIVE_SEASON = null;

            // --- AUTO-CREACIï¿½N DE TEMPORADA 1 (SOLO PARA PRUEBAS) ---
            const count = await Season.countDocuments();
            if (count === 0) {
                console.log('BATTLE PASS: Creando Temporada 1 de prueba en MongoDB...');

                // Funciï¿½n auxiliar para calcular XP exponencial
                const calcXpForLevel = (level) => {
                    // Nivel 1 a 2 = 1000. Nivel 49 a 50 = ~15000.
                    return Math.floor(1000 * Math.pow(1.057, level - 1));
                };

                const defaultRewards = [];
                for (let i = 1; i <= 50; i++) {
                    const isMilestone = (i % 5 === 0);
                    defaultRewards.push({
                        level: i,
                        xpRequired: calcXpForLevel(i),
                        free: isMilestone ? { type: 'coins', amount: 500 } : null,
                        premium: isMilestone ? { type: 'item', id: 'hat_cap' } : { type: 'argems', amount: 20 }
                    });
                }

                const s1 = new Season({
                    seasonId: 'season_1',
                    name: 'Season 1: Neon Origins',
                    isActive: true,
                    startDate: new Date(now.getTime() - 86400000), // Empezï¿½ ayer
                    endDate: new Date(now.getTime() + (86400000 * 30)), // Termina en 30 dï¿½as
                    costArgems: 500,
                    rewards: defaultRewards
                });
                await s1.save();
                state.ACTIVE_SEASON = s1;
                console.log('BATTLE PASS: Temporada 1 creada y activada.');
            }
        }
    } catch (e) {
        console.error("Error cargando Temporada del Battle Pass:", e);
    }
}










loadActiveSeason();


