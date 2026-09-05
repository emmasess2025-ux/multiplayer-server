const WebSocket = require('ws');
const mongoose = require('mongoose');

module.exports = function createWsHandler(deps) {
    const { 
        wss, state, encode, decode, bcrypt, Tile, Blueprint, Arena, Turf, SafeZone, Rank, ZoneConfig, Skeleton, PatchNote, Task, Season, User, Counter, Feedback, Squad, ServerConfig, Item, ArgemPackage, Tileset, PM,
        broadcast, broadcastToZone, applyDamageToPlayer, serverCheckCollision, getChunkId, getVisibleChunks, isInSafeZone,
        add_bp_xp, stripe
    } = deps;
    
    const { SQUAD_CHATS_RAM, arenasRAM, safeZonesRAM, RANKS_CACHE, ZONE_CONFIG, skeletonRAM, PATCH_NOTES_CACHE, GLOBAL_BGM_PLAYLIST, ARGEM_PACKAGES, GLOBAL_TASKS, MASTER_CATALOG, WEAPONS, TRASH_CATALOG, METALS_CATALOG, TILESETS, serverWorldMap, players, activeProjectiles, groundItems } = state;

    const TILE_SIZE = 16;
    const CHUNK_SIZE = 512;

    return async (ws, req) => {
    const clientIp = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress) : 'unknown';
    const id = Math.random().toString(36).substring(2, 9);
    ws.playerId = id;
    ws.clientIp = clientIp; // <--- Â¡AÃ‘ADE ESTA LÃNEA! Es crucial para encontrar a quiÃ©n enviarle el PM.

    let isAuthenticated = false;
    // Generate a structured temporary guest tag and username (e.g. Guest_4821 and G4821)
    const guestNum = Math.floor(1000 + Math.random() * 9000);
    let currentUser = `Guest_${guestNum}`;
    const guestGameId = `G${guestNum}`;

    // 1. INSTANTLY SPAWN THEM AS A GUEST WITH TEMPORARY GAME ID
    players[id] = {
        username: currentUser,
        gameId: guestGameId,
        role: 'guest',
        isGuest: true,
        accountId: `guest_${id}`,
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
        equipped: { head: 'H_D', body: 'body_default', hands: 'none' },
        chunkId: getChunkId(0, 0),

        // ðŸ›‘ EL FIX 1: Â¡El servidor necesita saber que los invitados SÃ tienen la Ghost Gun!
        inventory: ["ghost_gun"],
        equippedWeapon: "ghost_gun"
    };

    


    ws.on('message', async (message) => {

        // --- ðŸ›¡ï¸ ESCUDO ANTI-DDOS (RATE LIMITING) ðŸ›¡ï¸ ---
        const now = Date.now();
        if (!ws.rateLimit) ws.rateLimit = { count: 0, lastReset: now };

        // Reiniciamos el contador cada segundo (1000 milisegundos)
        if (now - ws.rateLimit.lastReset > 1000) {
            ws.rateLimit.count = 0;
            ws.rateLimit.lastReset = now;
        }

        ws.rateLimit.count++;

        // Un jugador legal envÃ­a ~20 paquetes por segundo.
        // Si manda mÃ¡s de 40, estÃ¡ usando macros o lag switch. Lo ignoramos.
        if (ws.rateLimit.count > 40) {

            // Si el ataque es masivo (ej. un script malicioso enviando 100+), le cortamos el cable.
            if (ws.rateLimit.count > 100) {
                console.warn(`[ANTI-DDOS] Desconectando atacante por spam masivo.`);
                ws.close(); // Lo pateamos del servidor instantÃ¡neamente
            }
            return; // Detenemos la ejecuciÃ³n aquÃ­. Salvamos la CPU del servidor.
        }

        // âš¡ Decode the incoming binary buffer back into a Javascript Object
        const data = decode(message);

        // 1. HANDLE REGISTRATION
        if (data.type === 'register') {
            try {
                const existingUser = await User.findOne({ email: new RegExp('^' + data.email.trim() + '$', 'i') });
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

                let initialCoins = 5000;
                let initialInventory = ['hat_founder', 'ghost_gun'];

                const newUser = new User({
                    email: data.email,
                    username: data.username, // Give them a default display name
                    password: hashedPassword,
                    gameId: newGameId,
                    coins: initialCoins,
                    inventory: initialInventory
                });
                await newUser.save();

                ws.send(encode({ type: 'register_success', message: 'Account created! You can now log in.' }));
            } catch (err) { console.error(err); ws.send(encode({ type: 'auth_error', message: 'Server error.' })); }
        }

        // 2. HANDLE LOGIN
        if (data.type === 'login') {
            try {
                const identifier = (data.email || data.username || '').toString().trim();
                if (!identifier) return ws.send(encode({ type: 'auth_error', message: 'Please enter your email or username' }));

                // Search by EMAIL or USERNAME
                const user = await User.findOne({
                    $or: [
                        { email: new RegExp('^' + identifier + '$', 'i') },
                        { username: new RegExp('^' + identifier + '$', 'i') }
                    ]
                });
                if (!user) return ws.send(encode({ type: 'auth_error', message: 'Account not found (check email/username)' }));

                const isMatch = await bcrypt.compare(data.password || '', user.password);
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
                players[id].isGuest = false;
                players[id].accountId = user._id ? user._id.toString() : id;
                players[id].worldX = user.worldX;
                players[id].worldY = user.worldY;
                
                const BanModel = require('../models/Ban');
                if (user._id) {
                    let activeBan = null;
                    if (user.role !== 'admin') {
                        activeBan = await BanModel.findOne({ $or: [{ accountId: user._id.toString() }, { ipAddress: ws.clientIp }], expiresAt: { $gt: new Date() } });
                    }
                    if (activeBan) {
                        players[id].isJailed = true;
                        if (state.jailSpawnPos) {
                            players[id].worldX = state.jailSpawnPos.x;
                            players[id].worldY = state.jailSpawnPos.y;
                        } else {
                            players[id].worldX = 0;
                            players[id].worldY = 0;
                        }
                    } else {
                        players[id].isJailed = false;
                        ws.send(encode({ type: 'unjail' }));
                    }
                } players[id].friends = user.friends;
                // --- THE FIX: Give the server memory their inventory! ---
                players[id].inventory = user.inventory;

                players[id].equippedWeapon = user.equippedWeapon || "none";
                players[id].weaponAmmo = {};
                players[id].equipped = user.equipped || { head: 'H_D', body: 'body_default', hands: 'none' };

                // --- THE HOTBAR PERSISTENCE FIX ---
                players[id].hotbar = user.hotbar || ["none", "none", "none"];
                players[id].quickSwaps = user.quickSwaps || []; // ðŸ†• Nueva lÃ­nea

                // --- NUEVO: CARGAR MONEDAS A LA RAM ---
                players[id].coins = user.coins || 0;
                players[id].gems = user.gems || 0; // Cargar Argems

                // ðŸ‘‡ NUEVO: CARGAR KILLS Y LOSSES ðŸ‘‡
                players[id].kills = user.kills || 0;
                players[id].losses = user.losses || 0;
                players[id].elo = user.elo || 1000;
                // --- NUEVO: BATTLE PASS VALIDATION ---
                if (state.ACTIVE_SEASON) {
                    if (user.bpSeasonId !== state.ACTIVE_SEASON.seasonId) {
                        user.bpSeasonId = state.ACTIVE_SEASON.seasonId;
                        user.bpXP = 0;
                        user.bpPremium = false;
                        user.bpClaimedFree = [];
                        user.bpClaimedPremium = [];
                        await user.save();
                    }
                }
                players[id].bpSeasonId = user.bpSeasonId || "";
                players[id].bpXP = user.bpXP || 0;
                players[id].bpPremium = user.bpPremium || false;
                players[id].bpClaimedFree = user.bpClaimedFree || [];
                players[id].bpClaimedPremium = user.bpClaimedPremium || [];
                // ðŸ‘‡ NUEVO: CARGAR SALUD A LA RAM ðŸ‘‡
                players[id].hp = user.hp !== undefined ? user.hp : 100;
                players[id].isDead = user.isDead || false;

                // --- ðŸŒŸ NUEVO: CARGAR TAREAS Y LOGROS A LA RAM ðŸŒŸ ---
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

                // ðŸ›‘ EL FIX: REINICIAR EL TEMPORIZADOR DE COMBATE AL ENTRAR ðŸ›‘
                // Esto evita que los que recargan la pÃ¡gina se curen mÃ¡gicamente
                players[id].lastHitTime = Date.now();

                // Agrega esta lÃ­nea para guardar el ID Ãºnico de MongoDB en RAM:
                players[id].accountId = user._id.toString();

                // --- NUEVO: PASAR EL ROL A LA MEMORIA ---
                players[id].role = user.role || 'player';

                // ðŸ‘‡ EL FIX ANTI-COMA: Si te conectas y estabas muerto, revives automÃ¡ticamente ðŸ‘‡
                if (players[id].isDead || players[id].hp <= 0) {
                    players[id].hp = 100;
                    players[id].isDead = false;
                    // Forzamos a que MongoDB tambiÃ©n se entere de que ya no estÃ¡s muerto
                    User.findByIdAndUpdate(user._id, { hp: 100, isDead: false }).catch(console.error);
                }

                // --- NUEVO: CARGAR EL TAG DEL SQUAD EN RAM ---
                if (user.squad) {
                    const mySquad = await Squad.findById(user.squad);
                    if (mySquad) {
                        players[id].squad = mySquad._id.toString();
                        players[id].squadName = mySquad.name;
                        players[id].squadLogo = mySquad.logo;

                        const isLeader = mySquad.leader && mySquad.leader.toString() === user._id.toString();
                        const myData = mySquad.members ? mySquad.members.find(m => m.accountId && m.accountId.toString() === user._id.toString()) : null;
                        players[id].isLeader = !!isLeader;
                        players[id].squadCanInvite = isLeader || (myData && myData.canInvite) || false;
                        players[id].squadCanKick = isLeader || (myData && myData.canKick) || false;
                        players[id].squadCanAssignRoles = isLeader || (myData && myData.canAssignRoles) || false;
                        players[id].squadTitle = isLeader ? 'ðŸ‘‘ LÃ­der' : (myData && myData.customTitle ? myData.customTitle : 'Miembro');
                        players[id].squadRole = isLeader ? 'leader' : 'member';
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
                    hasSeenTutorial: user.hasSeenTutorial,
                    activeSeason: state.ACTIVE_SEASON
                }));
                console.log(`[LOGIN_SUCCESS] Sending claimedTasks for ${user.email}:`, players[id].claimedTasks);

                // Move the closing bracket so 'ws' is the second argument!
                broadcast({ type: 'update', id: id, player: players[id] }, ws);

                // --- NUEVO: TRIGGER TUTORIAL IF NEEDED ---
                // --- NUEVO: TRIGGER TUTORIAL IF NEEDED ---
                if (!user.hasSeenTutorial) {
                    ws.send(encode({ type: 'trigger_tutorial' }));
                }
                
                isAuthenticated = true;
                currentUser = user.email;
            } catch (err) { console.error("AUTO LOGIN CRASH", err); ws.send(encode({ type: 'auth_error', message: 'Server crashed during login.' })); }
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
            } catch (err) { console.error("AUTO LOGIN CRASH", err); ws.send(encode({ type: 'auth_error', message: 'Server crashed during login.' })); }
        }


            
        
        // --- NUEVO: WEBRTC MUTE STATUS ---
        if (data.type === 'voice_mute_status') {
            console.log("SERVER RECV MUTE from:", id, "muted:", data.isMuted);
            if (!players[id] || !players[id].squad) return;
            players[id].isVoiceMuted = !!data.isMuted; // SAVE STATE
            const mySquadId = players[id].squad.toString();
            wss.clients.forEach(c => {
                if (c.readyState === WebSocket.OPEN && c.playerId !== id && players[c.playerId] && players[c.playerId].squad && players[c.playerId].squad.toString() === mySquadId) {
                    c.send(encode({
                        type: 'voice_mute_status',
                        userId: id,
                        isMuted: !!data.isMuted
                    }));
                }
            });
        }


        // --- NUEVO: WEBRTC SIGNALING PARA RADIO DEL CLAN ---
        if (data.type === 'webrtc_signal') {
            console.log("WEBRTC SIGNAL RECV from:", id, "target:", data.targetId, "type:", data.signalData.type);
            if (!players[id] || !players[id].squad) {
                console.log("WEBRTC SIGNAL DROPPED: No squad for", id);
                return;
            }
            const mySquadId = players[id].squad.toString();
            
            for (let pid in players) {
                if (pid !== id && players[pid].squad && players[pid].squad.toString() === mySquadId) {
                    if (!data.targetId || data.targetId === pid) {
                        console.log("WEBRTC SIGNAL FORWARDING to:", pid);
                        wss.clients.forEach(c => {
                            if (c.playerId === pid && c.readyState === WebSocket.OPEN) {
                                c.send(encode({
                                    type: 'webrtc_signal',
                                    senderId: id,
                                    senderName: players[id].username,
                                    senderHead: players[id].equipped ? players[id].equipped.head : "H_D",
                                    signalData: data.signalData
                                }));
                            }
                        });
                    }
                }
            }
        }
        
        if (data.type === 'request_voice_lobby_state') {
            console.log("SERVER RECV: request_voice_lobby_state from:", id);
            if (!players[id] || !players[id].squad) return;
            const mySquadId = players[id].squad.toString();
            let activeMembers = [];
            for (let pid in players) {
                if (players[pid].squad && players[pid].squad.toString() === mySquadId && players[pid].inVoiceLobby) {
                    activeMembers.push({
                        userId: pid,
                        username: players[pid].username,
                        head: players[pid].equipped ? players[pid].equipped.head : "H_D",
                        isMuted: players[pid].isVoiceMuted || false
                    });
                }
            }
            if (ws.readyState === 1) {
                ws.send(encode({ type: 'voice_lobby_state_response', members: activeMembers }));
            }
        }

        if ((data.type === 'join_voice_lobby' || data.type === 'leave_voice_lobby')) {
            console.log("VOICE LOBBY EVENT:", data.type, "from:", id);
            if (!players[id] || !players[id].squad) {
                console.log("VOICE LOBBY DROPPED: No squad for", id);
                return;
            }
            players[id].inVoiceLobby = (data.type === 'join_voice_lobby');
            if (data.type === 'join_voice_lobby') players[id].isVoiceMuted = !!data.isMuted;
            const mySquadId = players[id].squad.toString();
            
            for (let pid in players) {
                if (players[pid].squad && players[pid].squad.toString() === mySquadId) {
                    console.log("VOICE LOBBY BROADCASTING to:", pid);
                    wss.clients.forEach(c => {
                        if (c.playerId === pid && c.readyState === WebSocket.OPEN) {
                            c.send(encode({
                                type: data.type,
                                userId: id,
                                username: players[id].username,
                                head: players[id].equipped ? players[id].equipped.head : "H_D"
                            }));
                        }
                    });
                }
            }
        }

        if (data.type === 'admin_invisible') {
                if (players[id]) players[id].invisibleEnabled = !!data.enabled;
                if (data.enabled) {
                    broadcast({ type: 'left', id: id });
                } else if (players[id]) {
                    broadcast({ type: 'update', id: id, player: players[id] });
                }
                ws.send(encode({ type: 'system_message', text: `Invisible mode: ${data.enabled ? 'ON' : 'OFF'}`, color: '#38ef7d' }));
                return;
            }

            if (data.type === 'admin_noclip') {
                if (players[id]) players[id].noclipEnabled = !!data.enabled;
                ws.send(encode({ type: 'system_message', text: `Noclip mode: ${data.enabled ? 'ON' : 'OFF'}`, color: '#38ef7d' }));
                return;
            }

        // --- NUEVO: ADMIN TOOLS ---
        if (['admin_teleport', 'admin_summon', 'admin_kick', 'admin_respawn', 'admin_invisible', 'admin_noclip', 'admin_get_online_players', 'admin_freeze', 'admin_jail'].includes(data.type) && isAuthenticated) {
            const myPlayer = players[id];
            if (!myPlayer || (myPlayer.role || '').toLowerCase() !== 'admin') {
                ws.send(encode({ type: 'system_message', text: 'You do not have permission to use admin tools.', isAlert: true }));
                return;
            }

            // 1. NON-TARGET ADMIN COMMANDS

            if (data.type === 'admin_get_online_players') {
                const onlineList = [];
                const seenIds = new Set();

                // Check all active clients
                for (const client of wss.clients) {
                    if (client && client.readyState === WebSocket.OPEN && client.playerId && players[client.playerId]) {
                        const pid = client.playerId;
                        seenIds.add(pid);
                        const p = players[pid];
                        if (!p) continue;
                        const isGuestPlayer = !!p.isGuest || (p.role === 'guest') || (p.username && p.username.startsWith('Guest_'));
                        onlineList.push({
                            id: pid,
                            gameId: p.gameId || (isGuestPlayer ? ('G' + String(pid).slice(0, 4).toUpperCase()) : ('P' + String(pid).slice(0, 5))),
                            accountId: p.accountId || (isGuestPlayer ? ('guest_' + pid) : (p._id || pid)),
                            username: p.username || p.name || (isGuestPlayer ? 'Guest' : 'Anonymous'),
                            role: p.role || (isGuestPlayer ? 'guest' : 'player'),
                            isGuest: isGuestPlayer,
                            equipped: p.equipped || { head: 'H_D', body: 'body_default', hands: 'none' },
                            hp: (typeof p.hp === 'number') ? p.hp : 100,
                            maxHp: p.maxHp || 100,
                            worldX: Math.round(p.worldX || 0),
                            worldY: Math.round(p.worldY || 0),
                            isDead: !!p.isDead, isFrozen: !!p.isFrozen, isJailed: !!p.isJailed
                        });
                    }
                }

                // Also check players map in case any socket was missed
                for (const pid in players) {
                    if (!seenIds.has(pid) && players[pid]) {
                        const p = players[pid];
                        if (!p) continue;
                        const isGuestPlayer = !!p.isGuest || (p.role === 'guest') || (p.username && p.username.startsWith('Guest_'));
                        onlineList.push({
                            id: pid,
                            gameId: p.gameId || (isGuestPlayer ? ('G' + String(pid).slice(0, 4).toUpperCase()) : ('P' + String(pid).slice(0, 5))),
                            accountId: p.accountId || (isGuestPlayer ? ('guest_' + pid) : (p._id || pid)),
                            username: p.username || p.name || (isGuestPlayer ? 'Guest' : 'Anonymous'),
                            role: p.role || (isGuestPlayer ? 'guest' : 'player'),
                            isGuest: isGuestPlayer,
                            equipped: p.equipped || { head: 'H_D', body: 'body_default', hands: 'none' },
                            hp: (typeof p.hp === 'number') ? p.hp : 100,
                            maxHp: p.maxHp || 100,
                            worldX: Math.round(p.worldX || 0),
                            worldY: Math.round(p.worldY || 0),
                            isDead: !!p.isDead
                        });
                    }
                }

                ws.send(encode({ type: 'admin_online_players_list', players: onlineList }));
                return;
            }

            // 2. TARGET-BASED ADMIN COMMANDS (Supports both Registered Users & Temporary Guests)
            let targetWs = null;
            let targetId = null;
            const searchTarget = (data.targetGameId || '').trim().toUpperCase();

            if (searchTarget) {
                // Pass 1: Search connected client sockets
                for (const client of wss.clients) {
                    if (client && client.readyState === WebSocket.OPEN && client.playerId && players[client.playerId]) {
                        const pid = client.playerId;
                        const p = players[pid];
                        if (p && (
                            (p.gameId && String(p.gameId).toUpperCase() === searchTarget) ||
                            (p.username && String(p.username).toUpperCase() === searchTarget) ||
                            (p.accountId && String(p.accountId).toUpperCase() === searchTarget) ||
                            (pid && String(pid).toUpperCase() === searchTarget)
                        )) {
                            targetWs = client;
                            targetId = pid;
                            break;
                        }
                    }
                }
                // Pass 2: Search players map directly if socket wasn't indexed yet
                if (!targetId) {
                    for (const pid in players) {
                        const p = players[pid];
                        if (p && (
                            (p.gameId && String(p.gameId).toUpperCase() === searchTarget) ||
                            (p.username && String(p.username).toUpperCase() === searchTarget) ||
                            (p.accountId && String(p.accountId).toUpperCase() === searchTarget) ||
                            (pid && String(pid).toUpperCase() === searchTarget)
                        )) {
                            targetId = pid;
                            for (const client of wss.clients) {
                                if (client && client.readyState === WebSocket.OPEN && client.playerId === pid) {
                                    targetWs = client;
                                    break;
                                }
                            }
                            break;
                        }
                    }
                }
            }

            if (!targetWs || !targetId || !players[targetId]) {
                if (data.type === 'admin_teleport' && data.targetGameId) {
                    try {
                        const offlineUser = await User.findOne({ gameId: data.targetGameId });
                        if (!offlineUser) {
                            ws.send(encode({ type: 'system_message', text: `Player ${data.targetGameId} does not exist in database.`, isAlert: true }));
                            return;
                        }
                        if (players[id]) {
                            players[id].worldX = offlineUser.worldX || 0;
                            players[id].worldY = offlineUser.worldY || 0;
                            ws.send(encode({ type: 'force_position', x: players[id].worldX, y: players[id].worldY, reason: 'teleport' }));
                            broadcast({ type: 'update', id: id, player: players[id] }, ws);
                            ws.send(encode({ type: 'system_message', text: `Teleported to offline player ${data.targetGameId}.` }));
                        }
                        return;
                    } catch (e) {
                        console.error("Offline teleport error", e);
                        ws.send(encode({ type: 'system_message', text: 'Database error looking up player.', isAlert: true }));
                        return;
                    }
                } else {
                    const onlineIds = Array.from(wss.clients).map(c => {
                        let p = (c && c.playerId) ? players[c.playerId] : null;
                        if (!p) return 'Null';
                        return `${p.username || p.email || 'Guest'}[${p.gameId || 'None'}]`;
                    }).join(', ');
                    ws.send(encode({ type: 'system_message', text: `Player ${data.targetGameId || 'unknown'} not found. Online: ${onlineIds}`, isAlert: true }));
                    return;
                }
            }

            const targetPlayer = players[targetId];
            const targetLabel = targetPlayer ? `${targetPlayer.username || data.targetGameId} [${targetPlayer.gameId || targetId}]` : (data.targetGameId || targetId);

            if (data.type === 'admin_teleport') {
                if (players[id] && targetPlayer) {
                    players[id].worldX = targetPlayer.worldX;
                    players[id].worldY = targetPlayer.worldY;
                    ws.send(encode({ type: 'force_position', x: players[id].worldX, y: players[id].worldY, reason: 'teleport' }));
                    broadcast({ type: 'update', id: id, player: players[id] }, ws);
                    ws.send(encode({ type: 'system_message', text: `Teleported to ${targetLabel}.`, color: '#38ef7d' }));
                }
            }
            else if (data.type === 'admin_summon') {
                if (players[id] && targetPlayer && targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetPlayer.worldX = players[id].worldX;
                    targetPlayer.worldY = players[id].worldY;
                    targetWs.send(encode({ type: 'force_position', x: players[id].worldX, y: players[id].worldY, reason: 'teleport' }));
                    broadcast({ type: 'update', id: targetId, player: targetPlayer }, targetWs);
                    ws.send(encode({ type: 'system_message', text: `Summoned ${targetLabel} to your location.`, color: '#38ef7d' }));
                }
            }
            else if (data.type === 'admin_kick') {
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(encode({ type: 'auth_error', message: 'You have been kicked by an administrator.' }));
                    targetWs.close();
                }
                ws.send(encode({ type: 'system_message', text: `Kicked ${targetLabel}.`, color: '#e74c3c' }));
            }
            else if (data.type === 'admin_respawn') {
                if (targetPlayer && targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetPlayer.worldX = 0;
                    targetPlayer.worldY = 0;
                    targetWs.send(encode({ type: 'force_position', x: 0, y: 0, reason: 'teleport' }));
                    broadcast({ type: 'update', id: targetId, player: targetPlayer }, targetWs);
                    ws.send(encode({ type: 'system_message', text: `Sent ${targetLabel} to spawn.`, color: '#f39c12' }));
                }
            }
            else if (data.type === 'admin_freeze') {
                if (targetPlayer) {
                    targetPlayer.isFrozen = !targetPlayer.isFrozen;
                    ws.send(encode({ type: 'system_message', text: targetPlayer.isFrozen ? 'Congelaste a ' + targetLabel : 'Descongelaste a ' + targetLabel, color: '#3498db' }));
                }
            }
            else if (data.type === 'admin_jail') {
                if (targetPlayer && targetWs && targetWs.readyState === WebSocket.OPEN) {
                    const Ban = require('../models/Ban');
                    const expiresAt = new Date(Date.now() + (data.duration * 60000));
                    
                    const banRecord = new Ban({
                        accountId: targetPlayer.accountId,
                        ipAddress: targetWs.clientIp,
                        adminId: players[id].accountId,
                        reasonType: data.reason,
                        description: data.desc,
                        durationMinutes: data.duration,
                        expiresAt: expiresAt
                    });
                    
                    banRecord.save().then(() => {
                        targetPlayer.isJailed = true;
                        
                        let destX = 0, destY = 0;
                        if (state.jailSpawnPos) {
                            destX = state.jailSpawnPos.x;
                            destY = state.jailSpawnPos.y;
                        }
                        
                        targetPlayer.worldX = destX;
                        targetPlayer.worldY = destY;
                        targetWs.send(encode({ type: 'force_position', x: destX, y: destY, reason: 'teleport' }));
                        broadcast({ type: 'update', id: targetId, player: targetPlayer }, targetWs);
                        targetWs.send(encode({ type: 'system_message', text: 'Has sido enjaulado por ' + data.duration + ' minutos (' + data.reason + ').', color: '#e74c3c', isAlert: true, isJailAlert: true }));
                        
                        ws.send(encode({ type: 'system_message', text: 'Enjaulaste a ' + targetLabel + ' exitosamente.', color: '#9b59b6' }));
                    }).catch(err => {
                        console.error(err);
                        ws.send(encode({ type: 'system_message', text: 'Error guardando condena.', color: '#e74c3c' }));
                    });
                } else if (data.targetGameId) {
                    // Try offline jail
                    const Ban = require('../models/Ban');
                    const User = require('../models/User');
                    User.findOne({ gameId: data.targetGameId }).then(offlineUser => {
                        if (offlineUser) {
                            const expiresAt = new Date(Date.now() + (data.duration * 60000));
                            const banRecord = new Ban({
                                accountId: offlineUser._id.toString(),
                                adminId: players[id].accountId,
                                reasonType: data.reason,
                                description: data.desc,
                                durationMinutes: data.duration,
                                expiresAt: expiresAt
                            });
                            banRecord.save().then(() => {
                                ws.send(encode({ type: 'system_message', text: 'Enjaulaste a ' + data.targetGameId + ' (Offline) exitosamente.', color: '#9b59b6' }));
                            });
                        } else {
                            ws.send(encode({ type: 'system_message', text: 'Jugador no encontrado.', color: '#e74c3c' }));
                        }
                    });
                }
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
                console.log(`ðŸ§¹ ADMIN NUKE: Cleared ${count} arenas.`);
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

        // --- ADMIN VOICE CHAT (MEGAPHONE) ---
        if ((data.type === 'admin_voice_chunk' || data.type === 'admin_voice_status') && isAuthenticated) {
            if ((players[id].role || '').toLowerCase() !== 'admin') return;

            let packet;
            if (data.type === 'admin_voice_status') {
                packet = encode({ type: 'admin_voice_status', isSpeaking: data.isSpeaking, playerId: id });
            } else if (data.type === 'admin_voice_chunk' && data.audio) {
                // data.audio is a Uint8Array, MessagePack handles it natively
                packet = encode({ type: 'admin_voice_chunk', audio: data.audio, adminX: players[id].worldX, adminY: players[id].worldY });
            }

            if (packet) {
                wss.clients.forEach(client => {
                    // Send to everyone except the admin who is speaking
                    if (client.readyState === WebSocket.OPEN && client.playerId !== id) {
                        client.send(packet);
                    }
                });
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

        // 4. AÃ‘ADIR AMIGOS (POR ID)
        if (data.type === 'add_friend' && isAuthenticated) {
            try {
                // 1. Lo aÃ±adimos a tu base de datos usando su AccountID
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
            } catch (err) { console.error("AUTO LOGIN CRASH", err); ws.send(encode({ type: 'auth_error', message: 'Server crashed during login.' })); }
        }

        // 5. HANDLE WORLD BUILDING
        if (data.type === 'place_tile') {
            if (!players[id] || players[id].role !== 'admin') return;

            try {
                const targetL = data.l || 0;
                const key = `${data.x},${data.y},${targetL}`;

                if (data.tileId === -1) {
                    await Tile.deleteOne({ x: data.x, y: data.y, l: targetL });
                    delete serverWorldMap[key];

                    const targetTurfId = `base_${data.x}_${data.y}`;
                    if (state.turfBases && state.turfBases[targetTurfId] && targetL === 15) {
                        await Turf.deleteOne({ turfId: targetTurfId });
                        delete state.turfBases[targetTurfId];
                        state.centralBase = Object.values(state.turfBases)[0] || null;
                        wss.clients.forEach(c => {
                            if (c.readyState === WebSocket.OPEN) c.send(encode({ type: 'base_delete', turfId: targetTurfId, turfBases: state.turfBases, base: state.centralBase }));
                        });
                    }
                } else {
                    const tileDoc = {
                        tileId: data.tileId,
                        l: targetL,
                        rotation: data.rotation || 0,
                        hasCollision: !!data.hasCollision,
                        isSit: !!data.isSit,
                        shelfX: data.shelfX || 0,
                        shelfY: data.shelfY || 0
                    };
                    if (data.triggerType !== undefined) tileDoc.triggerType = data.triggerType;
                    if (data.destX !== undefined) tileDoc.destX = data.destX;
                    if (data.destY !== undefined) tileDoc.destY = data.destY;
                    if (data.itemId !== undefined) tileDoc.itemId = data.itemId;
                    if (data.requiresClick !== undefined) tileDoc.requiresClick = data.requiresClick;
                    if (data.npcMessage !== undefined) tileDoc.npcMessage = data.npcMessage;
                    if (data.itemRow !== undefined) tileDoc.itemRow = data.itemRow;

                    await Tile.updateOne(
                        { x: data.x, y: data.y, l: targetL },
                        { $set: tileDoc },
                        { upsert: true }
                    );

                    if (!serverWorldMap[key]) serverWorldMap[key] = { l: targetL };
                    Object.assign(serverWorldMap[key], tileDoc);
                }

                // RAM WORLD_TILES_CACHE UPDATE
                if (state.WORLD_TILES_CACHE) {
                    const idx = state.WORLD_TILES_CACHE.findIndex(t => t.x === data.x && t.y === data.y && (t.l || 0) === targetL);
                    if (data.tileId === -1) {
                        if (idx !== -1) state.WORLD_TILES_CACHE.splice(idx, 1);
                    } else {
                        const cachedObj = {
                            x: data.x, y: data.y, l: targetL,
                            tileId: data.tileId,
                            rotation: data.rotation || 0,
                            hasCollision: !!data.hasCollision,
                            isSit: !!data.isSit,
                            shelfX: data.shelfX || 0,
                            shelfY: data.shelfY || 0
                        };
                        if (data.triggerType !== undefined) cachedObj.triggerType = data.triggerType;
                        if (data.destX !== undefined) cachedObj.destX = data.destX;
                        if (data.destY !== undefined) cachedObj.destY = data.destY;
                        if (data.itemId !== undefined) cachedObj.itemId = data.itemId;
                        if (data.requiresClick !== undefined) cachedObj.requiresClick = data.requiresClick;
                        if (data.npcMessage !== undefined) cachedObj.npcMessage = data.npcMessage;
                        if (data.itemRow !== undefined) cachedObj.itemRow = data.itemRow;

                        if (idx !== -1) {
                            Object.assign(state.WORLD_TILES_CACHE[idx], cachedObj);
                        } else {
                            state.WORLD_TILES_CACHE.push(cachedObj);
                        }
                    }
                }

                wss.clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(encode({
                            type: 'tile_update',
                            x: data.x, y: data.y, l: targetL,
                            tileId: data.tileId,
                            rotation: data.rotation || 0,
                            hasCollision: !!data.hasCollision,
                            isSit: !!data.isSit,
                            shelfX: data.shelfX || 0,
                            shelfY: data.shelfY || 0,
                            triggerType: data.triggerType,
                            destX: data.destX,
                            destY: data.destY,
                            itemId: data.itemId,
                            requiresClick: data.requiresClick,
                            npcMessage: data.npcMessage,
                            itemRow: data.itemRow
                        }));
                    }
                });
            } catch (err) { console.error('Tile Save Error:', err); }
        }

        // 5.5 HANDLE BULK BUILDING (SÃšPER GUARDADO MULTI-CAPA ANTI-LAG)
        if (data.type === 'save_blueprint') {
            if (!players[id] || players[id].role !== 'admin') return;
            const bp = new Blueprint(data.blueprint);
            bp.save().then(() => {
                ws.send(encode({ type: 'server_msg', msg: 'Prefab guardado con Ã©xito: ' + data.blueprint.name, color: '#2ecc71' }));
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
            if (!players[id] || players[id].role !== 'admin') return;

            try {
                const bulkOps = [];
                for (let t of data.tiles) {
                    const targetL = t.l || 0;
                    const key = `${t.x},${t.y},${targetL}`;

                    if (t.tileId === -1) {
                        bulkOps.push({ deleteMany: { filter: { x: t.x, y: t.y, l: targetL } } });
                        delete serverWorldMap[key];

                        const targetTurfId = `base_${t.x}_${t.y}`;
                        if (state.turfBases && state.turfBases[targetTurfId] && targetL === 15) {
                            await Turf.deleteOne({ turfId: targetTurfId });
                            delete state.turfBases[targetTurfId];
                            state.centralBase = Object.values(state.turfBases)[0] || null;
                            wss.clients.forEach(c => {
                                if (c.readyState === WebSocket.OPEN) c.send(encode({ type: 'base_delete', turfId: targetTurfId, turfBases: state.turfBases, base: state.centralBase }));
                            });
                        }
                    } else {
                        let updateObj = {
                            tileId: t.tileId,
                            l: targetL,
                            rotation: t.rotation || 0
                        };
                        if (t.hasCollision !== undefined) updateObj.hasCollision = !!t.hasCollision;
                        if (t.isSit !== undefined) updateObj.isSit = !!t.isSit;
                        if (t.triggerType !== undefined) updateObj.triggerType = t.triggerType;
                        if (t.destX !== undefined) updateObj.destX = t.destX;
                        if (t.destY !== undefined) updateObj.destY = t.destY;
                        if (t.itemId !== undefined) updateObj.itemId = t.itemId;
                        if (t.requiresClick !== undefined) updateObj.requiresClick = t.requiresClick;
                        if (t.npcMessage !== undefined) updateObj.npcMessage = t.npcMessage;
                        if (t.itemRow !== undefined) updateObj.itemRow = t.itemRow;
                        if (t.shelfX !== undefined) updateObj.shelfX = t.shelfX;
                        if (t.shelfY !== undefined) updateObj.shelfY = t.shelfY;

                        if (!serverWorldMap[key]) serverWorldMap[key] = { l: targetL };
                        Object.assign(serverWorldMap[key], updateObj);

                        bulkOps.push({
                            updateOne: {
                                filter: { x: t.x, y: t.y, l: targetL },
                                update: { $set: updateObj },
                                upsert: true
                            }
                        });
                    }
                }

                if (bulkOps.length > 0) {
                    await Tile.bulkWrite(bulkOps, { ordered: false });
                }

                // RAM WORLD_TILES_CACHE BULK UPDATE (Full fields preservation)
                if (state.WORLD_TILES_CACHE && data.tiles) {
                    data.tiles.forEach(t => {
                        const targetL = t.l || 0;
                        const idx = state.WORLD_TILES_CACHE.findIndex(ct => ct.x === t.x && ct.y === t.y && (ct.l || 0) === targetL);
                        if (t.tileId === -1) {
                            if (idx !== -1) state.WORLD_TILES_CACHE.splice(idx, 1);
                        } else {
                            const cachedObj = {
                                x: t.x, y: t.y, l: targetL,
                                tileId: t.tileId,
                                rotation: t.rotation || 0,
                                hasCollision: !!t.hasCollision,
                                isSit: !!t.isSit,
                                shelfX: t.shelfX || 0,
                                shelfY: t.shelfY || 0
                            };
                            if (t.triggerType !== undefined) cachedObj.triggerType = t.triggerType;
                            if (t.destX !== undefined) cachedObj.destX = t.destX;
                            if (t.destY !== undefined) cachedObj.destY = t.destY;
                            if (t.itemId !== undefined) cachedObj.itemId = t.itemId;
                            if (t.requiresClick !== undefined) cachedObj.requiresClick = t.requiresClick;
                            if (t.npcMessage !== undefined) cachedObj.npcMessage = t.npcMessage;
                            if (t.itemRow !== undefined) cachedObj.itemRow = t.itemRow;

                            if (idx !== -1) {
                                Object.assign(state.WORLD_TILES_CACHE[idx], cachedObj);
                            } else {
                                state.WORLD_TILES_CACHE.push(cachedObj);
                            }
                        }
                    });
                }

                wss.clients.forEach(client => {
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
                    updateData.itemRow = data.itemRow || 0; // <--- AÃ‘ADE ESTO PARA MONGODB
                    updateData.shelfX = data.shelfX || 0; // <--- MONGODB
                    updateData.shelfY = data.shelfY || 0;
                    // Guardar tambiÃ©n en RAM
                    serverWorldMap[key].triggerType = data.triggerType;
                    serverWorldMap[key].destX = data.destX;
                    serverWorldMap[key].destY = data.destY;
                    serverWorldMap[key].requiresClick = data.requiresClick;
                    serverWorldMap[key].npcMessage = data.npcMessage;
                    serverWorldMap[key].itemRow = data.itemRow || 0; // <--- AÃ‘ADE ESTO
                    serverWorldMap[key].shelfX = data.shelfX || 0;
                    serverWorldMap[key].shelfY = data.shelfY || 0;
                }

                await Tile.updateMany(query, updateData);

                // RAM WORLD_TILES_CACHE METADATA UPDATE
                if (state.WORLD_TILES_CACHE) {
                    const ct = state.WORLD_TILES_CACHE.find(t => t.x === data.x && t.y === data.y && (t.l || 0) === (data.layer || 0));
                    if (ct) {
                        Object.assign(ct, updateData);
                    }
                }

                // ðŸ›‘ EL FIX: CREAR O ACTUALIZAR LA BASE EN VIVO CON SUS DATOS REALES ðŸ›‘
                if (data.triggerType === 'base') {
                    const uniqueTurfId = `base_${data.x}_${data.y}`;
                    const turfUpdateObj = {
                        name: data.turfName || "Base Central",
                        maxHp: data.turfHp || 5000,
                        spriteOffsetX: data.turfOffsetX || 0,
                        spriteOffsetY: data.turfOffsetY || 0,
                        hitboxOffsetX: data.turfHitX || 0,
                        hitboxOffsetY: data.turfHitY || 0,
                        hitboxW: data.turfHitW || 32,
                        hitboxH: data.turfHitH || 32
                    };

                    if (data.turfSrcIdle !== undefined && data.turfSrcIdle !== "") turfUpdateObj.srcIdle = data.turfSrcIdle;
                    if (data.turfSrcHit !== undefined && data.turfSrcHit !== "") turfUpdateObj.srcHit = data.turfSrcHit;
                    if (data.turfFrameW !== undefined) turfUpdateObj.frameWidth = data.turfFrameW;
                    if (data.turfFrameH !== undefined) turfUpdateObj.frameHeight = data.turfFrameH;
                    if (data.turfFrames !== undefined) turfUpdateObj.frameCount = data.turfFrames;
                    if (data.turfAnimSpeed !== undefined) turfUpdateObj.animSpeed = data.turfAnimSpeed;
                    if (data.turfScale !== undefined) turfUpdateObj.renderScale = data.turfScale;
                    if (data.turfIsHover !== undefined) turfUpdateObj.isHover = Boolean(data.turfIsHover);

                    const dbTurf = await Turf.findOneAndUpdate(
                        { turfId: uniqueTurfId },
                        { $set: turfUpdateObj },
                        { upsert: true, returnDocument: 'after' }
                    );

                    if (!state.turfBases) state.turfBases = {};
                    const prevBase = state.turfBases[uniqueTurfId];

                    state.turfBases[uniqueTurfId] = {
                        turfId: uniqueTurfId,
                        gridX: data.x, gridY: data.y,
                        worldX: (data.x * 16) + 8, worldY: (data.y * 16) + 8,
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
                        lastHitTime: prevBase ? prevBase.lastHitTime : 0,
                        damageTracker: prevBase ? prevBase.damageTracker : {}
                    };
                    state.centralBase = state.turfBases[uniqueTurfId];

                    console.log(`ðŸ° Base Guardada/Actualizada en vivo: ${dbTurf.name} (${uniqueTurfId})`);

                    wss.clients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) {
                            c.send(encode({ type: 'base_update', base: state.turfBases[uniqueTurfId], turfBases: state.turfBases }));
                        }
                    });
                } // ðŸ¥Š NUEVO: CREAR O ACTUALIZAR ARENA DE SPARRING
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

                    // Mantener el estado en vivo (Si ya habÃ­a gente en cola, no borrarlos)
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

                    arenasRAM[uniqueArenaId].doorX = data.x; // Donde estÃ¡ el letrero para salir
                    arenasRAM[uniqueArenaId].doorY = data.y;

                    console.log(`ðŸŽ® Minigame Guardado en vivo: ${dbArena.name} (${dbArena.gameType})`);
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
                            console.log(`ðŸ—‘ï¸ Minigame eliminado mediante el Inspector: ${uniqueArenaId}`);
                        }
                    }

                    // Si cambias el bloque a "Normal" estando en la Capa 15, DESTRUIMOS LA BASE
                    const targetTurfId = `base_${data.x}_${data.y}`;
                    if (state.turfBases && state.turfBases[targetTurfId] && data.layer === 15) {
                        await Turf.deleteOne({ turfId: targetTurfId });
                        delete state.turfBases[targetTurfId];
                        state.centralBase = Object.values(state.turfBases)[0] || null;
                        wss.clients.forEach(c => {
                            if (c.readyState === WebSocket.OPEN) c.send(encode({ type: 'base_delete', turfId: targetTurfId, turfBases: state.turfBases, base: state.centralBase }));
                        });
                        console.log(`ðŸ—‘ï¸ Base ${targetTurfId} eliminada mediante el Inspector.`);
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
                            itemRow: data.itemRow || 0, // <--- AÃ‘ADE ESTE ENVÃO AL CLIENTE
                            shelfX: data.shelfX || 0, // <--- AL CLIENTE
                            shelfY: data.shelfY || 0
                        }));
                    }
                });
            } catch (err) { console.error('Meta Update Error:', err); }
        }// --- ðŸ¥Š SISTEMA DE SPARRING (MULTIARENAS) ---
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
                // Guardar dÃ³nde estaba para devolverlo despuÃ©s de pelear
                players[id].preSparX = players[id].worldX;
                players[id].preSparY = players[id].worldY;
                players[id].currentArena = data.arenaId; // Marcamos en quÃ© arena se metiÃ³

                // Actualizar a todos los que estÃ©n viendo el letrero
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
        }// ðŸ›‘ NUEVO: GUARDAR ATUENDO DEL GUARDARROPA (WARDROBE)
        if (data.type === 'update_wardrobe' && isAuthenticated) {
            try {
                const p = players[id];
                if (!p) return;

                const ownsHead = data.head === 'H_D' || (p.inventory && p.inventory.some(i => (typeof i === 'object' ? i.id : i) === data.head));
                const ownsBody = data.body === 'body_default' || (p.inventory && p.inventory.some(i => (typeof i === 'object' ? i.id : i) === data.body));
                const ownsHat = data.hat === 'none' || (p.inventory && p.inventory.some(i => (typeof i === 'object' ? i.id : i) === data.hat));

                if (ownsHead && ownsBody && ownsHat) {
                    if (!p.equipped) p.equipped = { head: 'H_D', body: 'body_default', hands: 'none', hat: 'none' };
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
                    // ðŸ´ TURF: guardar el punto de spawn si lo manda el cliente
                    spawnX: (data.spawnX != null) ? Number(data.spawnX) : null,
                    spawnY: (data.spawnY != null) ? Number(data.spawnY) : null
                });
                await newZone.save();

                // ðŸ›‘ EL FIX: Convertir el Documento de Mongoose a Objeto Plano y limpiar el ID
                const plainZone = newZone.toObject();
                plainZone._id = plainZone._id.toString();

                // Guardarlo en la RAM
                safeZonesRAM.push(plainZone);

                // Enviarlo a los clientes (Ahora MessagePack lo empaquetarÃ¡ sin problemas)
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
                // 1. Borrar de MongoDB usando su ID Ãºnico
                await SafeZone.findByIdAndDelete(data.id);

                // 2. Borrar de la memoria RAM del servidor
                safeZonesRAM = safeZonesRAM.filter(z => z._id.toString() !== data.id);

                // 3. Avisarle a todos los jugadores que esa zona ya no existe
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(encode({ type: 'safezone_deleted', id: data.id }));
                    }
                });
                console.log(`ðŸ›¡ï¸ Zona Segura eliminada: ${data.id}`);
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
                players[id].isGuest = false;
                players[id].accountId = user._id ? user._id.toString() : id;
                players[id].worldX = user.worldX;
                players[id].worldY = user.worldY;
                
                players[id].friends = user.friends; // Don't forget the friends list!
                const BanModel2 = require('../models/Ban');
                if (user._id) {
                    let activeBan = null;
                    if (user.role !== 'admin') {
                        activeBan = await BanModel2.findOne({ $or: [{ accountId: user._id.toString() }, { ipAddress: ws.clientIp }], expiresAt: { $gt: new Date() } });
                    }
                    if (activeBan) {
                        players[id].isJailed = true;
                        if (state.jailSpawnPos) {
                            players[id].worldX = state.jailSpawnPos.x;
                            players[id].worldY = state.jailSpawnPos.y;
                        } else {
                            players[id].worldX = 0;
                            players[id].worldY = 0;
                        }
                    } else {
                        // UNJAIL THEM IN CASE IP BAN CAUGHT THEM DURING INIT
                        players[id].isJailed = false;
                        ws.send(encode({ type: 'unjail' }));
                    }
                } // --- FIX: Give the server memory their inventory! ---
                players[id].inventory = user.inventory;

                // --- THE PERSISTENCE FIX: Load the saved weapon! ---
                players[id].equippedWeapon = user.equippedWeapon || "none";
                players[id].equipped = user.equipped || { head: 'H_D', body: 'body_default', hands: 'none' }; players[id].hotbar = user.hotbar || ["none", "none", "none"];
                players[id].quickSwaps = user.quickSwaps || []; // ðŸ†• Nueva lÃ­nea

                // --- NUEVO: CARGAR MONEDAS A LA RAM ---
                players[id].coins = user.coins || 0;
                players[id].gems = user.gems || 0; // Cargar Argems

                // ðŸ‘‡ NUEVO: CARGAR KILLS Y LOSSES ðŸ‘‡
                players[id].kills = user.kills || 0;
                players[id].losses = user.losses || 0;
                players[id].elo = user.elo || 1000;
                // --- NUEVO: BATTLE PASS VALIDATION ---
                if (state.ACTIVE_SEASON) {
                    if (user.bpSeasonId !== state.ACTIVE_SEASON.seasonId) {
                        user.bpSeasonId = state.ACTIVE_SEASON.seasonId;
                        user.bpXP = 0;
                        user.bpPremium = false;
                        user.bpClaimedFree = [];
                        user.bpClaimedPremium = [];
                        await user.save();
                    }
                }
                players[id].bpSeasonId = user.bpSeasonId || "";
                players[id].bpXP = user.bpXP || 0;
                players[id].bpPremium = user.bpPremium || false;
                players[id].bpClaimedFree = user.bpClaimedFree || [];
                players[id].bpClaimedPremium = user.bpClaimedPremium || []; // <--- AÃ‘ADIR ESTO
                // ðŸ‘‡ NUEVO: CARGAR SALUD A LA RAM ðŸ‘‡
                players[id].hp = user.hp !== undefined ? user.hp : 100;
                players[id].isDead = user.isDead || false;

                // --- ðŸŒŸ NUEVO: CARGAR TAREAS Y LOGROS A LA RAM (AUTO LOGIN) ðŸŒŸ ---
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

                // ðŸ›‘ EL FIX: REINICIAR EL TEMPORIZADOR DE COMBATE AL ENTRAR ðŸ›‘
                // Esto evita que los que recargan la pÃ¡gina se curen mÃ¡gicamente
                players[id].lastHitTime = Date.now();

                // Agrega esta lÃ­nea para guardar el ID Ãºnico de MongoDB en RAM:
                players[id].accountId = user._id.toString();

                // --- NUEVO: PASAR EL ROL A LA MEMORIA ---
                players[id].role = user.role || 'player';
                // ðŸ‘‡ EL FIX ANTI-COMA: Si te conectas y estabas muerto, revives automÃ¡ticamente ðŸ‘‡
                if (players[id].isDead || players[id].hp <= 0) {
                    players[id].hp = 100;
                    players[id].isDead = false;
                    // Forzamos a que MongoDB tambiÃ©n se entere de que ya no estÃ¡s muerto
                    User.findByIdAndUpdate(user._id, { hp: 100, isDead: false }).catch(console.error);
                }
                // --- NUEVO: CARGAR EL TAG DEL SQUAD EN RAM ---
                if (user.squad) {
                    const mySquad = await Squad.findById(user.squad);
                    if (mySquad) {
                        players[id].squad = mySquad._id.toString();
                        players[id].squadName = mySquad.name;
                        players[id].squadLogo = mySquad.logo;

                        const isLeader = mySquad.leader && mySquad.leader.toString() === user._id.toString();
                        const myData = mySquad.members ? mySquad.members.find(m => m.accountId && m.accountId.toString() === user._id.toString()) : null;
                        players[id].isLeader = !!isLeader;
                        players[id].squadCanInvite = isLeader || (myData && myData.canInvite) || false;
                        players[id].squadCanKick = isLeader || (myData && myData.canKick) || false;
                        players[id].squadCanAssignRoles = isLeader || (myData && myData.canAssignRoles) || false;
                        players[id].squadTitle = isLeader ? 'ðŸ‘‘ LÃ­der' : (myData && myData.customTitle ? myData.customTitle : 'Miembro');
                        players[id].squadRole = isLeader ? 'leader' : 'member';
                    }
                }

                
                  // --- THE FIX: Load their squad into memory during auto_login! ---
                  if (user.squad) {
                      const Squad = require('../models/Squad');
                      const mySquad = await Squad.findById(user.squad);
                      if (mySquad) {
                          players[id].squad = mySquad._id.toString();
                          players[id].squadName = mySquad.name;
                          players[id].squadLogo = mySquad.logo;

                          const isLeader = mySquad.leader && mySquad.leader.toString() === user._id.toString();
                          const myData = mySquad.members ? mySquad.members.find(m => m.accountId && m.accountId.toString() === user._id.toString()) : null;
                          players[id].isLeader = !!isLeader;
                          players[id].squadCanInvite = isLeader || (myData && myData.canInvite) || false;
                          players[id].squadCanKick = isLeader || (myData && myData.canKick) || false;
                          players[id].squadCanAssignRoles = isLeader || (myData && myData.canAssignRoles) || false;
                          players[id].squadTitle = isLeader ? 'L�der' : (myData && myData.customTitle ? myData.customTitle : 'Miembro');
                          players[id].squadRole = isLeader ? 'leader' : 'member';
                      }
                  }
                  
                  // Send success back to the browser

                ws.send(encode({
                    type: 'login_success',
                    player: players[id],
                    token: data.token,
                    friends: user.friends,
                    globalTasks: GLOBAL_TASKS,
                    taskProgress: players[id].taskProgress,
                    claimedTasks: players[id].claimedTasks,
                    hasSeenTutorial: user.hasSeenTutorial,
                    activeSeason: state.ACTIVE_SEASON
                }));
                console.log(`[LOGIN_SUCCESS] Sending claimedTasks for ${user.email}:`, players[id].claimedTasks);

                // Tell everyone else you arrived (excluding yourself so no ghost clone appears!)
                broadcast({ type: 'update', id: id, player: players[id] }, ws);

                // --- NUEVO: TRIGGER TUTORIAL IF NEEDED ---
                if (!user.hasSeenTutorial) {
                    ws.send(encode({ type: 'trigger_tutorial' }));
                }
            } catch (err) { console.error("AUTO LOGIN CRASH", err); ws.send(encode({ type: 'auth_error', message: 'Server crashed during login.' })); }
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
            // 1. Subimos la velocidad teÃ³rica a 400px por segundo para dar mÃ¡s holgura al lag.
            let MAX_ALLOWED_DIST = (400 * timeSinceLastUpdate) / 1000;

            // 2. Subimos el "Piso MÃ­nimo" de 15 a 45 pÃ­xeles. 
            // Esto evita que el servidor te castigue cuando recibe 2 paquetes amontonados al mismo tiempo.
            MAX_ALLOWED_DIST = Math.max(45, MAX_ALLOWED_DIST);

            // --- NUEVO: Â¿ESTÃ CERCA DE UN TELETRANSPORTADOR LEGAL? ---
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
                        // Calculamos a dÃ³nde lleva esta puerta teÃ³ricamente
                        const expectedX = (logicTile.destX * TILE_SIZE) + (TILE_SIZE / 2);
                        const expectedY = (logicTile.destY * TILE_SIZE) + (TILE_SIZE / 2);

                        // EL FIX DEFINITIVO: 150 pÃ­xeles de tolerancia.
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
            const isAdmin = p && (p.role === 'admin' || !!p.noclipEnabled);

            // EL FIX: Agregamos !isLegalTeleport para que no lo castigue si usÃ³ una puerta
            if (p.isFrozen || (!isAdmin && !isLegalTeleport && (dist > MAX_ALLOWED_DIST || isColliding))) {

                // Distinguir: Â¿colisiÃ³n limpia con pared o speedhack real?
                // 'wall'     â†’ el cliente se reposiciona silenciosamente, sin flash rojo
                // 'antihack' â†’ el cliente muestra flash rojo y resetea velocidad
                const rejectReason = p.isFrozen ? 'wall' : (isColliding ? 'wall' : 'antihack');

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

                // --- âš½ SOCCER KICK LOGIC ---
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

            // ðŸ›‘ EL FIX 2: Sincronizar el arma para que los demÃ¡s la vean en tu mano
            if (data.player.equippedWeapon !== undefined) {
                p.equippedWeapon = data.player.equippedWeapon;
            }

            let safeMsg = data.player.message || "";
            p.message = safeMsg.substring(0, 100);
            p.messageTimer = Math.min(data.player.messageTimer || 0, 600);

            // ðŸŽ¯ SEND MOVEMENT ONLY TO LOCAL CHUNK
            broadcastToZone({ type: 'update', id: id, player: p }, p.chunkId, ws);
        }

        // --- NUEVO: RUTA SEGURA PARA EQUIPAR ARMAS ---
        if (data.type === 'equip_weapon') {
            const p = players[id];
            if (!p) return;

            // ðŸ›¡ï¸ ANTI-HACK: EscÃ¡ner de inventario a prueba de formatos mixtos
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

                // Avisamos a los demÃ¡s jugadores quÃ© arma traes en la mano
                broadcast({ type: 'update', id: id, player: p }, ws);
            } else {
                console.warn(`[ANTI-HACK] ${p.username} intentÃ³ equipar un arma fantasma: ${data.weaponId}`);
            }
        }

        // --- NUEVO: RUTA SEGURA PARA ACTUALIZAR EL HOTBAR ---
        if (data.type === 'update_hotbar') {
            const p = players[id];
            if (!p) return;

            // ðŸ›¡ï¸ ANTI-HACK: EscÃ¡ner de inventario a prueba de formatos mixtos
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
                console.warn(`[ANTI-HACK] ${p.username} intentÃ³ equipar ${data.weaponId} sin comprarlo.`);
            }
        }
        // ðŸ”„ NUEVO: AVISO DE RECARGA AL SERVIDOR
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
        }// ðŸ› ï¸ COMANDO DE RESCATE (/fix)
        if (data.type === 'force_unstuck' && isAuthenticated) {
            const p = players[id];
            if (p) {
                // Limpiamos los estados de trabado
                p.isReloading = false;

                if (ws.reloadTimeout) {
                    clearTimeout(ws.reloadTimeout);
                    delete ws.reloadTimeout;
                }

                // ðŸ›¡ï¸ EL FIX: Solo revivir si realmente su HP era 0
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
                    text: "ðŸ› ï¸ Tu personaje ha sido desbugueado.",
                    color: "#2ecc71"
                }));
            }
        }
        // 7. HANDLE SHOOTING (SINCRO VISUAL ABSOLUTA ANTI-FANTASMAS)
        if (data.type === 'shoot') {
            const shooter = players[id];

            // ðŸ›‘ EL FIX 3: Usar el ID del arma que manda el gatillo, no el de la memoria lenta
            const weaponId = data.weaponId || shooter.equippedWeapon || "none";
            const stats = WEAPONS[weaponId];

            if (!stats || weaponId === "none" || isInSafeZone(shooter.worldX, shooter.worldY)) return;

            const now = Date.now();

            // ðŸ›¡ï¸ ANTI-HACK: Control de Spam (Fire Rate)
            if (now - (shooter.lastShotTime || 0) < ((stats.fireRate || 300) - 50)) return;
            shooter.lastShotTime = now;

            // ðŸ›¡ï¸ ANTI-HACK: Control de Balas MÃ¡gicas
            if (stats.type === 'ranged') {
                if (shooter.weaponAmmo[weaponId] === undefined) shooter.weaponAmmo[weaponId] = stats.magSize;
                if (shooter.weaponAmmo[weaponId] <= 0) return; // ðŸ›‘ HACKER INTENTANDO DISPARAR SIN BALAS
                shooter.weaponAmmo[weaponId]--; // Descontamos la bala oficial
            }

            // ðŸ›‘ EL FIX 4: Reenviar usando weaponId para que tu oponente dibuje la bala y escuche tu disparo
            broadcastToZone({ type: 'shoot', id: id, x: data.x, y: data.y, angle: data.angle, weaponId: weaponId, t: now }, shooter.chunkId, ws);

            if (stats && stats.type !== 'melee') {
                // âš¡ LAG COMPENSATION: Advance bullet by 50ms of travel time (1.5 server frames)
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
        // --- 1. SINCRONIZAR ANIMACIÃ“N MELEE Y CALCULAR DAÃ‘O ---
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

            // ðŸŽ¯ SEND SWING ANIMATION ONLY TO LOCAL CHUNK
            broadcastToZone({
                type: 'player_swing',
                id: id,
                weaponId: weaponId
            }, shooter.chunkId, ws);

            // ðŸ’¥ SERVER-AUTHORITATIVE MELEE HIT DETECTION ðŸ’¥
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

            // --- SANEAMIENTO: MÃ¡ximo 250 caracteres ---
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

                // ðŸ›¡ï¸ Convert Mongoose docs to plain objects before encoding (avoids 'Too deep' error)
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

                // ðŸ›‘ EL FIX: AÃ±adir .lean() para limpiar el objeto de Mongoose
                const targetUser = await User.findById(targetAccountId).lean();
                const currentTargetName = targetUser ? targetUser.username : "Usuario Desconocido";
                const targetEquipped = targetUser && targetUser.equipped ? targetUser.equipped : { head: 'H_D' };

                // ðŸ›‘ EL FIX: AÃ±adir .lean() al historial de mensajes
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

                // ðŸ›‘ EL FIX: AÃ±adir .lean()
                const convos = await PM.find({ participants: myAccountId }).lean();

                const inboxData = [];
                for (let c of convos) {
                    const otherPersonId = c.participants.find(p => p !== myAccountId);

                    // ðŸ›‘ EL FIX: AÃ±adir .lean()
                    const otherUser = await User.findById(otherPersonId).lean();
                    const currentName = otherUser ? otherUser.username : "Usuario Desconocido";
                    const currentHead = (otherUser && otherUser.equipped) ? otherUser.equipped.head : 'H_D';

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
        // ðŸ’¬ SQUAD CHAT (RAM-DRIVEN)
        // ==========================================

        function broadcastSquadAnnouncement(sqIdStr, text) {
            if (!sqIdStr) return;
            if (!SQUAD_CHATS_RAM[sqIdStr]) SQUAD_CHATS_RAM[sqIdStr] = [];

            const announcementMsg = {
                senderId: 'system',
                senderName: 'Clan',
                senderHead: 'H_D',
                text: text,
                timestamp: new Date().toISOString(),
                isSystem: true,
                isAnnouncement: true
            };

            SQUAD_CHATS_RAM[sqIdStr].push(announcementMsg);
            if (SQUAD_CHATS_RAM[sqIdStr].length > 30) SQUAD_CHATS_RAM[sqIdStr].shift();

            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && players[client.playerId] && players[client.playerId].squad === sqIdStr) {
                    client.send(encode({
                        type: 'new_squad_chat',
                        message: announcementMsg
                    }));
                }
            });
        }

        const SQUAD_ANNOUNCEMENT_BUFFER = {};

        function queueSquadMemberAnnouncement(sqIdStr, actorUsername, targetAccountId, targetUsername, oldData, newData) {
            const key = `${sqIdStr}:${targetAccountId}`;

            if (!SQUAD_ANNOUNCEMENT_BUFFER[key]) {
                SQUAD_ANNOUNCEMENT_BUFFER[key] = {
                    sqIdStr,
                    actorUsername,
                    targetUsername,
                    oldTitle: oldData.title,
                    oldCanInvite: oldData.canInvite,
                    oldCanKick: oldData.canKick,
                    oldCanAssignRoles: oldData.canAssignRoles,
                    newTitle: newData.title,
                    newCanInvite: newData.canInvite,
                    newCanKick: newData.canKick,
                    newCanAssignRoles: newData.canAssignRoles,
                    timer: null
                };
            } else {
                const buf = SQUAD_ANNOUNCEMENT_BUFFER[key];
                buf.actorUsername = actorUsername;
                buf.targetUsername = targetUsername;
                buf.newTitle = newData.title;
                buf.newCanInvite = newData.canInvite;
                buf.newCanKick = newData.canKick;
                buf.newCanAssignRoles = newData.canAssignRoles;
                if (buf.timer) clearTimeout(buf.timer);
            }

            SQUAD_ANNOUNCEMENT_BUFFER[key].timer = setTimeout(() => {
                const buf = SQUAD_ANNOUNCEMENT_BUFFER[key];
                delete SQUAD_ANNOUNCEMENT_BUFFER[key];
                if (!buf) return;

                const titleChanged = buf.newTitle !== buf.oldTitle;
                const inviteChanged = buf.newCanInvite !== buf.oldCanInvite;
                const kickChanged = buf.newCanKick !== buf.oldCanKick;
                const assignChanged = buf.newCanAssignRoles !== buf.oldCanAssignRoles;

                if (!titleChanged && !inviteChanged && !kickChanged && !assignChanged) {
                    return;
                }

                const grantedPowers = [];
                if (inviteChanged && buf.newCanInvite) grantedPowers.push("reclutar");
                if (kickChanged && buf.newCanKick) grantedPowers.push("expulsar");
                if (assignChanged && buf.newCanAssignRoles) grantedPowers.push("asignar roles");

                const revokedPowers = [];
                if (inviteChanged && !buf.newCanInvite) revokedPowers.push("reclutar");
                if (kickChanged && !buf.newCanKick) revokedPowers.push("expulsar");
                if (assignChanged && !buf.newCanAssignRoles) revokedPowers.push("asignar roles");

                const formatList = (items) => {
                    if (items.length === 0) return '';
                    if (items.length === 1) return `[${items[0]}]`;
                    if (items.length === 2) return `[${items[0]}] y [${items[1]}]`;
                    return `${items.slice(0, -1).map(i => `[${i}]`).join(', ')} y [${items[items.length - 1]}]`;
                };

                const parts = [];
                if (titleChanged) {
                    parts.push(`asignÃ³ el rol [${buf.newTitle}]`);
                }
                if (grantedPowers.length > 0) {
                    const word = grantedPowers.length === 1 ? "el poder de" : "los poderes de";
                    parts.push(`dio ${word} ${formatList(grantedPowers)}`);
                }
                if (revokedPowers.length > 0) {
                    const word = revokedPowers.length === 1 ? "el poder de" : "los poderes de";
                    parts.push(`quitÃ³ ${word} ${formatList(revokedPowers)}`);
                }

                if (parts.length > 0) {
                    let actionPhrase = "";
                    if (parts.length === 1) {
                        actionPhrase = `le ${parts[0]}`;
                    } else if (parts.length === 2) {
                        actionPhrase = `le ${parts[0]} y le ${parts[1]}`;
                    } else {
                        actionPhrase = `le ${parts.slice(0, -1).join(', le ')} y le ${parts[parts.length - 1]}`;
                    }
                    broadcastSquadAnnouncement(buf.sqIdStr, `@${buf.actorUsername} ${actionPhrase} a @${buf.targetUsername}`);
                }
            }, 600);
        }

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
                // ðŸ›‘ EL FIX: Guardar la cabeza actual en el historial
                senderHead: players[id] && players[id].equipped ? players[id].equipped.head : 'H_D',
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
        // 12. PEDIR LISTA DE AMIGOS ACTUALIZADA (VersiÃ³n Optimizada con Live Data y Ropa)
        if (data.type === 'get_friends_list' && isAuthenticated) {
            try {
                const myUser = await User.findOne({ email: currentUser });

                // Filtramos solo los IDs vÃ¡lidos
                const validFriendIds = (myUser.friends || []).filter(fid => mongoose.Types.ObjectId.isValid(fid));

                // Consultamos MongoDB
                const friendsUsers = await User.find({ _id: { $in: validFriendIds } }).lean();

                // Armamos el paquete enriquecido con datos en vivo si estÃ¡n conectados
                const friendsData = friendsUsers.map(fUser => {
                    const accIdStr = fUser._id.toString();
                    let onlinePlayer = null;
                    for (let pid in players) {
                        if (players[pid].accountId === accIdStr) {
                            onlinePlayer = players[pid];
                            break;
                        }
                    }
                    return {
                        accountId: accIdStr,
                        username: onlinePlayer ? onlinePlayer.username : fUser.username,
                        role: onlinePlayer ? onlinePlayer.role : (fUser.role || 'player'),
                        equipped: onlinePlayer ? (onlinePlayer.equipped || { head: 'H_D', body: 'body_default', hat: 'none' }) : (fUser.equipped || { head: 'H_D', body: 'body_default', hat: 'none' }),
                        elo: onlinePlayer ? (onlinePlayer.elo || 1000) : (fUser.elo || 1000),
                        kills: onlinePlayer ? (onlinePlayer.kills || 0) : (fUser.kills || 0),
                        losses: onlinePlayer ? (onlinePlayer.losses || 0) : (fUser.losses || 0),
                        coins: onlinePlayer ? (onlinePlayer.coins || 0) : (fUser.coins || 0),
                        squadName: onlinePlayer ? onlinePlayer.squadName : null,
                        squadLogo: onlinePlayer ? onlinePlayer.squadLogo : null,
                        isOnline: !!onlinePlayer
                    };
                });

                ws.send(encode({ type: 'friends_list_data', friends: friendsData }));
            } catch (err) { console.error("Error pidiendo amigos:", err); }
        }

        // 27. BÃšSQUEDA GLOBAL DE JUGADORES (Con Live Data)
        if (data.type === 'search_players' && isAuthenticated) {
            try {
                const query = data.query ? data.query.trim() : "";
                // Bloqueo de seguridad: MÃ­nimo 2 caracteres
                if (query.length < 2) return;

                // Buscar en MongoDB
                const users = await User.find({
                    username: { $regex: query, $options: 'i' }
                }).limit(20).lean();

                // Empaquetamos datos enriquecidos con live data
                const searchResults = users.map(u => {
                    const accIdStr = u._id.toString();
                    let onlinePlayer = null;
                    for (let pid in players) {
                        if (players[pid].accountId === accIdStr) {
                            onlinePlayer = players[pid];
                            break;
                        }
                    }
                    return {
                        accountId: accIdStr,
                        username: onlinePlayer ? onlinePlayer.username : u.username,
                        role: onlinePlayer ? onlinePlayer.role : (u.role || 'player'),
                        equipped: onlinePlayer ? (onlinePlayer.equipped || { head: 'H_D', body: 'body_default', hat: 'none' }) : (u.equipped || { head: 'H_D', body: 'body_default', hat: 'none' }),
                        elo: onlinePlayer ? (onlinePlayer.elo || 1000) : (u.elo || 1000),
                        kills: onlinePlayer ? (onlinePlayer.kills || 0) : (u.kills || 0),
                        losses: onlinePlayer ? (onlinePlayer.losses || 0) : (u.losses || 0),
                        coins: onlinePlayer ? (onlinePlayer.coins || 0) : (u.coins || 0),
                        squadName: onlinePlayer ? onlinePlayer.squadName : null,
                        squadLogo: onlinePlayer ? onlinePlayer.squadLogo : null,
                        isOnline: !!onlinePlayer
                    };
                });

                ws.send(encode({ type: 'search_players_results', results: searchResults }));
            } catch (err) {
                console.error("Error buscando jugadores:", err);
            }
        }

        // ðŸŒŸ 13. SISTEMA DE LOGROS Y TAREAS DIARIAS ðŸŒŸ
        if (data.type === 'claim_task' && isAuthenticated) {
            const p = players[id];
            if (!p) return;

            const taskId = data.taskId;
            const task = GLOBAL_TASKS[taskId];

            if (!task) return ws.send(encode({ type: 'claim_error', message: 'Invalid task.' }));

            // 1. Verificar si ya fue cobrada y si estÃ¡ en cooldown
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

            // 2. Verificar progreso (Engine GenÃ©rico)
            let hasCompleted = false;
            if (task.requirementType === 'login') {
                hasCompleted = true; // Si estÃ¡ enviando el paquete, ya estÃ¡ logueado
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

            // 4. Avisar al cliente que fue un Ã©xito
            p.claimedTasks[taskId] = now;
            ws.send(encode({ type: 'task_claimed', taskId: taskId, claimedTasks: p.claimedTasks }));

            // --- NUEVO: RECOMPENSA DE BATTLE PASS ---
            const bpXp = task.bpXpReward || 100;
            add_bp_xp(p.email, bpXp, ws, p);

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
        // --- NUEVO: BATTLE PASS PACKETS ---
        if (data.type === 'buy_premium_bp' && isAuthenticated) {
            const p = players[id];
            if (!p || !state.ACTIVE_SEASON) return;
            if (p.bpPremium) return ws.send(encode({ type: 'bp_error', message: 'You already own the Premium Pass.' }));

            if (p.gems < state.ACTIVE_SEASON.costArgems) {
                return ws.send(encode({ type: 'bp_error', message: 'Not enough Argems.' }));
            }

            p.gems -= state.ACTIVE_SEASON.costArgems;
            p.bpPremium = true;

            ws.send(encode({ type: 'gems_update', gems: p.gems }));
            ws.send(encode({ type: 'bp_premium_unlocked' }));

            // Guardar asï¿½ncronamente
            User.updateOne({ email: p.email }, { $set: { gems: p.gems, bpPremium: true } }).catch(console.error);
        }

        if (data.type === 'claim_bp_reward' && isAuthenticated) {
            const p = players[id];
            if (!p || !state.ACTIVE_SEASON) return;

            const level = data.level;
            const track = data.track; // 'free' o 'premium'

            // Validar que el nivel exista en la config
            const rewardData = state.ACTIVE_SEASON.rewards.find(r => r.level === level);
            if (!rewardData) return ws.send(encode({ type: 'bp_error', message: 'Invalid level.' }));

            // Validar que tenga el XP necesario
            if (p.bpXP < rewardData.xpRequired) {
                return ws.send(encode({ type: 'bp_error', message: 'Not enough XP for this level.' }));
            }

            // Validar track
            let rewardToGive = null;
            if (track === 'free') {
                if (p.bpClaimedFree.includes(level)) return ws.send(encode({ type: 'bp_error', message: 'Already claimed.' }));
                rewardToGive = rewardData.free;
                p.bpClaimedFree.push(level);
            } else if (track === 'premium') {
                if (!p.bpPremium) return ws.send(encode({ type: 'bp_error', message: 'You need the Premium Pass.' }));
                if (p.bpClaimedPremium.includes(level)) return ws.send(encode({ type: 'bp_error', message: 'Already claimed.' }));
                rewardToGive = rewardData.premium;
                p.bpClaimedPremium.push(level);
            }

            if (!rewardToGive) {
                // Si el premio es null (ejemplo: nivel sin premio gratis), remover el nivel del array para evitar bugs
                if (track === 'free') p.bpClaimedFree.pop();
                if (track === 'premium') p.bpClaimedPremium.pop();
                return ws.send(encode({ type: 'bp_error', message: 'No reward available here.' }));
            }

            // Otorgar el premio
            let updatePayload = { bpClaimedFree: p.bpClaimedFree, bpClaimedPremium: p.bpClaimedPremium };

            if (rewardToGive.type === 'coins') {
                p.coins += rewardToGive.amount;
                updatePayload.coins = p.coins;
                ws.send(encode({ type: 'coins_update', coins: p.coins }));
            } else if (rewardToGive.type === 'argems') {
                p.gems += rewardToGive.amount;
                updatePayload.gems = p.gems;
                ws.send(encode({ type: 'gems_update', gems: p.gems }));
            } else if (rewardToGive.type === 'item') {
                if (!p.inventory.includes(rewardToGive.id)) {
                    p.inventory.push(rewardToGive.id);
                    updatePayload.inventory = p.inventory;
                    ws.send(encode({ type: 'inventory_update', inventory: p.inventory }));
                }
            }

            // Informar ï¿½xito
            ws.send(encode({
                type: 'bp_reward_claimed',
                level: level,
                track: track,
                reward: rewardToGive,
                bpClaimedFree: p.bpClaimedFree,
                bpClaimedPremium: p.bpClaimedPremium
            }));

            // Guardar asï¿½ncronamente
            User.updateOne({ email: p.email }, { $set: updatePayload }).catch(console.error);
        }
        if (data.type === 'buy_item' && isAuthenticated) {
            const p = players[id];
            if (!p) return;

            const itemId = data.itemId;

            // ðŸ›‘ EL FIX: Buscar en TODO el catÃ¡logo maestro, no solo en la carpeta de armas
            const itemStats = WEAPONS[itemId] || MASTER_CATALOG[itemId];

            if (!itemStats) return ws.send(encode({ type: 'buy_error', message: 'Este objeto no existe en la base de datos.' }));

            // Verificamos si ya lo tiene en su inventario
            const alreadyOwned = p.inventory && p.inventory.some(i => (typeof i === 'object' ? i.id : i) === itemId);
            if (alreadyOwned) return ws.send(encode({ type: 'buy_error', message: 'Ya posees este objeto.' }));

            if (p.coins < itemStats.price) return ws.send(encode({ type: 'buy_error', message: 'Monedas insuficientes.' }));

            try {
                // Cobrar y entregar el Ã­tem
                p.coins -= itemStats.price;
                if (!p.inventory) p.inventory = [];
                p.inventory.push(itemId);

                // Avisar al jugador que la compra fue un Ã©xito
                ws.send(encode({
                    type: 'buy_success',
                    message: `Â¡Compraste ${itemStats.name}!`,
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

                // ðŸ›‘ EL FIX: Borrar la validaciÃ³n que bloqueaba si ya tenÃ­as un Tag equipado.
                // En su lugar, revisamos en la base de datos si ya eres DUEÃ‘O de un clan.
                const alreadyLeader = await Squad.findOne({ leader: myUser._id });
                if (alreadyLeader) {
                    return ws.send(encode({
                        type: 'squad_error',
                        message: 'Ya eres fundador de un Squad. Solo puedes ser dueÃ±o de uno.'
                    }));
                }

                // Revisar el dinero
                if (myUser.coins < 2000) {
                    return ws.send(encode({
                        type: 'squad_error',
                        message: 'No tienes suficientes Argons (Cuesta 2000 ðŸª™).'
                    }));
                }

                // Revisar si el nombre ya estÃ¡ en uso por otro clan
                const existingName = await Squad.findOne({ name: data.squadName });
                if (existingName) {
                    return ws.send(encode({
                        type: 'squad_error',
                        message: 'Ese nombre ya estÃ¡ registrado.'
                    }));
                }

                // 1. Cobrar y Crear
                myUser.coins -= 2000;

                const newSquad = new Squad({
                    name: data.squadName,
                    logo: data.logo || "",
                    leader: myUser._id,
                    members: [] // Entra sin miembros, Ã©l es el lÃ­der
                });
                await newSquad.save();

                // 2. Equiparle automÃ¡ticamente su nuevo Tag de Fundador
                myUser.squad = newSquad._id;
                await myUser.save();

                // 3. Actualizar la memoria RAM del servidor
                if (players[id]) {
                    players[id].coins = myUser.coins;
                    players[id].gems = myUser.gems;
                    players[id].squad = newSquad._id.toString();
                    players[id].squadName = newSquad.name;
                    players[id].squadLogo = newSquad.logo;
                    players[id].squadCanInvite = true; // El lÃ­der siempre puede invitar
                }

                // 4. Avisar al jugador que fue un Ã©xito
                ws.send(encode({
                    type: 'squad_success',
                    message: `Â¡Has fundado el Squad [${newSquad.name}]!`,
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

                    // 3. Actualizar la memoria RAM si tÃº estÃ¡s conectado
                    if (players[id]) {
                        players[id].friends = myUser.friends.map(fid => fid.toString());
                    }

                    // 4. (Opcional) Actualizar la memoria RAM del amigo si Ã©l tambiÃ©n estÃ¡ conectado jugando
                    const friendSocket = Object.keys(players).find(key => players[key].accountId === data.targetId);
                    if (friendSocket && players[friendSocket]) {
                        players[friendSocket].friends = friendUser.friends.map(fid => fid.toString());
                    }

                    // 5. Avisarte que fue un Ã©xito
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
                    id: sq._id.toString(), // ðŸ›‘ EL FIX: Forzar a que sea texto
                    name: sq.name,
                    logo: sq.logo,
                    isLeader: sq.leader.toString() === myUser._id.toString(),
                    memberCount: sq.members.length + 1
                }));

                ws.send(encode({ type: 'my_squads_list_data', squads: listData }));
            } catch (err) { console.error("AUTO LOGIN CRASH", err); ws.send(encode({ type: 'auth_error', message: 'Server crashed during login.' })); }
        }

        // 17. OBTENER DETALLES DE UN SQUAD ESPECÃFICO (Con Logo y Stats)
        if ((data.type === 'get_squad_details' || data.type === 'get_squad_details_silent') && isAuthenticated) {
            try {
                const squad = await Squad.findById(data.squadId)
                    // ðŸ›‘ EL FIX: Pedir explÃ­citamente los stats de combate y economÃ­a
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
                        equipped: squad.leader.equipped || { head: 'H_D', body: 'body_default', hat: 'none' },
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
                            equipped: m.accountId.equipped || { head: 'H_D', body: 'body_default', hat: 'none' },
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

                if (data.type === 'get_squad_details_silent') {
                    ws.send(encode({ type: 'my_squad_data_silent', squad: squadData }));
                } else {
                    ws.send(encode({ type: 'my_squad_data', squad: squadData }));
                }
            } catch (err) { console.error("AUTO LOGIN CRASH", err); ws.send(encode({ type: 'auth_error', message: 'Server crashed during login.' })); }
        }
        // 26. SOLICITAR EL LEADERBOARD (PUNTAJES DE SQUADS Y BASES EN VIVO)
        if (data.type === 'get_squad_leaderboard' && isAuthenticated) {
            try {
                // 1. Obtener a todos los clanes
                const allSquads = await Squad.find({}, 'name logo dailyTimeMinutes weeklyTimeMinutes territoryTimeMinutes').lean();

                // ðŸ›‘ EL FIX ARQUITECTÃ“NICO: Convertir los ObjectId a Strings ligeros antes de enviarlos
                const cleanSquads = allSquads.map(sq => ({
                    ...sq,
                    _id: sq._id.toString()
                }));

                // 2. Preparar la vista "En Vivo"
                const liveBases = [];
                const basesList = state.turfBases ? Object.values(state.turfBases) : (state.centralBase ? [state.centralBase] : []);
                for (const b of basesList) {
                    let ownerLogo = "";
                    if (b.currentOwnerSquadId) {
                        const sq = await Squad.findOne({ name: b.currentOwnerSquadId });
                        if (sq) ownerLogo = sq.logo;
                    }

                    liveBases.push({
                        turfId: b.turfId,
                        name: b.name,
                        owner: b.currentOwnerSquadId || "Nadie",
                        ownerLogo: ownerLogo,
                        hp: b.hp,
                        maxHp: b.maxHp
                    });
                }

                ws.send(encode({
                    type: 'squad_leaderboard_data',
                    squads: cleanSquads, // ðŸ‘ˆ Enviamos la lista sanitizada
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

                // Seguridad: Verificar si existe y si soy el lÃ­der
                if (!squad || squad.leader.toString() !== myUser._id.toString()) {
                    return ws.send(encode({ type: 'edit_squad_error', message: 'No tienes permisos de LÃ­der.' }));
                }

                const newName = data.newName.trim();
                const newLogo = data.newLogo ? data.newLogo.trim() : "";

                if (newName.length < 3 || newName.length > 20) return ws.send(encode({ type: 'edit_squad_error', message: 'El nombre debe tener entre 3 y 20 letras.' }));
                if (newLogo !== "" && !newLogo.startsWith("https://i.pinimg.com/")) return ws.send(encode({ type: 'edit_squad_error', message: 'El logo debe ser una imagen de Pinterest.' }));

                // Â¿CambiÃ³ el nombre? Si es asÃ­, validamos y cobramos 350
                let nameChanged = (newName !== squad.name);
                if (nameChanged) {
                    if (p.coins < 350) return ws.send(encode({ type: 'edit_squad_error', message: 'Necesitas 350 ðŸª™ para cambiar el nombre.' }));

                    const existingSquad = await Squad.findOne({ name: new RegExp('^' + newName + '$', 'i') });
                    if (existingSquad) return ws.send(encode({ type: 'edit_squad_error', message: 'Ese nombre ya estÃ¡ en uso por otra banda.' }));

                    // Cobrar
                    p.coins -= 350;
                    myUser.coins = p.coins;
                    await myUser.save();

                    squad.name = newName;
                }

                squad.logo = newLogo;
                await squad.save();

                ws.send(encode({ type: 'edit_squad_success', message: 'Â¡Actualizado!', newCoins: p.coins, squadId: squad._id, squadName: p.squadName, squadLogo: p.squadLogo }));;
            } catch (err) { ws.send(encode({ type: 'edit_squad_error', message: 'Error del servidor.' })); }
        }// ðŸ” BUSCAR SQUADS EN LA BASE DE DATOS
        if (data.type === 'search_squads' && isAuthenticated) {
            try {
                const query = data.query ? data.query.trim() : "";
                let filter = {};

                // Si hay texto, buscamos por nombre (insensible a mayÃºsculas)
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
                    id: sq._id.toString(), // ðŸ›‘ EL FIX: Forzar a que sea texto
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
                const isMember = squad.members.some(m => m.accountId && m.accountId.toString() === myUser._id.toString());

                if (!isLeader && !isMember) {
                    return ws.send(encode({ type: 'squad_error', message: 'No perteneces a este squad.' }));
                }

                // 2. LÃ³gica del "Interruptor" (Toggle)
                let isActive = false;

                // Si el squad que me enviÃ³ es el mismo que ya tengo equipado, significa que lo quiero QUITAR
                if (myUser.squad && myUser.squad.toString() === squadId) {
                    myUser.squad = null;
                    p.squad = null;
                    p.squadName = null;
                    p.squadLogo = null;
                    p.squadCanInvite = false;
                    p.squadCanKick = false;
                    p.squadCanAssignRoles = false;
                    p.isLeader = false;
                    p.squadRole = null;
                    p.squadTitle = null;
                    isActive = false;

                } else {
                    // Si es distinto o estaba en null, lo quiero EQUIPAR (adopta todos los poderes del nuevo squad)
                    const myMemberObj = squad.members ? squad.members.find(m => m.accountId && m.accountId.toString() === myUser._id.toString()) : null;
                    const canInvite = isLeader || (myMemberObj && myMemberObj.canInvite) || false;
                    const canKick = isLeader || (myMemberObj && myMemberObj.canKick) || false;
                    const canAssignRoles = isLeader || (myMemberObj && myMemberObj.canAssignRoles) || false;
                    const customTitle = isLeader ? 'ðŸ‘‘ LÃ­der' : (myMemberObj && myMemberObj.customTitle ? myMemberObj.customTitle : 'Miembro');

                    myUser.squad = squad._id;
                    p.squad = squad._id.toString();
                    p.squadName = squad.name;
                    p.squadLogo = squad.logo;
                    p.squadCanInvite = canInvite;
                    p.squadCanKick = canKick;
                    p.squadCanAssignRoles = canAssignRoles;
                    p.isLeader = isLeader;
                    p.squadRole = isLeader ? 'leader' : 'member';
                    p.squadTitle = customTitle;
                    isActive = true;
                }

                // 3. Guardar en Base de Datos y avisar al cliente
                await myUser.save();

                ws.send(encode({
                    type: 'toggle_squad_success',
                    isActive: isActive,
                    squadId: isActive ? squadId : null,
                    squadName: p.squadName,
                    squadLogo: p.squadLogo,
                    squadCanInvite: p.squadCanInvite,
                    squadCanKick: p.squadCanKick,
                    squadCanAssignRoles: p.squadCanAssignRoles,
                    isLeader: p.isLeader,
                    squadRole: p.squadRole,
                    squadTitle: p.squadTitle
                }));

                // Avisarle a los demÃ¡s jugadores conectados que cambiaste tu Tag
                broadcast({ type: 'update', id: id, player: p }, ws);

            } catch (err) {
                console.error("Error al hacer toggle del tag:", err);
            }
        }
        // 20. ENVIAR INVITACIÃ“N AL CLAN
        // =========================================================
        // ðŸ” PERFIL DE JUGADOR (EN VIVO DESDE RAM O MONGODB)
        // =========================================================
        if (data.type === 'get_player_profile' && isAuthenticated) {
            try {
                let targetWsId = null;
                let targetPlayer = null;

                // 1. Buscar si estÃ¡ conectado en la RAM del servidor
                for (let pid in players) {
                    const pl = players[pid];
                    if (
                        (data.accountId && pl.accountId && pl.accountId.toString() === data.accountId.toString()) ||
                        (data.targetId && (pid === data.targetId.toString() || (pl.accountId && pl.accountId.toString() === data.targetId.toString()))) ||
                        (data.username && pl.username && pl.username.toLowerCase() === data.username.toLowerCase())
                    ) {
                        targetWsId = pid;
                        targetPlayer = pl;
                        break;
                    }
                }

                if (targetPlayer) {
                    // Enviar datos en vivo desde la memoria RAM
                    return ws.send(encode({
                        type: 'player_profile_data',
                        targetId: data.targetId || targetWsId,
                        profile: {
                            accountId: targetPlayer.accountId,
                            username: targetPlayer.username,
                            gameId: targetPlayer.gameId || "",
                            role: targetPlayer.role || (targetPlayer.isGuest ? 'guest' : 'player'),
                            isGuest: !!targetPlayer.isGuest,
                            isOnline: true,
                            coins: targetPlayer.coins || 0,
                            gems: targetPlayer.gems || 0,
                            kills: targetPlayer.kills || 0,
                            losses: targetPlayer.losses || 0,
                            elo: targetPlayer.elo || 1000,
                            squad: targetPlayer.squad || null,
                            squadName: targetPlayer.squadName || null,
                            squadLogo: targetPlayer.squadLogo || null,
                            equipped: targetPlayer.equipped || { head: 'H_D', body: 'body_default', hat: 'none' }
                        }
                    }));
                }

                // 2. Si no estÃ¡ en RAM, buscar en MongoDB
                let mongoQuery = null;
                if (data.accountId && mongoose.Types.ObjectId.isValid(data.accountId)) {
                    mongoQuery = { _id: data.accountId };
                } else if (data.username) {
                    mongoQuery = { username: new RegExp('^' + data.username.trim() + '$', 'i') };
                }

                if (mongoQuery) {
                    const dbUser = await User.findOne(mongoQuery).lean();
                    if (dbUser) {
                        let squadInfo = null;
                        if (dbUser.squad) {
                            squadInfo = await Squad.findById(dbUser.squad).lean();
                        }
                        return ws.send(encode({
                            type: 'player_profile_data',
                            targetId: data.targetId,
                            profile: {
                                accountId: dbUser._id.toString(),
                                username: dbUser.username,
                                gameId: dbUser.gameId || "",
                                role: dbUser.role || 'player',
                                isGuest: false,
                                isOnline: false,
                                coins: dbUser.coins || 0,
                                gems: dbUser.gems || 0,
                                kills: dbUser.kills || 0,
                                losses: dbUser.losses || 0,
                                elo: dbUser.elo || 1000,
                                squad: dbUser.squad ? dbUser.squad.toString() : null,
                                squadName: squadInfo ? squadInfo.name : null,
                                squadLogo: squadInfo ? squadInfo.logo : null,
                                equipped: dbUser.equipped || { head: 'H_D', body: 'body_default', hat: 'none' }
                            }
                        }));
                    }
                }

                // 3. Si no se encontrÃ³ en ningÃºn lado
                ws.send(encode({
                    type: 'player_profile_data',
                    targetId: data.targetId,
                    profile: null
                }));
            } catch (err) {
                console.error("Error en get_player_profile:", err);
            }
        }

        // 20. ENVIAR INVITACIÃ“N AL CLAN (RECLUTAMIENTO)
        if (data.type === 'send_squad_invite' && isAuthenticated) {
            try {
                const p = players[id];
                if (!p.squad) return ws.send(encode({ type: 'squad_error', message: 'Primero equipa tu Tag para invitar.' }));

                const squad = await Squad.findById(p.squad);
                if (!squad) return;

                const myUser = await User.findOne({ email: currentUser });
                const isLeader = squad.leader.toString() === myUser._id.toString();
                const memberData = squad.members.find(m => m.accountId && m.accountId.toString() === myUser._id.toString());
                const canInvite = isLeader || (memberData && memberData.canInvite);

                if (!canInvite) return ws.send(encode({ type: 'squad_error', message: 'No tienes permisos para reclutar.' }));

                // Buscar al objetivo conectado en la RAM del servidor
                let targetWsId = null;
                let targetPlayer = null;

                for (let pid in players) {
                    const pl = players[pid];
                    if (
                        (data.targetAccountId && (pl.accountId === data.targetAccountId.toString() || pid === data.targetAccountId.toString())) ||
                        (data.targetUsername && pl.username && pl.username.toLowerCase() === data.targetUsername.toLowerCase()) ||
                        (data.targetPlayerId && pid === data.targetPlayerId.toString())
                    ) {
                        targetWsId = pid;
                        targetPlayer = pl;
                        break;
                    }
                }

                if (!targetWsId || !targetPlayer) {
                    return ws.send(encode({ type: 'squad_error', message: 'El jugador no estÃ¡ en lÃ­nea.' }));
                }

                if (targetPlayer.isGuest) {
                    return ws.send(encode({ type: 'squad_error', message: 'Los jugadores invitados no pueden unirse a clanes.' }));
                }

                // --- NUEVA VALIDACIÃ“N: Â¿El objetivo ya estÃ¡ en ESTE clan? ---
                const targetIsLeader = squad.leader.toString() === targetPlayer.accountId;
                const targetIsMember = squad.members.some(m => m.accountId && m.accountId.toString() === targetPlayer.accountId);

                if (targetIsLeader || targetIsMember) {
                    return ws.send(encode({ type: 'squad_error', message: 'Este jugador ya pertenece a tu clan.' }));
                }

                wss.clients.forEach(client => {
                    if (client.playerId === targetWsId && client.readyState === WebSocket.OPEN) {
                        client.send(encode({
                            type: 'squad_invite',
                            squadId: squad._id.toString(),
                            squadName: squad.name,
                            senderUsername: p.username,
                            senderFrameX: p.frameX,
                            senderFrameY: p.frameY
                        }));
                    }
                });
                ws.send(encode({ type: 'squad_success', message: 'InvitaciÃ³n enviada.' }));
            } catch (err) { console.error("Error invitando al clan:", err); }
        }

        // 21. ACEPTAR INVITACIÃ“N AL CLAN
        if (data.type === 'accept_squad_invite' && isAuthenticated) {
            try {
                // ðŸ›‘ ESCUDO ANTI-BUFFER
                const cleanSquadId = data.squadId.buffer ? Buffer.from(data.squadId).toString('hex') : data.squadId.toString();

                const squad = await Squad.findById(cleanSquadId);
                if (!squad) return ws.send(encode({ type: 'squad_error', message: 'El clan ya no existe.' }));

                const myUser = await User.findOne({ email: currentUser });

                // Regla 1: LÃ­mite de miembros
                if (squad.members.length >= 24) return ws.send(encode({ type: 'squad_error', message: 'El clan estÃ¡ lleno.' }));

                // Regla 2: Â¿Ya estoy en este clan?
                const isMember = squad.members.some(m => m.accountId.toString() === myUser._id.toString());
                const isLeader = squad.leader.toString() === myUser._id.toString();

                if (!isMember && !isLeader) {

                    // 1. Agregar al jugador a la Base de Datos del Clan
                    squad.members.push({ accountId: myUser._id });
                    await squad.save();

                    // 2. ðŸ›‘ EL FIX 3: Sellar el Clan en la Base de Datos del Jugador
                    myUser.squad = squad._id;
                    await myUser.save();

                    // 3. Actualizar la RAM del servidor
                    if (players[id]) {
                        players[id].squad = squad._id.toString();
                        players[id].squadName = squad.name;
                        players[id].squadLogo = squad.logo;
                        players[id].squadCanInvite = false; // Entra sin poderes
                    }

                    // 4. Avisar al jugador del Ã©xito (Enviando sus nuevos datos)
                    broadcastSquadAnnouncement(squad._id.toString(), `ðŸŽ‰ @${myUser.username} se uniÃ³ al clan.`);
                    ws.send(encode({
                        type: 'squad_success',
                        message: `Â¡Te has unido al clan [${squad.name}]!`,
                        squadName: squad.name,
                        squadLogo: squad.logo,
                        squadId: squad._id.toString() // ðŸ›‘ EL FIX: Enviar el ID a la RAM
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

        // 23. GUARDAR ESTADÃSTICAS MELEE (SISTEMA DIRECCIONAL WASD)
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
            } catch (err) { console.error("ðŸ’¥ ERROR al guardar en MongoDB:", err); }
        }// 24. RECOGER BASURA CON EL TRASH PICKER
        if (data.type === 'pickup_trash' && isAuthenticated) {
            const itemId = data.itemId;
            const item = groundItems[itemId];
            const p = players[id];

            if (item && p.equippedWeapon === 'trash_picker') {
                delete groundItems[itemId];

                if (!p.inventory) p.inventory = [];

                // ðŸ›‘ EL FIX: SISTEMA APILABLE (STACKABLE)
                // Buscamos si ya tiene un "montÃ³n" de este tipo de basura
                let existingStack = p.inventory.find(i => typeof i === 'object' && i.id === item.templateId);

                if (existingStack) {
                    existingStack.quantity += 1; // Le sumamos 1 a su montÃ³n
                } else {
                    // Si no lo tiene, creamos el primer montÃ³n
                    p.inventory.push({ id: item.templateId, quantity: 1 });
                }

                broadcast({ type: 'remove_item', id: itemId });

                // Avisamos visualmente que entrÃ³ a la mochila
                ws.send(encode({
                    type: 'system_message',
                    text: `ðŸŽ’ Recogiste: ${item.name}`,
                    color: '#3498db'
                }));

                // ðŸ›‘ EL FIX: El servidor le envÃ­a a tu pantalla tu nueva mochila
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
                        // Si por algÃºn error no tiene quantity, asumimos que es 1
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

            // Si encontrÃ³ dinero, hacemos la transacciÃ³n
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
                // ðŸ›‘ EL FIX: Si por algo falla, que el servidor te avise en pantalla en lugar de ignorarte
                ws.send(encode({ type: 'system_message', text: "Error: No se encontrÃ³ basura vÃ¡lida para vender.", color: '#e74c3c' }));
            }
        }// 28. ACTUALIZAR ROL DE UN MIEMBRO DEL CLAN
        if (data.type === 'update_squad_member' && isAuthenticated) {
            try {
                const myUser = await User.findOne({ email: currentUser });
                if (!myUser) return;

                const squadId = data.squadId || myUser.squad;
                if (!squadId) return;

                const squad = await Squad.findById(squadId);
                if (!squad) return;

                // 1. Verificar si tengo permisos
                const isLeader = squad.leader.toString() === myUser._id.toString();
                const myData = squad.members.find(m => m.accountId && m.accountId.toString() === myUser._id.toString());
                const iCanAssignRoles = isLeader || (myData && myData.canAssignRoles);

                if (!iCanAssignRoles) {
                    return ws.send(encode({ type: 'system_message', text: "No tienes permisos de Administrador en el Clan.", color: "#e74c3c" }));
                }

                // 2. Buscar al miembro que queremos editar
                const targetMember = squad.members.find(m => m.accountId && m.accountId.toString() === data.targetAccountId.toString());
                if (!targetMember) return;

                // 3. Capturar valores previos antes de mutar
                const oldTitle = (targetMember.customTitle || "Miembro").trim();
                const oldCanInvite = !!targetMember.canInvite;
                const oldCanKick = !!targetMember.canKick;
                const oldCanAssignRoles = !!targetMember.canAssignRoles;

                const newTitle = typeof data.title !== 'undefined' ? data.title.trim() : oldTitle;
                const newCanInvite = typeof data.canInvite !== 'undefined' ? !!data.canInvite : oldCanInvite;
                const newCanKick = typeof data.canKick !== 'undefined' ? !!data.canKick : oldCanKick;
                const newCanAssignRoles = typeof data.canAssignRoles !== 'undefined' ? !!data.canAssignRoles : oldCanAssignRoles;

                const titleChanged = newTitle !== oldTitle;
                const inviteChanged = newCanInvite !== oldCanInvite;
                const kickChanged = newCanKick !== oldCanKick;
                const assignChanged = newCanAssignRoles !== oldCanAssignRoles;

                // ðŸ›‘ SI NADA CAMBIÃ“ REALMENTE (ej. solo entrÃ³ a mirar), NO HACER NADA
                if (!titleChanged && !inviteChanged && !kickChanged && !assignChanged) {
                    return;
                }

                // 4. Aplicar cambios a BD
                targetMember.customTitle = newTitle;
                targetMember.canInvite = newCanInvite;
                targetMember.canKick = newCanKick;
                targetMember.canAssignRoles = newCanAssignRoles;

                await squad.save();

                // ðŸ“¢ ANUNCIO APILADO CON BUFFER ANTI-SPAM
                try {
                    const targetUserDoc = await User.findById(data.targetAccountId);
                    const targetUName = targetUserDoc ? targetUserDoc.username : "un miembro";

                    queueSquadMemberAnnouncement(
                        squad._id.toString(),
                        myUser.username,
                        data.targetAccountId.toString(),
                        targetUName,
                        { title: oldTitle, canInvite: oldCanInvite, canKick: oldCanKick, canAssignRoles: oldCanAssignRoles },
                        { title: newTitle, canInvite: newCanInvite, canKick: newCanKick, canAssignRoles: newCanAssignRoles }
                    );
                } catch (annErr) {
                    console.error("Error encolando anuncio de clan:", annErr);
                }

                // 4. Re-poblar y enviar los datos del squad actualizados al cliente
                const populatedSquad = await Squad.findById(squad._id)
                    .populate('leader', 'username equipped elo kills losses coins')
                    .populate('members.accountId', 'username equipped elo kills losses coins');

                if (populatedSquad) {
                    const squadData = {
                        id: populatedSquad._id.toString(),
                        name: populatedSquad.name,
                        logo: populatedSquad.logo,
                        territoryTimeMinutes: populatedSquad.territoryTimeMinutes || 0,
                        milestonesAchieved: populatedSquad.milestonesAchieved ? Object.fromEntries(populatedSquad.milestonesAchieved) : {},
                        leader: {
                            accountId: populatedSquad.leader ? populatedSquad.leader._id.toString() : '',
                            name: populatedSquad.leader ? populatedSquad.leader.username : '',
                            equipped: populatedSquad.leader ? (populatedSquad.leader.equipped || { head: 'H_D', body: 'body_default', hat: 'none' }) : { head: 'H_D', body: 'body_default', hat: 'none' },
                            elo: populatedSquad.leader ? (populatedSquad.leader.elo || 1000) : 1000,
                            kills: populatedSquad.leader ? (populatedSquad.leader.kills || 0) : 0,
                            losses: populatedSquad.leader ? (populatedSquad.leader.losses || 0) : 0,
                            coins: populatedSquad.leader ? (populatedSquad.leader.coins || 0) : 0
                        },
                        members: populatedSquad.members.map(m => {
                            if (!m.accountId) return null;
                            return {
                                accountId: m.accountId._id.toString(),
                                name: m.accountId.username,
                                equipped: m.accountId.equipped || { head: 'H_D', body: 'body_default', hat: 'none' },
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
                    ws.send(encode({ type: 'my_squad_data_silent', squad: squadData }));
                }

                // 5. Avisarle al miembro afectado en TIEMPO REAL si le cambiaron sus poderes
                let targetWsId = Object.keys(players).find(key => players[key].accountId && players[key].accountId.toString() === data.targetAccountId.toString());
                if (targetWsId && players[targetWsId]) {
                    players[targetWsId].squadCanInvite = !!data.canInvite;
                    players[targetWsId].squadCanKick = !!data.canKick;
                    players[targetWsId].squadCanAssignRoles = !!data.canAssignRoles;
                    if (typeof data.title !== 'undefined') players[targetWsId].squadTitle = data.title;

                    wss.clients.forEach(c => {
                        if (c.playerId === targetWsId && c.readyState === WebSocket.OPEN) {
                            c.send(encode({
                                type: 'update_permissions',
                                canInvite: !!data.canInvite,
                                canKick: !!data.canKick,
                                canAssignRoles: !!data.canAssignRoles,
                                title: data.title
                            }));
                        }
                    });
                }

            } catch (err) {
                console.error("Error editando roles del squad:", err);
            }
        }

        // 29. ABANDONAR UN CLAN
        if (data.type === 'leave_squad' && isAuthenticated) {
            try {
                const myUser = await User.findOne({ email: currentUser });
                if (!myUser) return;
                const squadId = data.squadId;
                const squad = await Squad.findById(squadId);
                if (!squad) return ws.send(encode({ type: 'squad_error', message: 'Clan no encontrado.' }));

                const isLeader = squad.leader.toString() === myUser._id.toString();
                if (isLeader) {
                    return ws.send(encode({ type: 'squad_error', message: 'El lÃ­der no puede abandonar su propio clan.' }));
                }

                const memberIdx = squad.members.findIndex(m => m.accountId && m.accountId.toString() === myUser._id.toString());
                if (memberIdx === -1) {
                    return ws.send(encode({ type: 'squad_error', message: 'No eres miembro de este clan.' }));
                }

                squad.members.splice(memberIdx, 1);
                await squad.save();

                // Si tenÃ­a equipado el tag de este clan, desequiparlo
                if (myUser.squad && myUser.squad.toString() === squadId.toString()) {
                    myUser.squad = null;
                    await myUser.save();
                }
                const p = players[id];
                if (p && p.squad === squadId.toString()) {
                    p.squad = null;
                    p.squadName = null;
                    p.squadLogo = null;
                    p.squadCanInvite = false;
                    broadcast({ type: 'update', id: id, player: p }, ws);
                    ws.send(encode({ type: 'toggle_squad_success', isActive: false, squadId: null, squadName: null, squadLogo: null }));
                }

                ws.send(encode({ type: 'squad_success', message: `Has abandonado el clan [${squad.name}].` }));
                ws.send(encode({ type: 'squad_leave_success' }));
            } catch (err) {
                console.error("Error al abandonar squad:", err);
                ws.send(encode({ type: 'squad_error', message: 'Error al abandonar el clan.' }));
            }
        }

        // 30. EXPULSAR A UN MIEMBRO DEL CLAN
        if (data.type === 'kick_squad_member' && isAuthenticated) {
            try {
                const myUser = await User.findOne({ email: currentUser });
                if (!myUser) return;
                const squadId = data.squadId;
                const squad = await Squad.findById(squadId);
                if (!squad) return;

                const isLeader = squad.leader.toString() === myUser._id.toString();
                const myData = squad.members.find(m => m.accountId && m.accountId.toString() === myUser._id.toString());
                const canKick = isLeader || (myData && myData.canKick);

                if (!canKick) {
                    return ws.send(encode({ type: 'squad_error', message: 'No tienes permisos para expulsar miembros.' }));
                }

                const targetIdx = squad.members.findIndex(m => m.accountId && m.accountId.toString() === data.targetAccountId.toString());
                if (targetIdx === -1) {
                    return ws.send(encode({ type: 'squad_error', message: 'El miembro ya no pertenece al clan.' }));
                }

                squad.members.splice(targetIdx, 1);
                await squad.save();

                // Si el usuario expulsado tenÃ­a el tag guardado en BD, limpiarlo
                const targetUser = await User.findById(data.targetAccountId);
                if (targetUser && targetUser.squad && targetUser.squad.toString() === squadId.toString()) {
                    targetUser.squad = null;
                    await targetUser.save();
                }

                // Si estÃ¡ online, desequiparle el tag y avisarle en tiempo real
                let targetWsId = Object.keys(players).find(key => players[key].accountId === data.targetAccountId.toString());
                if (targetWsId && players[targetWsId]) {
                    if (players[targetWsId].squad === squadId.toString()) {
                        players[targetWsId].squad = null;
                        players[targetWsId].squadName = null;
                        players[targetWsId].squadLogo = null;
                        players[targetWsId].squadCanInvite = false;
                        broadcast({ type: 'update', id: targetWsId, player: players[targetWsId] });
                        wss.clients.forEach(c => {
                            if (c.playerId === targetWsId && c.readyState === WebSocket.OPEN) {
                                c.send(encode({ type: 'toggle_squad_success', isActive: false, squadId: null, squadName: null, squadLogo: null }));
                                c.send(encode({ type: 'system_message', text: `Fuiste expulsado del clan [${squad.name}].`, color: '#e74c3c' }));
                            }
                        });
                    }
                }

                ws.send(encode({ type: 'squad_success', message: 'Miembro expulsado correctamente.' }));

                // Re-poblar y enviar los datos del squad actualizados al cliente
                const populatedSquad = await Squad.findById(squad._id)
                    .populate('leader', 'username equipped elo kills losses coins')
                    .populate('members.accountId', 'username equipped elo kills losses coins');

                if (populatedSquad) {
                    const squadData = {
                        id: populatedSquad._id.toString(),
                        name: populatedSquad.name,
                        logo: populatedSquad.logo,
                        territoryTimeMinutes: populatedSquad.territoryTimeMinutes || 0,
                        milestonesAchieved: populatedSquad.milestonesAchieved ? Object.fromEntries(populatedSquad.milestonesAchieved) : {},
                        leader: {
                            accountId: populatedSquad.leader ? populatedSquad.leader._id.toString() : '',
                            name: populatedSquad.leader ? populatedSquad.leader.username : '',
                            equipped: populatedSquad.leader ? (populatedSquad.leader.equipped || { head: 'H_D', body: 'body_default', hat: 'none' }) : { head: 'H_D', body: 'body_default', hat: 'none' },
                            elo: populatedSquad.leader ? (populatedSquad.leader.elo || 1000) : 1000,
                            kills: populatedSquad.leader ? (populatedSquad.leader.kills || 0) : 0,
                            losses: populatedSquad.leader ? (populatedSquad.leader.losses || 0) : 0,
                            coins: populatedSquad.leader ? (populatedSquad.leader.coins || 0) : 0
                        },
                        members: populatedSquad.members.map(m => {
                            if (!m.accountId) return null;
                            return {
                                accountId: m.accountId._id.toString(),
                                name: m.accountId.username,
                                equipped: m.accountId.equipped || { head: 'H_D', body: 'body_default', hat: 'none' },
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
                    ws.send(encode({ type: 'my_squad_data_silent', squad: squadData }));
                }
            } catch (err) {
                console.error("Error expulsando miembro del squad:", err);
            }
        }

        // =========================================================
        // ðŸ›‘ NUEVO: VENDER CANTIDAD ESPECÃFICA DE UN ÃTEM INDIVIDUAL (YONKE) ðŸ›‘
        // =========================================================
        if (data.type === 'sell_individual_trash' && isAuthenticated) {
            const p = players[id];
            const requestedItemId = data.itemId;
            const requestedQty = parseInt(data.quantity);

            // 1. Validaciones de seguridad bÃ¡sicas
            if (!p.inventory || !requestedItemId || !requestedQty || requestedQty <= 0) return;

            // 2. Buscar el Ã­tem en el CatÃ¡logo de MongoDB (TRASH_CATALOG) para saber su valor
            const catalogItem = TRASH_CATALOG.find(t => t.id === requestedItemId);
            if (!catalogItem) return; // Trampa o Ã­tem no existe

            // 3. Buscar el montÃ³n (Stack) de ese Ã­tem en tu inventario apilable
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
                ws.send(encode({ type: 'system_message', text: "ðŸ›‘ No tienes suficiente cantidad de este Ã­tem.", color: '#e74c3c' }));
                return;
            }

            // 5. HACER LA TRANSACCIÃ“N
            const totalEarned = catalogItem.value * requestedQty;
            p.coins += totalEarned;

            // Descontar cantidad del inventario
            existingStack.quantity -= requestedQty;

            // Si el montÃ³n llegÃ³ a 0, borrar el objeto del array por completo
            if (existingStack.quantity <= 0) {
                p.inventory.splice(stackIndex, 1);
            }

            console.log(`ðŸ—ï¸ Venta Individual: ${p.name} vendiÃ³ x${requestedQty} ${catalogItem.name} por ${totalEarned} ðŸª™`);

            // 7. Avisar al cliente del Ã©xito (Reusamos el paquete sell_success existente en demo.html)
            ws.send(encode({
                type: 'sell_success',
                earned: totalEarned, // Monto de esta venta especÃ­fica
                newCoins: p.coins,
                newInventory: p.inventory
            }));

            broadcast({ type: 'update', id: id, player: p }, ws);
        }// â›ï¸ NUEVO: SISTEMA DE EXCAVACIÃ“N (CON FATIGA DINÃMICA BASADA EN EL ARMA)
        if (data.type === 'dig' && isAuthenticated) {
            const p = players[id];
            if (!p) return;

            const now = Date.now();

            // ðŸ‘‡ NUEVO: LEER ESTADÃSTICAS DE LA PALA DESDE LA RAM DEL SERVIDOR ðŸ‘‡
            const weaponId = p.equippedWeapon || 'none';
            const weaponStats = WEAPONS[weaponId] || {};

            // Extraemos la resistencia de la pala (Por defecto 15 si es bÃ¡sica o no estÃ¡ configurada)
            const maxSwingsAllowed = weaponStats.maxFatigue || 15;

            // ==========================================
            // ðŸ›¡ï¸ CAPA 1: FATIGA DE MINERO (DINÃMICA)
            // ==========================================
            // Si pasaron mÃ¡s de 8 segundos sin excavar, el jugador recupera su energÃ­a
            if (now - (p.lastDigTime || 0) > 8000) {
                p.digFatigue = 0;
            }

            // Cooldown bÃ¡sico de 1 segundo entre palazos
            if (now - (p.lastDigTime || 0) < 1000) return;

            p.digFatigue = (p.digFatigue || 0) + 1;
            p.lastDigTime = now;

            // ðŸ›‘ EL FIX: Comparamos contra la resistencia de LA PALA, no un nÃºmero fijo
            if (p.digFatigue > maxSwingsAllowed) {
                ws.send(encode({
                    type: 'system_message',
                    text: `EstÃ¡s exhausto. ${maxSwingsAllowed} golpes seguidos. Descansa.`,
                    color: '#e74c3c'
                }));
                // EngaÃ±amos al timer poniÃ©ndolo en el futuro para forzar el descanso
                p.lastDigTime = now + 8000;
                return;
            }

            const hitX = data.hitX;
            const hitY = data.hitY;

            // ðŸ›¡ï¸ ANTI-HACK: Validar que la pala alcance la tierra
            const distToDig = Math.hypot(p.worldX - hitX, p.worldY - hitY);
            if (distToDig > 80) { // 80 pÃ­xeles es un buen margen
                return; // Ignorar si intenta minar a distancia
            }

            // ==========================================
            // ðŸ›¡ï¸ CAPA 2: TIERRA AGOTADA (ANTI-AUTO-CLICK)
            // ==========================================
            p.lastDigLocationX = p.lastDigLocationX || 0;
            p.lastDigLocationY = p.lastDigLocationY || 0;

            const distFromLastDig = Math.hypot(p.worldX - p.lastDigLocationX, p.worldY - p.lastDigLocationY);

            if (p.lastDigLocationX !== 0 && distFromLastDig < 40) {
                ws.send(encode({
                    type: 'system_message',
                    text: "Ya escarbaste todo aquÃ­. Â¡Camina hacia otro lado!",
                    color: '#e67e22'
                }));
                broadcast({ type: 'spawn_hole', x: hitX, y: hitY }, ws);
                ws.send(encode({ type: 'spawn_hole', x: hitX, y: hitY }));
                return;
            }

            // ==========================================
            // ðŸŒ LÃ“GICA NORMAL DE ZONAS Y PREMIOS
            // ==========================================
            let inDigZone = false;
            for (let z of safeZonesRAM) {
                if (z.zoneType === 'dig' && hitX >= z.xMin && hitX <= z.xMax && hitY >= z.yMin && hitY <= z.yMax) {
                    inDigZone = true;
                    break;
                }
            }

            if (!inDigZone) {
                ws.send(encode({ type: 'system_message', text: "AquÃ­ no hay tierra blanda para excavar.", color: '#e67e22' }));
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

                ws.send(encode({ type: 'system_message', text: `ðŸ’Ž Desenterraste: ${foundItem.name}!`, color: '#3498db' }));
                ws.send(encode({ type: 'inventory_update', inventory: p.inventory }));
                broadcast({ type: 'update', id: id, player: p }, ws);
            }
        }// =========================================================
        // ðŸ’Ž VENDER TODOS LOS METALES (JOYERÃA)
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
        // ðŸ’Ž VENDER METAL INDIVIDUAL
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
                ws.send(encode({ type: 'system_message', text: "ðŸ›‘ No tienes suficiente cantidad de este metal.", color: '#e74c3c' }));
                return;
            }

            const totalEarned = catalogItem.value * requestedQty;
            p.coins += totalEarned;
            existingStack.quantity -= requestedQty;

            if (existingStack.quantity <= 0) {
                p.inventory.splice(stackIndex, 1);
            }

            // Reusamos sell_success para que el cliente procese la animaciÃ³n de monedas y cierre la tienda
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

            // 2. Â¡MAGIA! Rebotamos la animaciÃ³n a TODOS los jugadores en vivo
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
                .then(() => console.log("ðŸ¦´ AnimaciÃ³n Gani guardada en la Base de Datos!"))
                .catch(err => console.error("Error guardando Gani:", err));
        }// --- NUEVO: SISTEMA DE DAÃ‘O A LA BASE DE CLANES (TURF WARS) ---
        if (data.type === 'damage_base' && isAuthenticated) {
            const shooter = players[id];
            if (!shooter) return;

            let targetBase = null;
            if (data.turfId && state.turfBases && state.turfBases[data.turfId]) {
                targetBase = state.turfBases[data.turfId];
            } else if (state.turfBases && Object.keys(state.turfBases).length > 0) {
                targetBase = Object.values(state.turfBases)[0];
            } else if (state.centralBase) {
                targetBase = state.centralBase;
            }
            if (!targetBase) return;

            const stats = WEAPONS[data.weaponId] || { damage: 10, fireRate: 300 };
            const now = Date.now();
            if (now - (shooter.lastBaseDamageTime || 0) < ((stats.fireRate || 300) - 50)) return;
            shooter.lastBaseDamageTime = now;

            const actualDamage = Number(stats.damage) || 10;
            const squadTag = shooter.squadName || (shooter.squad ? shooter.squad : (shooter.username || 'Solo'));

            if (targetBase.currentOwnerSquadId && targetBase.currentOwnerSquadId === shooter.squadName) {
                // CuraciÃ³n de la base de tu squad
                if (targetBase.hp >= targetBase.maxHp) return;
                targetBase.hp += actualDamage;
                if (targetBase.hp > targetBase.maxHp) {
                    targetBase.hp = targetBase.maxHp;
                }
            } else {
                // Ataque a la base
                targetBase.hp -= actualDamage;
                targetBase.lastHitTime = Date.now();
                if (!targetBase.damageTracker) targetBase.damageTracker = {};
                if (!targetBase.damageTracker[squadTag]) targetBase.damageTracker[squadTag] = 0;
                targetBase.damageTracker[squadTag] += actualDamage;

                if (targetBase.hp <= 0) {
                    let topSquad = squadTag;
                    let maxDamage = 0;
                    for (let sqName in targetBase.damageTracker) {
                        if (targetBase.damageTracker[sqName] > maxDamage) {
                            maxDamage = targetBase.damageTracker[sqName];
                            topSquad = sqName;
                        }
                    }

                    targetBase.currentOwnerSquadId = topSquad;
                    targetBase.hp = targetBase.maxHp;
                    targetBase.damageTracker = {};

                    console.log(`ðŸ† El Squad/Jugador [${topSquad}] ha capturado ${targetBase.name} (${targetBase.turfId})!`);

                    Turf.findOneAndUpdate(
                        { turfId: targetBase.turfId },
                        { ownerSquadName: topSquad, hp: targetBase.maxHp }
                    ).catch(err => console.error("Error guardando Turf:", err));
                }
            }

            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(encode({ type: 'base_update', base: targetBase, turfBases: state.turfBases }));
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

                    // ðŸŒŸ Mongoose-safe way to save Mixed objects ðŸŒŸ
                    user.taskProgress = players[id].taskProgress || {};
                    user.claimedTasks = players[id].claimedTasks || {};
                    user.markModified('taskProgress');
                    user.markModified('claimedTasks');

                    await user.save();
                }
            } catch (err) { console.error("AUTO LOGIN CRASH", err); ws.send(encode({ type: 'auth_error', message: 'Server crashed during login.' })); }
        }

        delete players[id];
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(encode({ type: 'left', id: id }));
            }
        });
        broadcast({ type: 'player_count', count: Object.keys(players).length });

    if (players[id] && players[id].isJailed) {
        ws.send(encode({ type: 'system_message', text: 'Tu dirección IP se encuentra bloqueada. Estás en prisión temporalmente.', color: '#e74c3c', isAlert: true, isJailAlert: true }));
    }

    });

    const BanModel3 = require('../models/Ban');
    try {
        const activeIpBan = await BanModel3.findOne({ ipAddress: clientIp, expiresAt: { $gt: new Date() } });
        if (activeIpBan) {
            players[id].isJailed = true;
            if (state.jailSpawnPos) {
                players[id].worldX = state.jailSpawnPos.x;
                players[id].worldY = state.jailSpawnPos.y;
            } else {
                players[id].worldX = 0;
                players[id].worldY = 0;
            }
        }
    } catch(err) { console.error(err); }

      // 2. FETCH WORLD DATA (From RAM Cache for ultra-fast instant connections)
    let allTiles = state.WORLD_TILES_CACHE;
    if (!allTiles || allTiles.length === 0) {
        try {
            allTiles = await Tile.find({}, { _id: 0, __v: 0 }).lean();
            state.WORLD_TILES_CACHE = allTiles;
        } catch (err) {
            console.error("Error fetching tiles from DB:", err);
            allTiles = [];
        }
    }

    // 3. TELL THE NEW GUEST WHO THEY ARE (INIT)
    ws.send(encode({
        type: 'init',
        id: id,
        playlist: GLOBAL_BGM_PLAYLIST, // ðŸ›‘ LA SOLUCIÃ“N: Le decimos quÃ© canciÃ³n debe poner apenas entre
        players: Object.fromEntries(Object.entries(players).filter(([k, v]) => !v.invisibleEnabled || k === id)),
        worldMap: allTiles,
        weaponsDB: WEAPONS,
        tilesetsDB: TILESETS,
        safeZones: safeZonesRAM, // <--- Â¡NUEVO: Enviamos los rectÃ¡ngulos de paz al jugador!
        skeleton: skeletonRAM, // <--- Â¡ESTA ES LA LÃNEA QUE FALTABA!
        centralBase: state.centralBase, // ðŸ›‘ EL FIX: AÃ±adimos la base a la memoria del cliente
        turfBases: state.turfBases, // ðŸ° TODAS las bases activas enviadas al cliente
        groundItems: groundItems, // ðŸ›‘ EL FIX: Mandar la basura a los jugadores nuevos
        trashCatalog: TRASH_CATALOG,
        masterCatalog: MASTER_CATALOG, // ðŸ“¦ EL FIX: Enviamos toda la ropa e Ã­tems
        zoneConfig: ZONE_CONFIG, // <--- ðŸ‘‡ AÃ‘ADE ESTA LÃNEA ðŸ‘‡
        ranksDB: RANKS_CACHE,
        patchNotes: PATCH_NOTES_CACHE, // ðŸ“° NUEVO: Enviamos las noticias

        // ðŸŒŸ TAREAS Y LOGROS GLOBALES ðŸŒŸ
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
    };
};

