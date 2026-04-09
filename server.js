const WebSocket = require('ws');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config(); // <--- ADD THIS LINE TO READ THE .ENV FILE

// --- DATABASE CONNECTION ---
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('🔥 Connected to MongoDB!');

        loadTilesetsFromDB();
        loadWorldMapFromDB();
        loadSafeZonesFromDB();
        loadSkeletonFromDB();

        // 🛑 EL FIX: Solo llamamos al Catálogo Maestro. 
        // Ya no cargamos Weapons ni Trash por separado.
        loadMasterCatalog();
    })
    .catch(err => console.error('MongoDB Connection Error:', err));

const tileSchema = new mongoose.Schema({
    x: Number,
    y: Number,
    l: { type: Number, default: 0 },
    tileId: Number,
    hasCollision: { type: Boolean, default: false },
    // Logical Data: Omit defaults so these are only stored if they have values
    triggerType: String,
    destX: Number,
    destY: Number,
    itemId: String,
    rotation: { type: Number, default: 0 }
});

const Tile = mongoose.model('Tile', tileSchema);

// --- NUEVO: ESQUEMA DE BASES CAPTURABLES (TURFS) ---
const turfSchema = new mongoose.Schema({
    turfId: { type: String, required: true, unique: true }, // Ej: "base_120_45" (basado en sus coordenadas)
    name: { type: String, default: "Base Central" }, // ¡Para que le pongas el nombre que quieras!
    hp: { type: Number, default: 5000 },
    maxHp: { type: Number, default: 5000 },
    ownerSquadName: { type: String, default: null } // El clan que la controla
});
const Turf = mongoose.model('Turf', turfSchema);

// --- NUEVO: ESQUEMA DE ZONAS SEGURAS (VECTORES) ---
const safeZoneSchema = new mongoose.Schema({
    name: { type: String, required: true },
    xMin: { type: Number, required: true },
    xMax: { type: Number, required: true },
    yMin: { type: Number, required: true },
    yMax: { type: Number, required: true }
});
const SafeZone = mongoose.model('SafeZone', safeZoneSchema);

let safeZonesRAM = []; // Caché ultrarrápida

async function loadSafeZonesFromDB() {
    try {
        safeZonesRAM = await SafeZone.find({});
        console.log(`🛡️ Zonas Seguras cargadas en RAM (${safeZonesRAM.length} zonas).`);
    } catch (err) { console.error("Error cargando Zonas Seguras:", err); }
}

// --- HERRAMIENTA: ESCÁNER DE ZONAS SEGURAS ---
const SERVER_TILE_SIZE = 16;

// --- HERRAMIENTA: ESCÁNER MATEMÁTICO DE ZONAS SEGURAS ---
function isInSafeZone(px, py) {
    for (let i = 0; i < safeZonesRAM.length; i++) {
        let z = safeZonesRAM[i];
        if (px >= z.xMin && px <= z.xMax && py >= z.yMin && py <= z.yMax) {
            return true;
        }
    }
    return false;
}

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
        const skel = await Skeleton.findOne({});
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
    equipped: { // 👕 EL WARDROBE
        hands: { type: String, default: 'none' },
        head: { type: String, default: 'head_default' },
        body: { type: String, default: 'body_default' },
        hat: { type: String, default: 'none' } // 🎩 NUEVO: Espacio para sombreros
    },
    friends: { type: Array, default: [] },

    // --- NUEVO: SISTEMA DE ECONOMÍA ---
    coins: { type: Number, default: 0 },
    // 👇 NUEVO: ESTADÍSTICAS DE COMBATE 👇
    kills: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    // 👇 NUEVO: GUARDADO DE SALUD (ANTI-COMBAT LOGGING) 👇
    hp: { type: Number, default: 100 },
    isDead: { type: Boolean, default: false },
    // --- NUEVO: SISTEMA DE ROLES ---
    role: { type: String, default: 'player' }, // Todos nacen como 'player' por defecto, pero podrías tener 'admin', 'moderator', etc. y manejar permisos en el futuro.
    // ... tus otros campos (coins, friends, etc)
    squad: { type: mongoose.Schema.Types.ObjectId, ref: 'Squad', default: null } // <--- NUEVO
});

const User = mongoose.model('User', userSchema);

// --- ESQUEMA DE LOS SQUADS (CLANES) ---

// Sub-esquema para definir qué puede hacer cada miembro
const squadMemberSchema = new mongoose.Schema({
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    customTitle: { type: String, default: 'Miembro' }, // Aquí va "Comandante", "Reclutador", etc.

    // Los permisos granulares que pediste
    canInvite: { type: Boolean, default: false },      // Puede contratar personal
    canKick: { type: Boolean, default: false },        // Puede sacar personal
    canAssignRoles: { type: Boolean, default: false }  // Puede dar atributos a otros (Full Admin)
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
    territoryTimeMinutes: { type: Number, default: 0 }
});

const Squad = mongoose.model('Squad', squadSchema);

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
    drawConfig: { type: Object, default: {} }
});

const Item = mongoose.model('Item', itemSchema);

let MASTER_CATALOG = {};
let WEAPONS = {};
let TRASH_CATALOG = [];

async function loadMasterCatalog() {
    try {
        console.log("📦 Cargando Catálogo Maestro...");

        // 1. Solo deja activos los que sean "Esenciales" o nuevos.
        // Si ya ajustaste la Katana en Compass, puedes comentar su 'findOneAndUpdate' 
        // para que el servidor solo la LEA de la DB y no intente re-escribirla.

        /* await Item.findOneAndUpdate({ id: "katana_azulado" }, { ... }, { upsert: true }); 
        */

        // 2. Cargar TODO a la memoria RAM (Esto es lo que reemplaza a las funciones viejas)
        const items = await Item.find({});

        MASTER_CATALOG = {};
        WEAPONS = {};
        TRASH_CATALOG = [];

        items.forEach(i => {
            MASTER_CATALOG[i.id] = i;

            if (i.category === 'weapon') {
                // Esto es lo que mantiene vivo tu hotbar y sistema de disparo
                WEAPONS[i.id] = { ...i.toObject(), ...i.stats };
            } else if (i.category === 'junk') {
                TRASH_CATALOG.push({ ...i.toObject(), ...i.drawConfig, value: i.price });
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
        const dbTilesets = await Tileset.find({}).sort({ startId: 1 });

        if (dbTilesets.length === 0) {
            console.log('📦 Migrando TILESET_CONFIG a MongoDB por primera vez...');

            // --- 0. MULTI-TILESET SYSTEM (GLOBAL IDs) ---
            const defaultTilesets = [];

            await Tileset.insertMany(defaultTilesets);
            TILESETS = await Tileset.find({}).sort({ startId: 1 });
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
        const allTiles = await Tile.find({});

        // Reiniciamos la base por si acaso recargamos el mapa
        centralBase = null;

        allTiles.forEach(t => {
            const l = t.l || 0;
            serverWorldMap[`${t.x},${t.y},${l}`] = {
                hasCollision: t.hasCollision || false,
                triggerType: t.triggerType,
                destX: t.destX,
                destY: t.destY,
                itemId: t.itemId
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
        if (centralBase) {
            let dbTurf = await Turf.findOne({ turfId: centralBase.turfId });

            // Si es la primera vez que ponemos la base, la creamos en MongoDB
            if (!dbTurf) {
                dbTurf = await Turf.create({
                    turfId: centralBase.turfId,
                    name: "Base Central",
                    hp: 5000, maxHp: 5000
                });
            }

            // Inyectamos los datos persistentes a la memoria RAM
            centralBase.name = dbTurf.name;
            centralBase.hp = dbTurf.hp;
            centralBase.maxHp = dbTurf.maxHp;
            centralBase.currentOwnerSquadId = dbTurf.ownerSquadName;

            console.log(`🏰 [${centralBase.name}] cargada en RAM. Dueño actual: ${centralBase.currentOwnerSquadId || 'Nadie'}`);
        }
        console.log(`🌍 Mapa Físico cargado en RAM del servidor (${allTiles.length} bloques).`);
    } catch (err) {
        console.error("Error cargando el mapa:", err);
    }
}

// Función que usaremos para detectar hackers traspasando paredes
const TILE_SIZE = 16;
function serverCheckCollision(x, y) {
    const hitX = 5;
    const hitY = 5;
    const offsetY = 3;

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
const wss = new WebSocket.Server({ port: PORT });

// This object acts as the server's memory. It holds every player's current state.
const players = {};

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
        lastShotTime: 0,
        isReloading: false,
        equipped: { head: 'head_default', body: 'body_default', hands: 'none' }
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

        const data = JSON.parse(message);

        // 1. HANDLE REGISTRATION
        if (data.type === 'register') {
            try {
                const existingUser = await User.findOne({ email: data.email });
                if (existingUser) return ws.send(JSON.stringify({ type: 'auth_error', message: 'Email already registered' }));

                const hashedPassword = await bcrypt.hash(data.password, 10);
                const newUser = new User({
                    email: data.email,
                    username: data.username, // Give them a default display name
                    password: hashedPassword
                });
                await newUser.save();

                ws.send(JSON.stringify({ type: 'register_success', message: 'Account created! You can now log in.' }));
            } catch (err) { console.error(err); ws.send(JSON.stringify({ type: 'auth_error', message: 'Server error.' })); }
        }

        // 2. HANDLE LOGIN
        if (data.type === 'login') {
            try {
                // Search by EMAIL instead of username
                const user = await User.findOne({ email: data.email });
                if (!user) return ws.send(JSON.stringify({ type: 'auth_error', message: 'Email not found' }));

                const isMatch = await bcrypt.compare(data.password, user.password);
                if (!isMatch) return ws.send(JSON.stringify({ type: 'auth_error', message: 'Incorrect password' }));

                // --- NEW: RETROACTIVELY GIVE EXISTING PLAYERS THE GUN ---
                if (!user.inventory || user.inventory.length === 0) {
                    user.inventory = ["ghost_gun"];
                    user.markModified('inventory'); // <--- THE FIX: Force MongoDB to see the change!
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
                players[id].worldX = user.worldX;
                players[id].worldY = user.worldY;
                players[id].friends = user.friends;
                // --- THE FIX: Give the server memory their inventory! ---
                players[id].inventory = user.inventory;

                players[id].equippedWeapon = user.equippedWeapon || "none";
                players[id].equipped = user.equipped || { head: 'head_default', body: 'body_default', hands: 'none' };

                // --- THE HOTBAR PERSISTENCE FIX ---
                players[id].hotbar = user.hotbar || ["none", "none", "none"];

                // --- NUEVO: CARGAR MONEDAS A LA RAM ---
                players[id].coins = user.coins || 0;

                // 👇 NUEVO: CARGAR KILLS Y LOSSES 👇
                players[id].kills = user.kills || 0;
                players[id].losses = user.losses || 0;
                // 👇 NUEVO: CARGAR SALUD A LA RAM 👇
                players[id].hp = user.hp !== undefined ? user.hp : 100;
                players[id].isDead = user.isDead || false;

                // 🛑 EL FIX: REINICIAR EL TEMPORIZADOR DE COMBATE AL ENTRAR 🛑
                // Esto evita que los que recargan la página se curen mágicamente
                players[id].lastHitTime = Date.now();

                // Agrega esta línea para guardar el ID único de MongoDB en RAM:
                players[id].accountId = user._id.toString();

                // --- NUEVO: PASAR EL ROL A LA MEMORIA ---
                players[id].role = user.role || 'player';

                // --- NUEVO: CARGAR EL TAG DEL SQUAD EN RAM ---
                if (user.squad) {
                    const mySquad = await Squad.findById(user.squad);
                    if (mySquad) {
                        players[id].squad = mySquad._id.toString();
                        players[id].squadName = mySquad.name;
                        players[id].squadLogo = mySquad.logo;
                    }
                }
                // Send success and include their friends list!
                ws.send(JSON.stringify({
                    type: 'login_success',
                    player: players[id],
                    token: newToken,
                    friends: user.friends
                }));

                // Move the closing bracket so 'ws' is the second argument!
                broadcast({ type: 'update', id: id, player: players[id] }, ws);
            } catch (err) { console.error(err); }
        }

        // 3. HANDLE PROFILE EDITS (Ahora es limpio gracias a los IDs)
        if (data.type === 'change_username' && isAuthenticated) {
            try {
                const newUsername = data.newUsername;
                await User.findOneAndUpdate({ email: currentUser }, { username: newUsername });
                players[id].username = newUsername;
                broadcast({ type: 'update', id: id, player: players[id] }, ws);
                ws.send(JSON.stringify({ type: 'profile_updated', username: newUsername }));
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
                                client.send(JSON.stringify({
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

                    // 👇 EL FIX: Si pasamos el borrador por encima de la base, la destruimos
                    if (centralBase && centralBase.gridX === data.x && centralBase.gridY === data.y) {
                        await Turf.deleteOne({ turfId: centralBase.turfId });
                        centralBase = null;
                        wss.clients.forEach(c => {
                            if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'base_update', base: null }));
                        });
                        console.log("🗑️ Base destruida con el Borrador.");
                    }
                } else {
                    // 🎨 PAINT: Destroy old corrupted tiles first, then insert the clean new one
                    await Tile.deleteMany(query);
                    await Tile.create({ x: data.x, y: data.y, l: data.l, tileId: data.tileId });
                }

                // EN LA SECCIÓN 5 (place_tile):
                wss.clients.forEach(client => {
                    // --- EL FIX: Agregamos client !== ws para no mandarnos ecos ---
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'tile_update', x: data.x, y: data.y, l: data.l, tileId: data.tileId
                        }));
                    }
                });
            } catch (err) { console.error('Tile Save Error:', err); }
        }

        // 5.5 HANDLE BULK BUILDING (SÚPER GUARDADO MULTI-CAPA ANTI-LAG)
        if (data.type === 'place_tiles_bulk') {
            // --- EL CANDADO DE SEGURIDAD ABSOLUTA ---
            if (!players[id] || players[id].role !== 'admin') return;

            try {
                const bulkOps = [];
                for (let t of data.tiles) {
                    if (t.tileId === -1) {
                        // BORRADOR: Solo borramos el bloque específico en su capa
                        bulkOps.push({ deleteMany: { filter: { x: t.x, y: t.y, l: t.l } } });

                        // 👇 EL FIX: Si borramos la base con el borrador de arrastre masivo
                        if (centralBase && centralBase.gridX === t.x && centralBase.gridY === t.y) {
                            await Turf.deleteOne({ turfId: centralBase.turfId });
                            centralBase = null;
                            wss.clients.forEach(c => {
                                if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'base_update', base: null }));
                            });
                        }
                    } else {
                        // UPSERT: Si existe, lo sobrescribe. Si no existe, lo crea. ¡1 sola operación!
                        bulkOps.push({
                            updateOne: {
                                filter: { x: t.x, y: t.y, l: t.l },
                                update: { $set: { tileId: t.tileId, rotation: t.rotation || 0 } }, // <--- EL FIX
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
                        client.send(JSON.stringify({
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

                const updateData = { hasCollision: data.hasCollision, l: data.layer };

                // --- NUEVO: ACTUALIZAR LA RAM DEL SERVIDOR EN TIEMPO REAL ---
                const key = `${data.x},${data.y},${data.layer}`;
                if (!serverWorldMap[key]) serverWorldMap[key] = {};
                serverWorldMap[key].hasCollision = data.hasCollision;

                if (data.triggerType) {
                    updateData.triggerType = data.triggerType;
                    updateData.destX = data.destX;
                    updateData.destY = data.destY;
                    updateData.itemId = data.itemId;

                    // Guardar también en RAM
                    serverWorldMap[key].triggerType = data.triggerType;
                    serverWorldMap[key].destX = data.destX;
                    serverWorldMap[key].destY = data.destY;
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
                            $setOnInsert: { hp: data.turfHp || 5000, ownerSquadName: null }
                        },
                        { upsert: true, new: true }
                    );

                    // La cargamos a la memoria RAM instantáneamente
                    centralBase = {
                        turfId: uniqueTurfId,
                        gridX: data.x, gridY: data.y,
                        worldX: (data.x * 16) + 8, worldY: (data.y * 16) + 8,
                        hp: dbTurf.hp, maxHp: dbTurf.maxHp,
                        currentOwnerSquadId: dbTurf.ownerSquadName,
                        name: dbTurf.name,
                        damageTracker: {}
                    };

                    console.log(`🏰 Base Guardada/Actualizada en vivo: ${centralBase.name} (${centralBase.maxHp} HP)`);

                    wss.clients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'base_update', base: centralBase }));
                    });
                } else {
                    // 👇 NUEVO: Si cambias el bloque a "Normal", DESTRUIMOS LA BASE por completo
                    if (centralBase && centralBase.gridX === data.x && centralBase.gridY === data.y) {
                        await Turf.deleteOne({ turfId: centralBase.turfId });
                        centralBase = null;
                        wss.clients.forEach(c => {
                            if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'base_update', base: null }));
                        });
                        console.log(`🗑️ Base eliminada mediante el Inspector.`);
                    }
                }

                wss.clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'tile_meta_update',
                            x: data.x, y: data.y, layer: data.layer, hasCollision: data.hasCollision,
                            triggerType: data.triggerType, destX: data.destX, destY: data.destY,
                            itemId: data.itemId // <--- AÑADE ESTO
                        }));
                    }
                });
            } catch (err) { console.error('Meta Update Error:', err); }
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

                    await User.findOneAndUpdate(
                        { email: currentUser },
                        { "equipped.head": data.head, "equipped.body": data.body, "equipped.hat": data.hat }
                    );

                    broadcast({ type: 'update', id: id, player: p }, ws);
                }
            } catch (err) { console.error("Error actualizando guardarropa:", err); }
        }

        // --- NUEVO: CREAR ZONA SEGURA (ADMIN) ---
        if (data.type === 'create_safezone') {
            if (!players[id] || players[id].role !== 'admin') return;

            try {
                const newZone = new SafeZone({
                    name: data.name,
                    xMin: data.xMin, xMax: data.xMax,
                    yMin: data.yMin, yMax: data.yMax
                });
                await newZone.save();

                // Actualizar la RAM del servidor
                safeZonesRAM.push(newZone);

                // Avisarle a todos los jugadores conectados que hay una nueva zona
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'new_safezone', zone: newZone }));
                    }
                });
            } catch (err) { console.error("Error guardando SafeZone:", err); }
        }

        // 4. HANDLE AUTO-LOGIN
        if (data.type === 'auto_login') {
            try {
                // Find the user by their secret token
                const user = await User.findOne({ token: data.token });

                if (!user) {
                    return ws.send(JSON.stringify({ type: 'auth_error', message: 'Session expired. Please log in again.' }));
                }

                // --- NEW: RETROACTIVELY GIVE EXISTING PLAYERS THE GUN ---
                if (!user.inventory || user.inventory.length === 0) {
                    user.inventory = ["ghost_gun"];
                    user.markModified('inventory'); // <--- THE FIX: Force MongoDB to see the change!
                    await user.save();
                }

                isAuthenticated = true;
                currentUser = user.email; // We track the session by email now!

                // Pass their data to the lobby memory
                players[id].email = user.email;
                players[id].username = user.username;
                players[id].worldX = user.worldX;
                players[id].worldY = user.worldY;
                players[id].friends = user.friends; // Don't forget the friends list!
                // --- FIX: Give the server memory their inventory! ---
                players[id].inventory = user.inventory;

                // --- THE PERSISTENCE FIX: Load the saved weapon! ---
                players[id].equippedWeapon = user.equippedWeapon || "none";
                players[id].equipped = user.equipped || { head: 'head_default', body: 'body_default', hands: 'none' }; players[id].hotbar = user.hotbar || ["none", "none", "none"];

                // --- NUEVO: CARGAR MONEDAS A LA RAM ---
                players[id].coins = user.coins || 0;

                // 👇 NUEVO: CARGAR KILLS Y LOSSES 👇
                players[id].kills = user.kills || 0;
                players[id].losses = user.losses || 0;

                // 👇 NUEVO: CARGAR SALUD A LA RAM 👇
                players[id].hp = user.hp !== undefined ? user.hp : 100;
                players[id].isDead = user.isDead || false;

                // 🛑 EL FIX: REINICIAR EL TEMPORIZADOR DE COMBATE AL ENTRAR 🛑
                // Esto evita que los que recargan la página se curen mágicamente
                players[id].lastHitTime = Date.now();

                // Agrega esta línea para guardar el ID único de MongoDB en RAM:
                players[id].accountId = user._id.toString();

                // --- NUEVO: PASAR EL ROL A LA MEMORIA ---
                players[id].role = user.role || 'player';

                // --- NUEVO: CARGAR EL TAG DEL SQUAD EN RAM ---
                if (user.squad) {
                    const mySquad = await Squad.findById(user.squad);
                    if (mySquad) {
                        players[id].squad = mySquad._id.toString();
                        players[id].squadName = mySquad.name;
                        players[id].squadLogo = mySquad.logo;
                    }
                }

                // Send success back to the browser
                ws.send(JSON.stringify({
                    type: 'login_success',
                    player: players[id],
                    token: user.token,
                    friends: user.friends
                }));

                // Tell everyone else you arrived (excluding yourself so no ghost clone appears!)
                broadcast({ type: 'update', id: id, player: players[id] }, ws);
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

                // 🚔 ¡HACKER DETECTADO! 
                ws.send(JSON.stringify({
                    type: 'force_position',
                    x: p.worldX,
                    y: p.worldY
                }));

            } else {
                // Movimiento legal (o Teleport Autorizado)
                p.worldX = requestedX;
                p.worldY = requestedY;
            }

            p.frameX = data.player.frameX;
            p.frameY = data.player.frameY;
            p.isMoving = data.player.isMoving;
            p.isTyping = data.player.isTyping;

            let safeMsg = data.player.message || "";
            p.message = safeMsg.substring(0, 100);
            p.messageTimer = Math.min(data.player.messageTimer || 0, 600);

            // Enviar posición oficial a los demás
            wss.clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'update', id: id, player: p }));
                }
            });
        }

        // --- NUEVO: RUTA SEGURA PARA EQUIPAR ARMAS ---
        if (data.type === 'equip_weapon') {
            const p = players[id];
            if (!p) return;

            if (data.weaponId === "none" || (p.hotbar && p.hotbar.includes(data.weaponId))) {
                p.equippedWeapon = data.weaponId;

                // --- EL FIX ANTI-CRASH: Guardar el Timer en 'ws' en lugar de 'p' ---
                if (ws.reloadTimeout) clearTimeout(ws.reloadTimeout);

                // Limpiar la variable contaminada por si acaso quedó viva
                delete p.reloadTimeout;

                const stats = WEAPONS[data.weaponId];
                if (stats) {
                    p.ammo = 0;
                    p.isReloading = true;

                    ws.reloadTimeout = setTimeout(() => {
                        if (players[id] && players[id].equippedWeapon === data.weaponId) {
                            players[id].ammo = stats.magSize;
                            players[id].isReloading = false;
                        }
                    }, stats.reloadTime);
                } else {
                    p.ammo = 0;
                    p.isReloading = false;
                }

                // Ahora 'p' está 100% limpio de Timers de Node.js
                broadcast({ type: 'update', id: id, player: p }, ws);
            }
        }

        // --- NUEVO: RUTA SEGURA PARA ACTUALIZAR EL HOTBAR ---
        if (data.type === 'update_hotbar') {
            const p = players[id];
            if (!p) return;

            // Verificar que el arma que quiere poner en el hotbar realmente exista en su inventario
            if (data.weaponId === "none" || (p.inventory && p.inventory.includes(data.weaponId))) {
                if (!p.hotbar) p.hotbar = ["none", "none", "none"];
                p.hotbar[data.slotIndex] = data.weaponId;
            }
        }

        // 7. HANDLE SHOOTING (SINCRO VISUAL ABSOLUTA ANTI-FANTASMAS)
        if (data.type === 'shoot') {
            const shooter = players[id];
            const weaponId = shooter.equippedWeapon || "none";
            const stats = WEAPONS[weaponId];

            if (!stats || weaponId === "none") return;

            // BLOQUEO DE DISPARO EN ZONA SEGURA
            if (isInSafeZone(shooter.worldX, shooter.worldY)) {
                return;
            }

            const now = Date.now();

            // 🛑 EL FIX: Quitamos la lógica estricta de munición de este bloque.
            // Las balas visuales NO hacen daño. El verdadero escudo anti-hack está en 'damage_player'.
            // Al hacer esto, evitamos la desincronización y el lag de internet.

            // Solo dejamos un Anti-Spam básico (Ej. máximo 20 balas visuales por segundo)
            // para evitar que un hacker malicioso sature la pantalla de luces.
            if (now - (shooter.lastShotTime || 0) < 50) {
                return;
            }
            shooter.lastShotTime = now;

            // Replicar la bala a todos los demás instantáneamente sin hacer preguntas
            wss.clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'shoot', id: id, x: data.x, y: data.y, angle: data.angle, weaponId: weaponId
                    }));
                }
            });
        }

        // 8. MANEJAR EL DAÑO Y LA VIDA (CON ESCUDO ANTI-CHEAT DEFINITIVO)
        if (data.type === 'damage_player') {
            const shooter = players[id];
            const target = players[data.targetId];

            if (shooter && target && !target.isDead) {

                const weaponId = data.weaponId || shooter.equippedWeapon || "none";
                const stats = WEAPONS[weaponId];
                if (!stats || weaponId === "none") return;

                const now = Date.now();

                // 2. ANTI-METRALLETA DE DAÑO
                const lastDamage = shooter.lastDamageTime || 0;
                if (now - lastDamage < ((stats.fireRate || 300) - 50)) {
                    return;
                }
                shooter.lastDamageTime = now;

                // 3. RANGO
                const dist = Math.hypot(shooter.worldX - target.worldX, shooter.worldY - target.worldY);
                // Si es melee, el rango máximo es de la Hitbox. Si es pistola usa speed * range
                const maxDist = stats.type === 'melee' ? (stats.dirStats?.[0]?.hitLen || 60) * 2 : (stats.range * stats.speed) * 1.3;
                if (dist > maxDist && stats.type !== 'melee') return;

                // 4. FUEGO AMIGO
                if (shooter.squad && target.squad && shooter.squad === target.squad) return;

                // 4.5 ZONA SEGURA
                if (isInSafeZone(shooter.worldX, shooter.worldY) || isInSafeZone(target.worldX, target.worldY)) return;

                // 5. ESCUDO DE PROTECCIÓN AL REVIVIR
                if (target.invulnerableUntil && now < target.invulnerableUntil) return;

                // 🛑 EL FIX FINAL ANTI-FANTASMA
                const actualDamage = Number(stats.damage) || 10;
                target.hp = (Number(target.hp) || 100) - actualDamage;
                target.lastHitTime = Date.now();

                // 💥 SISTEMA DE EMPUJE (KNOCKBACK AL ENEMIGO CON COLISIONES) 💥
                let knockbackForce = 0;
                if (stats.dirStats) {
                    const kbDir = stats.dirStats['0'] || stats.dirStats['1'] || stats.dirStats['2'] || stats.dirStats['3'] || {};
                    knockbackForce = Number(kbDir.kb) || 0;
                }

                if (knockbackForce > 0 && !target.isDead) {
                    const angle = Math.atan2(target.worldY - shooter.worldY, target.worldX - shooter.worldX);

                    // 🛑 EL FIX: En lugar de teletransportar, caminamos pasito a pasito. 
                    // Si encontramos una pared, el empuje se cancela.
                    let stepForce = knockbackForce / 5;
                    for (let i = 0; i < 5; i++) {
                        let nextX = target.worldX + (Math.cos(angle) * stepForce);
                        let nextY = target.worldY + (Math.sin(angle) * stepForce);

                        if (!serverCheckCollision(nextX, nextY)) {
                            target.worldX = nextX;
                            target.worldY = nextY;
                        } else {
                            break; // 🧱 Chocó contra pared, salvado.
                        }
                    }

                    // Avisar a la cámara de la víctima
                    wss.clients.forEach(c => {
                        if (c.playerId === data.targetId && c.readyState === WebSocket.OPEN) {
                            c.send(JSON.stringify({
                                type: 'force_position',
                                x: target.worldX,
                                y: target.worldY,
                                reason: 'knockback'
                            }));
                        }
                    });

                    // 2. Avisar a todos los DEMÁS que la víctima salió volando
                    // 🛑 EL FIX: Quitamos el JSON.stringify
                    broadcast({ type: 'update', id: data.targetId, player: target });
                }

                // --- SISTEMA DE MUERTE (DERRIBADO) ---
                if (target.hp <= 0) {
                    target.hp = 0;
                    target.isDead = true;

                    shooter.kills = (shooter.kills || 0) + 1;
                    target.losses = (target.losses || 0) + 1;

                    // Revivir al jugador después de 3 segundos
                    setTimeout(() => {
                        if (players[data.targetId]) {
                            players[data.targetId].hp = 100;
                            players[data.targetId].isDead = false;
                            players[data.targetId].lastHitTime = Date.now();
                            players[data.targetId].invulnerableUntil = Date.now() + 100;

                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'hp_update', targetId: data.targetId,
                                        newHp: 100, damageDealt: 0, isDead: false
                                    }));
                                }
                            });
                        }
                    }, 3000);
                }

                // Enviar la actualización de vida a todos
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'hp_update',
                            targetId: data.targetId,
                            newHp: target.hp,
                            damageDealt: actualDamage,
                            isDead: target.isDead || false,
                            shooterId: id,
                            shooterKills: shooter.kills,
                            targetLosses: target.losses
                        }));
                    }
                });
            }
        }
        // --- 1. SINCRONIZAR ANIMACIÓN MELEE ---
        if (data.type === 'melee_swing') {
            // 🛑 EL FIX: Quitamos el JSON.stringify porque la función 'broadcast' ya lo hace internamente.
            // También usamos 'id' directo en lugar de 'ws.playerId'.
            broadcast({
                type: 'player_swing',
                id: id,
                weaponId: data.weaponId
            }, ws);
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

                if (targetWsId) {
                    wss.clients.forEach(client => {
                        if (client.playerId === targetWsId && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'receive_pm',
                                senderAccountId: myAccountId,
                                senderUsername: players[id].username,
                                history: conv.messages
                            }));
                        }
                    });
                }

                ws.send(JSON.stringify({ type: 'pm_history', targetAccountId: targetAccountId, targetUsername: data.targetUsername, history: conv.messages }));
            } catch (err) { console.error("Error en PM:", err); }
        }

        // 10. PEDIR HISTORIAL DE CHAT
        if (data.type === 'get_pm_history' && isAuthenticated) {
            try {
                const myAccountId = players[id].accountId;
                const targetAccountId = data.targetAccountId;

                // Buscar el nombre ACTUAL del usuario en la base de datos (Magia del ID)
                const targetUser = await User.findById(targetAccountId);
                const currentTargetName = targetUser ? targetUser.username : "Usuario Desconocido";

                const conv = await PM.findOne({ participants: { $all: [myAccountId, targetAccountId] } });

                ws.send(JSON.stringify({
                    type: 'pm_history',
                    targetAccountId: targetAccountId,
                    targetUsername: currentTargetName, // Devolvemos el nombre real!
                    history: conv ? conv.messages : []
                }));
            } catch (err) { console.error("Error pidiendo historial:", err); }
        }

        // 11. PEDIR LISTA DE INBOX
        if (data.type === 'get_inbox' && isAuthenticated) {
            try {
                const myAccountId = players[id].accountId;
                const convos = await PM.find({ participants: myAccountId });

                const inboxData = [];
                for (let c of convos) {
                    const otherPersonId = c.participants.find(p => p !== myAccountId);

                    // Buscar su nombre ACTUAL
                    const otherUser = await User.findById(otherPersonId);
                    const currentName = otherUser ? otherUser.username : "Usuario Desconocido";

                    const lastMsg = c.messages.length > 0 ? c.messages[c.messages.length - 1] : null;

                    inboxData.push({
                        targetAccountId: otherPersonId,
                        targetUser: currentName,
                        lastMessage: lastMsg ? lastMsg.text : "Comienza a chatear...",
                        time: lastMsg ? lastMsg.timestamp : 0
                    });
                }

                inboxData.sort((a, b) => new Date(b.time) - new Date(a.time));
                ws.send(JSON.stringify({ type: 'inbox_data', inbox: inboxData }));
            } catch (err) { console.error("Error pidiendo inbox:", err); }
        }
        // 12. PEDIR LISTA DE AMIGOS ACTUALIZADA (Versión Optimizada)
        if (data.type === 'get_friends_list' && isAuthenticated) {
            try {
                const myUser = await User.findOne({ email: currentUser });

                // 1. Filtramos en milisegundos (en RAM) solo los IDs que sí son válidos
                const validFriendIds = (myUser.friends || []).filter(id => mongoose.Types.ObjectId.isValid(id));

                // 2. LA MAGIA: Le pedimos a MongoDB que nos traiga TODOS esos usuarios en 1 SOLA CONSULTA
                const friendsUsers = await User.find({ _id: { $in: validFriendIds } });

                // 3. Armamos el paquete para enviarlo al juego
                const friendsData = friendsUsers.map(fUser => ({
                    accountId: fUser._id.toString(),
                    username: fUser.username
                }));

                ws.send(JSON.stringify({ type: 'friends_list_data', friends: friendsData }));
            } catch (err) { console.error("Error pidiendo amigos:", err); }
        }
        // 13. SISTEMA DE COMPRAS SEGURAS (TIENDA)
        if (data.type === 'buy_item' && isAuthenticated) {
            const p = players[id];
            if (!p) return;

            const weaponId = data.itemId;
            const weaponStats = WEAPONS[weaponId];

            if (!weaponStats) return ws.send(JSON.stringify({ type: 'buy_error', message: 'Este objeto no existe.' }));
            if (p.inventory && p.inventory.includes(weaponId)) return ws.send(JSON.stringify({ type: 'buy_error', message: 'Ya posees esta arma.' }));
            if (p.coins < weaponStats.price) return ws.send(JSON.stringify({ type: 'buy_error', message: 'Monedas insuficientes.' }));

            try {
                p.coins -= weaponStats.price;
                if (!p.inventory) p.inventory = [];
                p.inventory.push(weaponId);

                await User.findByIdAndUpdate(p.accountId, { coins: p.coins, inventory: p.inventory });

                ws.send(JSON.stringify({ type: 'buy_success', message: `¡Compraste ${weaponStats.name}!`, newCoins: p.coins, newInventory: p.inventory }));
                ws.send(JSON.stringify({ type: 'update', id: id, player: p })); // Actualiza al jugador
            } catch (err) { console.error("Error al comprar:", err); }
        }

        // 14. CREAR SQUAD (CLAN) CON COBRO Y LOGO
        if (data.type === 'create_squad' && isAuthenticated) {
            try {
                const p = players[id];
                const squadName = data.squadName.trim();
                const squadLogo = data.logo ? data.logo.trim() : ""; // <--- NUEVO
                const SQUAD_PRICE = 2000;

                if (squadName.length < 3 || squadName.length > 20) {
                    return ws.send(JSON.stringify({ type: 'squad_error', message: 'El nombre debe tener entre 3 y 20 letras.' }));
                }

                // SEGURIDAD: Solo URLs de Pinterest
                if (squadLogo !== "" && !squadLogo.startsWith("https://i.pinimg.com/")) {
                    return ws.send(JSON.stringify({ type: 'squad_error', message: 'El logo debe ser de Pinterest (Empieza con https://i.pinimg.com/)' }));
                }

                if (p.coins < SQUAD_PRICE) return ws.send(JSON.stringify({ type: 'squad_error', message: `Necesitas ${SQUAD_PRICE} 🪙 para fundar un clan.` }));

                const myUser = await User.findOne({ email: currentUser });
                if (myUser.squad) return ws.send(JSON.stringify({ type: 'squad_error', message: 'Ya eres miembro de un Squad principal.' }));

                const existingSquad = await Squad.findOne({ name: new RegExp('^' + squadName + '$', 'i') });
                if (existingSquad) return ws.send(JSON.stringify({ type: 'squad_error', message: 'Ese nombre ya está en uso.' }));

                p.coins -= SQUAD_PRICE;
                myUser.coins = p.coins;

                const newSquad = new Squad({
                    name: squadName,
                    leader: myUser._id,
                    logo: squadLogo, // <--- GUARDAMOS EL LOGO
                    members: []
                });
                await newSquad.save();

                myUser.squad = newSquad._id;
                await myUser.save();
                p.squad = newSquad._id.toString();
                p.squadName = newSquad.name;
                p.squadLogo = newSquad.logo;

                ws.send(JSON.stringify({ type: 'squad_success', message: `¡Has fundado el Squad [${squadName}]!`, newCoins: p.coins, squadName: newSquad.name, squadLogo: squadLogo }));
                broadcast({ type: 'update', id: id, player: p }, ws);
            } catch (err) { ws.send(JSON.stringify({ type: 'squad_error', message: 'Error interno del servidor.' })); }
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
                    ws.send(JSON.stringify({ type: 'friend_removed', targetId: data.targetId }));
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

                if (mySquads.length === 0) return ws.send(JSON.stringify({ type: 'no_squads_found' }));

                mySquads.sort((a, b) => {
                    const aIsLeader = a.leader.toString() === myUser._id.toString();
                    const bIsLeader = b.leader.toString() === myUser._id.toString();
                    if (aIsLeader && !bIsLeader) return -1;
                    if (!aIsLeader && bIsLeader) return 1;
                    return 0;
                });

                const listData = mySquads.map(sq => ({
                    id: sq._id,
                    name: sq.name,
                    logo: sq.logo, // <--- ENVIAMOS EL LOGO
                    isLeader: sq.leader.toString() === myUser._id.toString(),
                    memberCount: sq.members.length + 1
                }));

                ws.send(JSON.stringify({ type: 'my_squads_list_data', squads: listData }));
            } catch (err) { console.error(err); }
        }

        // 17. OBTENER DETALLES DE UN SQUAD ESPECÍFICO (Con Logo)
        if (data.type === 'get_squad_details' && isAuthenticated) {
            try {
                const squad = await Squad.findById(data.squadId).populate('leader', 'username').populate('members.accountId', 'username');
                if (!squad) return;

                const squadData = {
                    id: squad._id,
                    name: squad.name,
                    logo: squad.logo, // <--- ENVIAMOS EL LOGO AL PERFIL
                    leader: { id: squad.leader._id, name: squad.leader.username },
                    members: squad.members.map(m => {
                        if (!m.accountId) return null;
                        return { id: m.accountId._id, name: m.accountId.username, title: m.customTitle };
                    }).filter(m => m !== null)
                };

                ws.send(JSON.stringify({ type: 'my_squad_data', squad: squadData }));
            } catch (err) { console.error(err); }
        }

        // 18. NUEVO: EDITAR SQUAD (COBRO DE 350 SOLO SI CAMBIA EL NOMBRE)
        if (data.type === 'edit_squad' && isAuthenticated) {
            try {
                const p = players[id];
                const squad = await Squad.findById(data.squadId);
                const myUser = await User.findOne({ email: currentUser });

                // Seguridad: Verificar si existe y si soy el líder
                if (!squad || squad.leader.toString() !== myUser._id.toString()) {
                    return ws.send(JSON.stringify({ type: 'edit_squad_error', message: 'No tienes permisos de Líder.' }));
                }

                const newName = data.newName.trim();
                const newLogo = data.newLogo ? data.newLogo.trim() : "";

                if (newName.length < 3 || newName.length > 20) return ws.send(JSON.stringify({ type: 'edit_squad_error', message: 'El nombre debe tener entre 3 y 20 letras.' }));
                if (newLogo !== "" && !newLogo.startsWith("https://i.pinimg.com/")) return ws.send(JSON.stringify({ type: 'edit_squad_error', message: 'El logo debe ser una imagen de Pinterest.' }));

                // ¿Cambió el nombre? Si es así, validamos y cobramos 350
                let nameChanged = (newName !== squad.name);
                if (nameChanged) {
                    if (p.coins < 350) return ws.send(JSON.stringify({ type: 'edit_squad_error', message: 'Necesitas 350 🪙 para cambiar el nombre.' }));

                    const existingSquad = await Squad.findOne({ name: new RegExp('^' + newName + '$', 'i') });
                    if (existingSquad) return ws.send(JSON.stringify({ type: 'edit_squad_error', message: 'Ese nombre ya está en uso por otra banda.' }));

                    // Cobrar
                    p.coins -= 350;
                    myUser.coins = p.coins;
                    await myUser.save();

                    squad.name = newName;
                }

                squad.logo = newLogo;
                await squad.save();

                ws.send(JSON.stringify({ type: 'edit_squad_success', message: '¡Actualizado!', newCoins: p.coins, squadId: squad._id, squadName: p.squadName, squadLogo: p.squadLogo }));;
            } catch (err) { ws.send(JSON.stringify({ type: 'edit_squad_error', message: 'Error del servidor.' })); }
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
                    return ws.send(JSON.stringify({ type: 'squad_error', message: 'No perteneces a este squad.' }));
                }

                // 2. Lógica del "Interruptor" (Toggle)
                let isActive = false;

                // Si el squad que me envió es el mismo que ya tengo equipado, significa que lo quiero QUITAR
                if (myUser.squad && myUser.squad.toString() === squadId) {
                    myUser.squad = null;
                    p.squad = null;
                    p.squadName = null; // <--- NUEVO
                    p.squadLogo = null; // <--- NUEVO
                    isActive = false;
                } else {
                    // Si es distinto o estaba en null, lo quiero EQUIPAR (reemplaza a cualquier otro)
                    myUser.squad = squad._id;
                    p.squad = squad._id.toString();
                    p.squadName = squad.name; // <--- NUEVO
                    p.squadLogo = squad.logo; // <--- NUEVO
                    isActive = true;
                }

                // 3. Guardar en Base de Datos y avisar a todos
                await myUser.save();

                ws.send(JSON.stringify({ type: 'toggle_squad_success', isActive: isActive, squadId: squadId, squadName: p.squadName, squadLogo: p.squadLogo }));

                // Avisarle a los demás jugadores conectados que cambiaste tu Tag
                broadcast({ type: 'update', id: id, player: p }, ws);

            } catch (err) {
                console.error("Error al hacer toggle del tag:", err);
            }
        }// 20. ENVIAR INVITACIÓN AL CLAN
        if (data.type === 'send_squad_invite' && isAuthenticated) {
            try {
                const p = players[id];
                if (!p.squad) return ws.send(JSON.stringify({ type: 'squad_error', message: 'Primero equipa tu Tag para invitar.' }));

                const squad = await Squad.findById(p.squad);
                if (!squad) return;

                const myUser = await User.findOne({ email: currentUser });
                const isLeader = squad.leader.toString() === myUser._id.toString();
                const memberData = squad.members.find(m => m.accountId.toString() === myUser._id.toString());
                const canInvite = isLeader || (memberData && memberData.canInvite);

                if (!canInvite) return ws.send(JSON.stringify({ type: 'squad_error', message: 'No tienes permisos para reclutar.' }));

                // --- NUEVA VALIDACIÓN: ¿El objetivo ya está en ESTE clan? ---
                const targetIsLeader = squad.leader.toString() === data.targetAccountId;
                const targetIsMember = squad.members.some(m => m.accountId.toString() === data.targetAccountId);

                if (targetIsLeader || targetIsMember) {
                    return ws.send(JSON.stringify({ type: 'squad_error', message: 'Este jugador ya pertenece a tu clan.' }));
                }

                // Buscar al objetivo y ver si está conectado
                let targetWsId = null;
                for (let pid in players) {
                    if (players[pid].accountId === data.targetAccountId) targetWsId = pid;
                }

                if (targetWsId) {
                    wss.clients.forEach(client => {
                        if (client.playerId === targetWsId && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'squad_invite',
                                squadId: squad._id,
                                squadName: squad.name,
                                senderUsername: p.username,
                                senderFrameX: p.frameX,
                                senderFrameY: p.frameY
                            }));
                        }
                    });
                    ws.send(JSON.stringify({ type: 'squad_success', message: 'Invitación enviada.' }));
                } else {
                    ws.send(JSON.stringify({ type: 'squad_error', message: 'El jugador no está en línea.' }));
                }
            } catch (err) { console.error("Error invitando al clan:", err); }
        }

        // 21. ACEPTAR INVITACIÓN AL CLAN
        if (data.type === 'accept_squad_invite' && isAuthenticated) {
            try {
                const squad = await Squad.findById(data.squadId);
                if (!squad) return ws.send(JSON.stringify({ type: 'squad_error', message: 'El clan ya no existe.' }));

                const myUser = await User.findOne({ email: currentUser });

                // Regla 1: Límite de miembros (Excluye al líder)
                if (squad.members.length >= 24) return ws.send(JSON.stringify({ type: 'squad_error', message: 'El clan está lleno.' }));

                // Regla 2: ¿Ya estoy en este clan?
                const isMember = squad.members.some(m => m.accountId.toString() === myUser._id.toString());
                const isLeader = squad.leader.toString() === myUser._id.toString();

                if (!isMember && !isLeader) {
                    // Lo agregamos como miembro básico
                    squad.members.push({ accountId: myUser._id });
                    await squad.save();

                    ws.send(JSON.stringify({ type: 'squad_success', message: `¡Te has unido al clan [${squad.name}]!` }));
                } else {
                    ws.send(JSON.stringify({ type: 'squad_error', message: 'Ya eres miembro de este clan.' }));
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
                        client.send(JSON.stringify({ type: 'sync_weapon_pivot', weaponId: data.weaponId, pivotX: data.pivotX, pivotY: data.pivotY }));
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
                        client.send(JSON.stringify({ type: 'sync_melee_stats', weaponId: data.weaponId, direction: data.direction, stats: data.stats }));
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

                // Marcar el array como modificado para que Mongoose lo guarde bien
                User.findByIdAndUpdate(p.accountId, { inventory: p.inventory }).catch(console.error);

                broadcast({ type: 'remove_item', id: itemId });

                // Avisamos visualmente que entró a la mochila
                ws.send(JSON.stringify({
                    type: 'system_message',
                    text: `🎒 Recogiste: ${item.name}`,
                    color: '#3498db'
                }));

                // 🛑 EL FIX: El servidor le envía a tu pantalla tu nueva mochila
                ws.send(JSON.stringify({
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

                User.findByIdAndUpdate(p.accountId, { coins: p.coins, inventory: p.inventory }).catch(console.error);

                ws.send(JSON.stringify({
                    type: 'sell_success',
                    earned: totalEarned,
                    newCoins: p.coins,
                    newInventory: p.inventory
                }));
                broadcast({ type: 'update', id: id, player: p }, ws);
            } else {
                // 🛑 EL FIX: Si por algo falla, que el servidor te avise en pantalla en lugar de ignorarte
                ws.send(JSON.stringify({ type: 'system_message', text: "Error: No se encontró basura válida para vender.", color: '#e74c3c' }));
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
                ws.send(JSON.stringify({ type: 'system_message', text: "🛑 No tienes suficiente cantidad de este ítem.", color: '#e74c3c' }));
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

            // 6. Guardar Cambios en MongoDB Atlas
            User.findByIdAndUpdate(p.accountId, { coins: p.coins, inventory: p.inventory }).catch(console.error);

            console.log(`🏗️ Venta Individual: ${p.name} vendió x${requestedQty} ${catalogItem.name} por ${totalEarned} 🪙`);

            // 7. Avisar al cliente del éxito (Reusamos el paquete sell_success existente en demo.html)
            ws.send(JSON.stringify({
                type: 'sell_success',
                earned: totalEarned, // Monto de esta venta específica
                newCoins: p.coins,
                newInventory: p.inventory
            }));

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
                    client.send(JSON.stringify({
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
                    client.send(JSON.stringify({ type: 'base_update', base: centralBase }));
                }
            });
        }

    });

    /// 4. DISCONNECT
    ws.on('close', async () => {
        // ONLY save if they logged in! We don't want to save Guest coordinates to the DB
        if (isAuthenticated && players[id]) {
            try {
                await User.findOneAndUpdate(
                    { email: currentUser },
                    {
                        worldX: players[id].worldX,
                        worldY: players[id].worldY,
                        equippedWeapon: players[id].equippedWeapon,
                        hotbar: players[id].hotbar,
                        coins: players[id].coins,
                        hp: players[id].hp,
                        isDead: players[id].isDead,
                        // 👇 NUEVO: GUARDAR KILLS Y LOSSES 👇
                        kills: players[id].kills,
                        losses: players[id].losses
                    }
                );
            } catch (err) { console.error(err); }
        }

        delete players[id];
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'left', id: id }));
            }
        });
    });

    // 2. FETCH WORLD DATA
    const allTiles = await Tile.find({});

    // 3. TELL THE NEW GUEST WHO THEY ARE (INIT)
    ws.send(JSON.stringify({
        type: 'init',
        id: id,
        players: players,
        worldMap: allTiles,
        weaponsDB: WEAPONS,
        tilesetsDB: TILESETS,
        safeZones: safeZonesRAM, // <--- ¡NUEVO: Enviamos los rectángulos de paz al jugador!
        skeleton: skeletonRAM, // <--- ¡ESTA ES LA LÍNEA QUE FALTABA!
        centralBase: centralBase, // 🛑 EL FIX: Añadimos la base a la memoria del cliente
        groundItems: groundItems, // 🛑 EL FIX: Mandar la basura a los jugadores nuevos
        trashCatalog: TRASH_CATALOG,
        masterCatalog: MASTER_CATALOG // 📦 EL FIX: Enviamos toda la ropa e ítems
    }));

    // 4. NOW TELL THE LOBBY A GUEST HAS ARRIVED
    wss.clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'joined', id: id, player: players[id] }));
        }
    });

});

// Helper function to shout messages to everyone EXCEPT the person who sent it
function broadcast(data, excludeWs = null) {
    const payload = JSON.stringify(data);
    wss.clients.forEach((client) => {
        // Only send if the connection is open and it's not the original sender
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

// =========================================================
// 🗑️ SISTEMA DE BASURA (TRASH PICKER)
// =========================================================
let groundItems = {};

// Spawner de Basura (Cada 3 segundos)
setInterval(() => {
    // 🛑 EL FIX: Si el catálogo de la base de datos aún no ha cargado, cancelamos este turno
    if (TRASH_CATALOG.length === 0) return;

    const pKeys = Object.keys(players);
    // Límite de 80 basuras en el mapa para no dar lag
    if (pKeys.length > 0 && Object.keys(groundItems).length < 80) {
        const rp = players[pKeys[Math.floor(Math.random() * pKeys.length)]];
        if (rp && rp.worldX !== undefined && !isInSafeZone(rp.worldX, rp.worldY)) {
            const sx = rp.worldX + (Math.random() * 800 - 400);
            const sy = rp.worldY + (Math.random() * 800 - 400);

            if (!serverCheckCollision(sx, sy)) {
                const itemId = "trash_" + Math.random().toString(36).substr(2, 9);

                // Elegimos un tipo de basura al azar de tu catálogo oficial
                const tType = TRASH_CATALOG[Math.floor(Math.random() * TRASH_CATALOG.length)];

                groundItems[itemId] = {
                    x: sx, y: sy,
                    type: "trash",
                    templateId: tType.id,
                    sx: tType.sx, sy: tType.sy,
                    value: tType.value,
                    name: tType.name
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

            // 2. GUARDAR EL TIEMPO EN MONGODB PARA EL RANKING GLOBAL
            // (Los ingresos pasivos de monedas fueron removidos para el futuro sistema de premios exclusivos)
            await Squad.findOneAndUpdate(
                { name: ownerSquad },
                { $inc: { territoryTimeMinutes: 1 } } // Le suma 1 minuto a su récord histórico en la nube
            );

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

                const hpMsg = JSON.stringify({
                    type: 'hp_update',
                    targetId: id,
                    newHp: p.hp,
                    isDead: false,
                    damageDealt: -5 // Un número negativo le dice al cliente que es curación
                });

                // Enviar a todos los clientes para que vean que este jugador se curó
                wss.clients.forEach(client => {
                    if (client.readyState === 1) client.send(hpMsg);
                });
            }
        }
    }
}, 1000); // Revisa a todos los jugadores 1 vez por segundo

console.log(`WebSocket server running on port ${PORT}`);
