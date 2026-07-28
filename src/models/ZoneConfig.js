const mongoose = require('mongoose');

const zoneConfigSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true }, // ej: 'safe', 'trash', 'npc'
    name: { type: String, required: true },
    icon: { type: String, default: "❓" },
    colorBorder: { type: String, default: "white" },
    colorFill: { type: String, default: "rgba(255,255,255,0.2)" }
});

const ZoneConfig = mongoose.model('ZoneConfig', zoneConfigSchema);

module.exports = ZoneConfig;
