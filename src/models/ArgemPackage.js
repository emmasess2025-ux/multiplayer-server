const mongoose = require('mongoose');

const argemPackageSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    gemsAmount: { type: Number, required: true },
    priceString: { type: String, required: true },
    priceCents: { type: Number, required: true },
    badge: { type: String, default: "" },
    color: { type: String, default: "#9b59b6" }
});
const ArgemPackage = mongoose.model('ArgemPackage', argemPackageSchema);

module.exports = ArgemPackage;
