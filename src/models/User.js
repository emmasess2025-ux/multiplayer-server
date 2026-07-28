const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    password: { type: String, required: true },
    token: { type: String, default: "" },
    worldX: { type: Number, default: 0 },
    worldY: { type: Number, default: 0 },

    inventory: { type: [mongoose.Schema.Types.Mixed], default: [] },
    equippedWeapon: { type: String, default: "none" },
    hotbar: { type: Array, default: ["none", "none", "none"] },
    quickSwaps: { type: Array, default: [] },
    equipped: { // 👕 EL WARDROBE
        hands: { type: String, default: 'none' },
        head: { type: String, default: 'head_default' },
        body: { type: String, default: 'body_default' },
        hat: { type: String, default: 'none' } // 🎩 NUEVO: Espacio para sombreros
    },
    friends: { type: Array, default: [] },

    // --- NUEVO: BATTLE PASS TRACKING ---
    bpSeasonId: { type: String, default: "" }, // La temporada actual del jugador
    bpXP: { type: Number, default: 0 },        // Experiencia ganada en la temporada actual
    bpPremium: { type: Boolean, default: false }, // ¿Compró el pase premium?
    bpClaimedFree: { type: [Number], default: [] }, // Niveles reclamados gratis
    bpClaimedPremium: { type: [Number], default: [] }, // Niveles reclamados premium

    // --- NUEVO: SISTEMA DE ECONOMÍA ---
    coins: { type: Number, default: 0 },
    gems: { type: Number, default: 0 }, // Argems Premium Currency
    // 👇 NUEVO: ESTADÍSTICAS DE COMBATE 👇
    elo: { type: Number, default: 1000 },
    kills: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    // 👇 NUEVO: GUARDADO DE SALUD (ANTI-COMBAT LOGGING) 👇
    hp: { type: Number, default: 100 },
    isDead: { type: Boolean, default: false },
    // --- NUEVO: SISTEMA DE ROLES ---
    role: { type: String, default: 'player' }, // Todos nacen como 'player' por defecto, pero podrías tener 'admin', 'moderator', etc. y manejar permisos en el futuro.
    // --- NUEVO: IDENTIFICADOR ÚNICO (EJ: A1000) ---
    gameId: { type: String, unique: true },
    // --- NUEVO: TUTORIAL ---
    hasSeenTutorial: { type: Boolean, default: false },
    // ... tus otros campos (coins, friends, etc)
    squad: { type: mongoose.Schema.Types.ObjectId, ref: 'Squad', default: null }, // <--- NUEVO

    // --- NUEVO: SISTEMA DE TAREAS Y LOGROS ---
    taskProgress: { type: mongoose.Schema.Types.Mixed, default: {} },
    claimedTasks: { type: mongoose.Schema.Types.Mixed, default: {} }
});

const User = mongoose.model('User', userSchema);

module.exports = User;
