const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema({
    gameId: { type: String, required: true },
    category: { type: String, default: 'Ideas' }, // 'Ideas', 'Bugs & Errors', 'Help'
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    status: { type: String, default: 'pending' } // 'pending', 'reviewed', 'rewarded'
});
const Feedback = mongoose.model('Feedback', feedbackSchema);

module.exports = Feedback;
