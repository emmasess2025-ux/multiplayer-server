const WebSocket = require('ws');

module.exports = function initGameEngine(deps) {
    const { 
        wss, state, encode, decode, Tile, Blueprint, Arena, Turf, SafeZone, Rank, ZoneConfig, Skeleton, PatchNote, Task, Season, User, Counter, Feedback, Squad, ServerConfig, Item, ArgemPackage, Tileset, PM,
        add_bp_xp, isInSafeZone, broadcast, broadcastToZone
    } = deps;

    const { players, activeProjectiles, groundItems, serverWorldMap, arenasRAM, safeZonesRAM, WEAPONS, TRASH_CATALOG, METALS_CATALOG, GLOBAL_TASKS } = state;
    const TILE_SIZE = 16;
    // CHUNK_SIZE is extracted below

    // ----- EXTRACTED ENGINE CODE -----
function serverCheckCollision(x, y) {
    const hitX = 5;
    const hitY = 5;
    const offsetY = 3;
    // 👇 NUEVO: HACER LA BASE SÓLIDA (CUADRADO EXACTO) 👇
    if (state.centralBase) {
        const bx = state.centralBase.worldX + (state.centralBase.hitboxOffsetX || 0);
        const by = state.centralBase.worldY + (state.centralBase.hitboxOffsetY || 0);
        const hw = (state.centralBase.hitboxW || 32) / 2;
        const hh = (state.centralBase.hitboxH || 32) / 2;

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
    if (state.centralBase && state.centralBase.currentOwnerSquadId) {
        try {
            const ownerSquad = state.centralBase.currentOwnerSquadId;
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
    // ----- END EXTRACTED ENGINE CODE -----
    
    return {
        serverCheckCollision,
        getChunkId,
        getVisibleChunks,
        applyDamageToPlayer,
        resetRound,
        endArenaMatch
    };
};
