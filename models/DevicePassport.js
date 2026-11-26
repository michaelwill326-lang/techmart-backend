const mongoose = require("mongoose");

const SOURCES = ["provider_lookup", "browser_test", "seller_reported", "ai_estimate", "techmart_inspected"];
const STATUSES = ["pass", "fail", "unknown", "not_checked"];

const checkSchema = new mongoose.Schema({
  key: { type: String, required: true, maxlength: 40 },
  label: { type: String, required: true, maxlength: 80 },
  status: { type: String, enum: STATUSES, default: "not_checked" },
  source: { type: String, enum: SOURCES, required: true },
  detail: { type: String, default: "", maxlength: 300 },
  checkedAt: { type: Date, default: Date.now }
}, { _id: false });

const passportSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, unique: true },
  sellerId: { type: String, required: true, index: true },
  published: { type: Boolean, default: false },
  deviceInfo: {
    brand: { type: String, default: "", maxlength: 60 },
    model: { type: String, default: "", maxlength: 60 },
    storage: { type: String, default: "", maxlength: 30 },
    color: { type: String, default: "", maxlength: 30 }
  },
  // Filled by the provider lookup in a later step. Never store the full IMEI.
  imei: {
    last4: { type: String, match: /^\d{4}$/ },
    hash: { type: String, select: false }
  },
  checks: { type: [checkSchema], default: [] },
  battery: {
    healthPercent: { type: Number, min: 1, max: 100, default: null },
    source: { type: String, enum: SOURCES, default: "seller_reported" },
    reportedAt: { type: Date, default: null }
  },
  cosmetic: {
    grade: { type: String, enum: ["new", "A", "B", "C", "D", ""], default: "" },
    notes: { type: String, default: "", maxlength: 300 }
  },
  repairs: {
    type: [{ part: { type: String, maxlength: 60 }, note: { type: String, maxlength: 200, default: "" }, _id: false }],
    default: []
  },
  knownFaults: { type: [{ type: String, maxlength: 120 }], default: [] },
  sellerReportedAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.models.DevicePassport || mongoose.model("DevicePassport", passportSchema);
