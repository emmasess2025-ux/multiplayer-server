const mongoose = require('mongoose');

const serverConfigSchema = new mongoose.Schema({
    bgmPlaylist: { type: [String], default: [] },
    lastDailyReset: { type: Date, default: Date.now },
    lastWeeklyReset: { type: Date, default: Date.now }
});

const ServerConfig = mongoose.model('ServerConfig', serverConfigSchema);

module.exports = ServerConfig;
