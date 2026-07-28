const mongoose = require('mongoose');

const serverConfigSchema = new mongoose.Schema({
    bgmPlaylist: { type: [String], default: [] }
});
const ServerConfig = mongoose.model('ServerConfig', serverConfigSchema);

module.exports = ServerConfig;
