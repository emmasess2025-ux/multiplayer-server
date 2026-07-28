const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    category: { type: String, required: true },
    name: { type: String, required: true },
    src: { type: String, required: true },
    price: { type: Number, default: 0 },
    stats: { type: Object, default: {} },
    drawConfig: { type: Object, default: {} },

    // 🔊 NUEVO: DICCIONARIO DE AUDIO
    audio: {
        type: Object,
        default: {
            use: null,     // Sonido al usar/disparar/swing
            reload: null,  // Sonido de recarga
            equip: null    // Sonido genérico al equiparlo en la mano
        }
    }
});

const Item = mongoose.model('Item', itemSchema);

module.exports = Item;
