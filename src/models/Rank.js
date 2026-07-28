const mongoose = require('mongoose');

const rankSchema = new mongoose.Schema({
    name: { type: String, required: true },
    minElo: { type: Number, required: true },
    src: { type: String, required: true } // La imagen 32x48
});
const Rank = mongoose.model('Rank', rankSchema);

module.exports = Rank;
