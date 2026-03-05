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
        email: { type: String, required: true, unique: true }, // NEW: Email is the unique login
        username: { type: String, required: true },            // CHANGED: No longer unique!
        password: { type: String, required: true }, 
        token: { type: String, default: "" }, 
        worldX: { type: Number, default: 0 },
        worldY: { type: Number, default: 0 },
        inventory: { type: Array, default: [] },
        equippedWeapon: { type: String, default: "none" },
        friends: { type: Array, default: [] } // Stores the emails or IDs of friends
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

        // 3. HANDLE PROFILE EDITS
        if (data.type === 'change_username' && isAuthenticated) {
            try {
                await User.findOneAndUpdate({ email: currentUser }, { username: data.newUsername });
                players[id].username = data.newUsername;
                
                // Move the closing bracket here too!
                 broadcast({ type: 'update', id: id, player: players[id] }, ws);
                ws.send(JSON.stringify({ type: 'profile_updated', username: data.newUsername }));
            } catch(err) { console.error(err); }
        }

        if (data.type === 'add_friend' && isAuthenticated) {
            try {
                // 1. Add them to YOUR database
                await User.findOneAndUpdate(
                    { email: currentUser }, 
                    { $addToSet: { friends: data.friendName } } 
                );
                ws.send(JSON.stringify({ type: 'friend_added', friendName: data.friendName }));

                // --- THE LOOP FIX ---
                // 2. Only ping the lobby if this is a NEW request, not a reply!
                if (!data.isReply) {
                    broadcast({ 
                        type: 'friend_request', 
                        targetUsername: data.friendName,     
                        senderUsername: players[id].username, 
                        senderFrameX: players[id].frameX,     
                        senderFrameY: players[id].frameY
                    }, ws);
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

        // 4. HANDLE AUTO-LOGIN
        if (data.type === 'auto_login') {
            try {
                // Find the user by their secret token
                const user = await User.findOne({ token: data.token });
                
                if (!user) {
                    return ws.send(JSON.stringify({ type: 'auth_error', message: 'Session expired. Please log in again.' }));
                }

                isAuthenticated = true;
                currentUser = user.email; // We track the session by email now!

                // Pass their data to the lobby memory
                players[id].email = user.email;
                players[id].username = user.username;
                players[id].worldX = user.worldX;
                players[id].worldY = user.worldY;
                players[id].friends = user.friends; // Don't forget the friends list!

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
                    { email: currentUser }, // <--- FIX: Search by Email!
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
