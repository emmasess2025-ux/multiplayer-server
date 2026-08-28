const mongoose = require('mongoose');

const BanSchema = new mongoose.Schema({
    accountId: { type: String, required: true },
    ipAddress: { type: String, default: null },
    adminId: { type: String, required: true },
    reasonType: { type: String, default: 'Otro' },
    description: { type: String, default: '' },
    durationMinutes: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Ban', BanSchema);
