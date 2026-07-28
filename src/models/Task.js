const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
    taskId: { type: String, required: true, unique: true }, // e.g., 'daily_login', 'squad_10_hours'
    title: { type: String, required: true },
    description: { type: String },

    category: { type: String, enum: ['daily', 'squad', 'milestone', 'event', 'battle_pass'], default: 'daily' },
    requirementType: { type: String, enum: ['login', 'play_hours', 'kills', 'elo'], default: 'login' },
    requirementValue: { type: Number, required: true },

    rewardType: { type: String, enum: ['coins', 'item'], default: 'coins' },
    rewardValue: { type: mongoose.Schema.Types.Mixed, required: true },
    bpXpReward: { type: Number, default: 100 }, // NUEVO: Premio de Pase de Batalla

    isRepeatable: { type: Boolean, default: false },
    resetIntervalMs: { type: Number, default: 0 } // 86400000 for daily
});
const Task = mongoose.model('Task', taskSchema);

module.exports = Task;
