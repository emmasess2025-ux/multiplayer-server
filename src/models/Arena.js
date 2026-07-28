const mongoose = require('mongoose');

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

module.exports = Arena;
