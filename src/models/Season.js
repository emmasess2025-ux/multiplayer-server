const mongoose = require('mongoose');

const seasonSchema = new mongoose.Schema({
    seasonId: { type: String, required: true, unique: true }, // ej: 'season_1'
    name: { type: String, required: true }, // ej: 'Neon Origins'
    isActive: { type: Boolean, default: false },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    costArgems: { type: Number, default: 500 },
    rewards: { type: [mongoose.Schema.Types.Mixed], default: [] }
    /* Formato esperado en rewards:
       [{ level: 1, xpRequired: 1000, free: { type: 'item', id: 'hat_cap' }, premium: { type: 'argems', amount: 50 } }, ...]
    */
});
const Season = mongoose.model('Season', seasonSchema);

module.exports = Season;
