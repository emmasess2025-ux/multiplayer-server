const WebSocket = require('ws');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config(); // <--- ADD THIS LINE TO READ THE .ENV FILE

// --- DATABASE CONNECTION ---
// Now it pulls securely from your hidden environment file!
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => console.log('🔥 Connected to MongoDB!'))
    .catch(err => console.error('MongoDB Connection Error:', err));

const tileSchema = new mongoose.Schema({
    x: Number,
    y: Number,
    l: { type: Number, default: 0 }, // The Z-Index Layer (0 to 4)
    tileId: Number,
    hasCollision: { type: Boolean, default: false }
});

const Tile = mongoose.model('Tile', tileSchema);

// --- THE PLAYER BLUEPRINT (SCHEMA) ---
const userSchema = new mongoose.Schema({
        email: { type: String, required: true, unique: true }, 
        username: { type: String, required: true },            
        password: { type: String, required: true }, 
        token: { type: String, default: "" }, 
        worldX: { type: Number, default: 0 },
        worldY: { type: Number, default: 0 },
        
        inventory: { type: Array, default: ["ghost_gun"] },
        equippedWeapon: { type: String, default: "none" },
        hotbar: { type: Array, default: ["none", "none", "none"] },
        friends: { type: Array, default: [] },
        
        // --- NUEVO: SISTEMA DE ECONOMÍA ---
        coins: { type: Number, default: 0 } 
    });

const User = mongoose.model('User', userSchema);

// --- EL ESQUEMA DE LAS ARMAS ---
const weaponSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true }, // ej: "ghost_gun"
    name: String,
    damage: Number,
    speed: Number,
    fireRate: Number,
    magSize: Number,
    reloadTime: Number,
    range: Number,
    color: String
});
const Weapon = mongoose.model('Weapon', weaponSchema);

// --- CACHÉ EN RAM PARA VELOCIDAD EXTREMA ---
let WEAPONS = {
    "none": { damage: 0, speed: 0, fireRate: 0, magSize: 0, reloadTime: 0, color: "transparent" }
};

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

// Cargar armas de la Base de Datos a la RAM cuando el servidor inicia
async function loadWeaponsFromDB() {
    try {
        // Crear el arma por defecto si no existe en la DB
        const existing = await Weapon.findOne({ id: "ghost_gun" });
        if (!existing) {
            await Weapon.create({
                id: "ghost_gun", name: "Ghost Gun", damage: 15, speed: 6,
                fireRate: 250, magSize: 8, reloadTime: 1500, range: 120, color: "#2ecc71"
            });
            console.log('🔫 Ghost Gun añadida a MongoDB!');
        }

        // Cargar todas las armas a la memoria RAM
        const dbWeapons = await Weapon.find({});
        dbWeapons.forEach(w => {
            WEAPONS[w.id] = w;
        });
        console.log(`✅ Base de datos de armas cargada en RAM (${dbWeapons.length} armas)`);
    } catch (err) {
        console.error("Error cargando armas:", err);
    }
}

// Llama a la función inmediatamente
loadWeaponsFromDB();

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
        ammo: 8, // Empezamos con el cargador lleno
        lastShotTime: 0,
        isReloading: false
    };

        ws.on('message', async (message) => {
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

                // --- THE HOTBAR PERSISTENCE FIX ---
                players[id].hotbar = user.hotbar || ["none", "none", "none"];

                // --- NUEVO: CARGAR MONEDAS A LA RAM ---
                players[id].coins = user.coins || 0;

                // Agrega esta línea para guardar el ID único de MongoDB en RAM:
                players[id].accountId = user._id.toString();

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
            } catch(err) { console.error("Error cambiando nombre:", err); }
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
            } catch(err) { console.error(err); }
        }

        // 5. HANDLE WORLD BUILDING
        if (data.type === 'place_tile') {
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
            try {
                const bulkOps = [];
                for (let t of data.tiles) {
                    if (t.tileId === -1) {
                        // BORRADOR: Solo borramos el bloque específico en su capa
                        bulkOps.push({ deleteMany: { filter: { x: t.x, y: t.y, l: t.l } } });
                    } else {
                        // UPSERT: Si existe, lo sobrescribe. Si no existe, lo crea. ¡1 sola operación!
                        bulkOps.push({
                            updateOne: {
                                filter: { x: t.x, y: t.y, l: t.l },
                                update: { $set: { tileId: t.tileId } },
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
            try {
                // Use the same Smart Query to find ghost tiles
                const query = { x: data.x, y: data.y };
                if (data.layer === 0) {
                    query.$or = [{ l: 0 }, { l: { $exists: false } }, { l: null }];
                } else {
                    query.l = data.layer;
                }

                // updateMany ensures we catch duplicates, and we force 'l' to be saved!
                await Tile.updateMany(
                    query,
                    { hasCollision: data.hasCollision, l: data.layer }
                );
                
                wss.clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'tile_meta_update', 
                            x: data.x, y: data.y, 
                            layer: data.layer, hasCollision: data.hasCollision
                        }));
                    }
                });
            } catch (err) { console.error('Meta Update Error:', err); }
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
                // --- THE HOTBAR PERSISTENCE FIX ---
                players[id].hotbar = user.hotbar || ["none", "none", "none"];

                // --- NUEVO: CARGAR MONEDAS A LA RAM ---
                players[id].coins = user.coins || 0;

                // Agrega esta línea para guardar el ID único de MongoDB en RAM:
                players[id].accountId = user._id.toString();
                
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

        // 3. ALLOW GUESTS TO MOVE (Removed the isAuthenticated check!)
        if (data.type === 'update') {
            // --- EL FIX DE LA INMORTALIDAD ---
            // En lugar de sobrescribir (players[id] = data.player), fusionamos los datos!
            // Así mantenemos el HP, Ammo y lastShotTime intactos en la memoria del servidor.
            if (!players[id]) players[id] = {};
            players[id] = { ...players[id], ...data.player }; 
            
            wss.clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'update', id: id, player: players[id] }));
                }
            });
        }

       // 7. HANDLE SHOOTING (CON ANTI-CHEAT)
        if (data.type === 'shoot') {
            const shooter = players[id];
            const weaponId = shooter.equippedWeapon || "none";
            const stats = WEAPONS[weaponId];

            if (!stats || weaponId === "none") return;

            const now = Date.now();

            // ANTI-CHEAT 1: ¿Está disparando más rápido que el FireRate del arma?
            // Le damos 50ms de margen por el lag del internet
            if (now - shooter.lastShotTime < (stats.fireRate - 50)) {
                return; // ¡Hacker ignorado!
            }

            // ANTI-CHEAT 2: ¿Tiene balas?
            if (shooter.ammo <= 0) {
                // Si no tiene balas y no está recargando, iniciar recarga en el servidor
                if (!shooter.isReloading) {
                    shooter.isReloading = true;
                    setTimeout(() => {
                        if (players[id]) { // Verificar que el jugador no se haya desconectado
                            players[id].ammo = stats.magSize;
                            players[id].isReloading = false;
                        }
                    }, stats.reloadTime);
                }
                return; // No puede disparar, está vacío/recargando
            }

            // SI PASA LAS PRUEBAS: Disparo oficial
            shooter.ammo--;
            shooter.lastShotTime = now;

            // Replicar la bala a todos los demás
            wss.clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'shoot',
                        id: id,
                        x: data.x,
                        y: data.y,
                        angle: data.angle,
                        weaponId: weaponId
                    }));
                }
            });
        }

        // 8. MANEJAR EL DAÑO Y LA VIDA (CON SEGURIDAD ANTI-CHEAT Y ESTADO DE MUERTE)
        if (data.type === 'damage_player') {
            const shooter = players[id]; 
            const target = players[data.targetId]; 

            // Si el objetivo existe y NO está muerto ya
            if (shooter && target && !target.isDead) {
                const weaponId = shooter.equippedWeapon || "none";
                const actualDamage = WEAPONS[weaponId] ? WEAPONS[weaponId].damage : 0;

                target.hp = (target.hp || 100) - actualDamage;
                
                // --- ¡EL FIX DEL AUTO-HEAL! REINICIAR EL CRONÓMETRO ---
                target.lastHitTime = Date.now(); 

                // --- SISTEMA DE MUERTE (DERRIBADO) ---
                if (target.hp <= 0) {
                    target.hp = 0;
                    target.isDead = true; 

                    setTimeout(() => {
                        if (players[data.targetId]) { 
                            players[data.targetId].hp = 100;
                            players[data.targetId].isDead = false;
                            players[data.targetId].lastHitTime = Date.now(); // Reiniciar al revivir
                            
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

                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'hp_update',
                            targetId: data.targetId,
                            newHp: target.hp,
                            damageDealt: actualDamage,
                            isDead: target.isDead || false
                        }));
                    }
                });
            }
        }

        // 9. ENVIAR MENSAJE PRIVADO
        if (data.type === 'send_pm' && isAuthenticated) {
            try {
                const myAccountId = players[id].accountId;
                const targetAccountId = data.targetAccountId;

                let conv = await PM.findOne({ participants: { $all: [myAccountId, targetAccountId] } });
                if (!conv) {
                    conv = new PM({ participants: [myAccountId, targetAccountId], messages: [] });
                }

                conv.messages.push({ senderId: myAccountId, text: data.text });
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
                                senderUsername: players[id].username, // Solo para la notificación flotante
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
        // 12. PEDIR LISTA DE AMIGOS ACTUALIZADA
        if (data.type === 'get_friends_list' && isAuthenticated) {
            try {
                const myUser = await User.findOne({ email: currentUser });
                const friendsData = [];
                
                // Buscar el nombre ACTUAL de cada amigo usando su ID
                for (let fId of (myUser.friends || [])) {
                    const fUser = await User.findById(fId);
                    if (fUser) {
                        friendsData.push({ accountId: fId, username: fUser.username });
                    }
                }
                ws.send(JSON.stringify({ type: 'friends_list_data', friends: friendsData }));
            } catch (err) { console.error("Error pidiendo amigos:", err); }
        }
    });

    /// 4. DISCONNECT
    ws.on('close', async () => {
        // ONLY save if they logged in! We don't want to save Guest coordinates to the DB
        if (isAuthenticated && players[id]) {
            try {
                await User.findOneAndUpdate(
                    { email: currentUser }, // <--- FIX: Search by Email!
                    { 
                        worldX: players[id].worldX, 
                        worldY: players[id].worldY,
                        equippedWeapon: players[id].equippedWeapon,
                        hotbar: players[id].hotbar,
                        // --- NUEVO: GUARDAR MONEDAS AL DESCONECTARSE ---
                        coins: players[id].coins 
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
        weaponsDB: WEAPONS // <--- ¡Le mandamos la tabla oficial al cliente!
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
