const mongoose = require('mongoose');

const patchNoteSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: { type: String, required: true },
    version: { type: String, default: "1.0" },
    date: { type: Date, default: Date.now }
});
const PatchNote = mongoose.model('PatchNote', patchNoteSchema);

module.exports = PatchNote;
