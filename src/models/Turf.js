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
    // 👇 NUEVO: ANCHO Y ALTO DEL CUADRADO FÍSICO 👇
    hitboxW: { type: Number, default: 32 },
    hitboxH: { type: Number, default: 32 }
});
const Turf = mongoose.model('Turf', turfSchema);

module.exports = Turf;
