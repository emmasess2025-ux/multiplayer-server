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
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, 
    token: { type: String, default: "" }, // <--- ADD THIS LINE
    worldX: { type: Number, default: 0 },
    worldY: { type: Number, default: 0 },
    inventory: { type: Array, default: [] },
    equippedWeapon: { type: String, default: "none" },
    friends: { type: Array, default: [] }
});

const User = mongoose.model('User', userSchema);

// Use the port Render gives us, or default to 8080 for local testing
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// This object acts as the server's memory. It holds every player's current state.
const players = {};

// --- WEBSOCKET LOGIC ---
wss.on('connection', async (ws) => {
    const id = Math.random().toString(36).substring(2, 9);
    
    let isAuthenticated = false;
    // Generate a random guest name like "Guest_482"
    let currentUser = `Guest_${Math.floor(Math.random() * 1000)}`; 

    // 1. INSTANTLY SPAWN THEM AS A GUEST
    players[id] = {
        username: currentUser, 
        worldX: 0, worldY: 0,
        frameX: 0, frameY: 0,
        isMoving: false, message: "", messageTimer: 0, isTyping: false
    };

// 2. FETCH WORLD DATA
    const allTiles = await Tile.find({});

    // 3. TELL THE NEW GUEST WHO THEY ARE (INIT)
    ws.send(JSON.stringify({ 
        type: 'init', 
        id: id, 
        players: players, 
        worldMap: allTiles 
    }));
        
    // 4. NOW TELL THE LOBBY A GUEST HAS ARRIVED
    wss.clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'joined', id: id, player: players[id] }));
        }
    });

    ws.on('message', async (message) => {
        const data = JSON.parse(message);

        // 1. HANDLE REGISTRATION
        if (data.type === 'register') {
            try {
                // Check if the username is already taken
                const existingUser = await User.findOne({ username: data.username });
                if (existingUser) {
                    return ws.send(JSON.stringify({ type: 'auth_error', message: 'Username already taken' }));
                }

                // Scramble the password before saving it to Atlas!
                const hashedPassword = await bcrypt.hash(data.password, 10);

                // Build the new player
                const newUser = new User({
                    username: data.username,
                    password: hashedPassword
                });
                await newUser.save();

                ws.send(JSON.stringify({ type: 'register_success', message: 'Account created! You can now log in.' }));
            } catch (err) {
                console.error(err);
                ws.send(JSON.stringify({ type: 'auth_error', message: 'Server error during registration.' }));
            }
        }

// 2. HANDLE LOGIN
        if (data.type === 'login') {
            try {
                const user = await User.findOne({ username: data.username });
                if (!user) return ws.send(JSON.stringify({ type: 'auth_error', message: 'User not found' }));
                
                const isMatch = await bcrypt.compare(data.password, user.password);
                if (!isMatch) return ws.send(JSON.stringify({ type: 'auth_error', message: 'Incorrect password' }));

                // GENERATE A SECURE SESSION TOKEN AND SAVE IT TO MONGODB
                const newToken = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
                user.token = newToken;
                await user.save();

                isAuthenticated = true;
                currentUser = user.username;

                players[id].username = user.username;
                players[id].worldX = user.worldX;
                players[id].worldY = user.worldY;

                // Send the token back to the browser so it can save it!
                ws.send(JSON.stringify({ type: 'login_success', player: players[id], token: newToken }));
                
                wss.clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'update', id: id, player: players[id] }));
                    }
                });
            } catch (err) { console.error(err); }
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
                
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'tile_update', x: data.x, y: data.y, l: data.l, tileId: data.tileId
                        }));
                    }
                });
            } catch (err) { console.error('Tile Save Error:', err); }
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

        // --- NEW: HANDLE AUTO-LOGIN BEHIND THE SCENES ---
        if (data.type === 'auto_login') {
            try {
                // Look for the VIP token in the database
                const user = await User.findOne({ token: data.token });
                
                // If the token is fake or empty, just ignore them (they stay a Guest)
                if (!user || data.token === "") return; 

                // It's a match! Log them in silently.
                isAuthenticated = true;
                currentUser = user.username;

                players[id].username = user.username;
                players[id].worldX = user.worldX;
                players[id].worldY = user.worldY;

                // Tell their browser they successfully auto-logged in
                ws.send(JSON.stringify({ type: 'login_success', player: players[id], token: user.token }));
                
                // Announce their true name and location to the lobby
                wss.clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'update', id: id, player: players[id] }));
                    }
                });
            } catch (err) { console.error(err); }
        }

        // 3. ALLOW GUESTS TO MOVE (Removed the isAuthenticated check!)
        if (data.type === 'update') {
            players[id] = data.player; 
            wss.clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'update', id: id, player: players[id] }));
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
                    { username: currentUser },
                    { worldX: players[id].worldX, worldY: players[id].worldY }
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

console.log(`WebSocket server running on port ${PORT}`);
