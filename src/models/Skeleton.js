const mongoose = require('mongoose');

const skeletonSchema = new mongoose.Schema({
    anchors: { type: Object, default: {} },
    handTile: { type: Object, default: { x: 13, y: 0 } } // <--- NUEVO
});
const Skeleton = mongoose.model('Skeleton', skeletonSchema);

module.exports = Skeleton;
