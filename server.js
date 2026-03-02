const WebSocket = require('ws');

// Use the port Render gives us, or default to 8080 for local testing
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// This object acts as the server's memory. It holds every player's current state.
const players = {};

wss.on('connection', (ws) => {
    // 1. THE HANDSHAKE: Generate a random ID for the new player
    const playerId = Math.random().toString(36).substring(2, 9);
    console.log(`Player connected: ${playerId}`);

    // Add them to the server's memory with default coordinates
    players[playerId] = { 
        worldX: 0,       // Changed from x: 0
        worldY: 0,       // Changed from y: 0
        frameX: 0, 
        frameY: 0, 
        isMoving: false, 
        message: "",
        messageTimer: 0  // Added so chat bubbles don't crash
    };

    // Send the new player their assigned ID and the current map of all other players
    ws.send(JSON.stringify({ 
        type: 'init', 
        id: playerId, 
        players: players 
    }));

    // Tell everyone ELSE in the room that a new player just spawned in
    broadcast({ 
        type: 'joined', 
        id: playerId, 
        player: players[playerId] 
    }, ws);

    // 2. THE RELAY: Listen for incoming movement/chat data from this phone
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'update') {
                // Overwrite the server's memory with the player's new location/animation
                players[playerId] = data.player;

                // Instantly broadcast this exact update to every other phone
                broadcast({ 
                    type: 'update', 
                    id: playerId, 
                    player: data.player 
                }, ws);
            }
        } catch (e) {
            console.error("Failed to parse message", e);
        }
    });

    // 3. THE DISCONNECT: When a player closes Safari/Chrome
    ws.on('close', () => {
        console.log(`Player disconnected: ${playerId}`);
        delete players[playerId]; // Erase them from memory
        
        // Tell all remaining phones to delete this sprite from their screens
        broadcast({ 
            type: 'left', 
            id: playerId 
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