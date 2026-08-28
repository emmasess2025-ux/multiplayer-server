const mongoose = require('mongoose');

const turfSchema = new mongoose.Schema({
    turfId: { type: String, required: true, unique: true },
    name: { type: String, default: "Base Central" },
    hp: { type: Number, default: 5000 },
    maxHp: { type: Number, default: 5000 },
    ownerSquadName: { type: String, default: null },
    srcIdle: { type: String, default: "" },
    srcHit: { type: String, default: "" },
    spriteOffsetX: { type: Number, default: 0 },
    spriteOffsetY: { type: Number, default: 0 },
    hitboxOffsetX: { type: Number, default: 0 },
    hitboxOffsetY: { type: Number, default: 0 },
    hitboxW: { type: Number, default: 32 },
    hitboxH: { type: Number, default: 32 },
    // 👇 CONFIGURACIÓN DE SPRITE Y ANIMACIÓN 👇
    frameWidth: { type: Number, default: 0 },   // 0 = Auto-detect
    frameHeight: { type: Number, default: 0 },  // 0 = Auto-detect
    frameCount: { type: Number, default: 0 },   // 0 = Auto-detect
    animSpeed: { type: Number, default: 0 },    // 0 = Default (150ms)
    renderScale: { type: Number, default: 1.0 },
    isHover: { type: Boolean, default: true }   // true = Flotación arriba/abajo activada
});
const Turf = mongoose.model('Turf', turfSchema);

module.exports = Turf;
