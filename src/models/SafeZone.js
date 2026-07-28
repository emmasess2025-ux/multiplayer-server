const mongoose = require('mongoose');

const safeZoneSchema = new mongoose.Schema({
    name: { type: String, required: true },
    zoneType: { type: String, default: 'safe' }, // 'safe', 'trash', 'turf', etc.
    xMin: { type: Number, required: true },
    xMax: { type: Number, required: true },
    yMin: { type: Number, required: true },
    yMax: { type: Number, required: true },
    // 🏴 TURF: punto de spawn al que van los que mueren dentro de esta zona
    spawnX: { type: Number, default: null },
    spawnY: { type: Number, default: null }
});
const SafeZone = mongoose.model('SafeZone', safeZoneSchema);

module.exports = SafeZone;
