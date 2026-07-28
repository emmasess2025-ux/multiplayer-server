const mongoose = require('mongoose');

const blueprintSchema = new mongoose.Schema({
    name: { type: String, required: true },
    w: { type: Number, required: true },
    h: { type: Number, required: true },
    isMultiLayer: { type: Boolean, default: true },
    multiTiles: [{
        x: Number, y: Number, l: Number, tileId: Number,
        hasCollision: Boolean, isSit: Boolean, triggerType: String,
        destX: Number, destY: Number, itemId: Number, rotation: Number
    }]
});
const Blueprint = mongoose.model('Blueprint', blueprintSchema);

module.exports = Blueprint;
