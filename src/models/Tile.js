const mongoose = require('mongoose');

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

module.exports = Tile;
