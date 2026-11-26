// Device Health Passport routes.
// A factory, so the existing auth middleware and models from server.js are reused, not copied.
module.exports = function createPassportRouter({ express, sellerAuth, Product, DevicePassport }) {
  const router = express.Router();

  const GRADES = ["new", "A", "B", "C", "D"];
  const isId = (v) => /^[a-f\d]{24}$/i.test(String(v));
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

  function cleanBody(body) {
    const b = body && typeof body === "object" ? body : {};
    const set = {};

    if (b.deviceInfo && typeof b.deviceInfo === "object") {
      set.deviceInfo = {
        brand: str(b.deviceInfo.brand, 60),
        model: str(b.deviceInfo.model, 60),
        storage: str(b.deviceInfo.storage, 30),
        color: str(b.deviceInfo.color, 30)
      };
    }

    if (b.cosmetic && typeof b.cosmetic === "object") {
      const grade = str(b.cosmetic.grade, 5);
      if (grade && !GRADES.includes(grade)) return { error: "Cosmetic grade must be new, A, B, C or D" };
      set.cosmetic = { grade, notes: str(b.cosmetic.notes, 300) };
    }

    if (Array.isArray(b.repairs)) {
      set.repairs = b.repairs.slice(0, 10)
        .map(r => ({ part: str(r && r.part, 60), note: str(r && r.note, 200) }))
        .filter(r => r.part);
    }

    if (Array.isArray(b.knownFaults)) {
      set.knownFaults = b.knownFaults.slice(0, 10).map(f => str(f, 120)).filter(Boolean);
    }

    if (b.battery === null) {
      set.battery = { healthPercent: null, source: "seller_reported", reportedAt: null };
    } else if (b.battery && typeof b.battery === "object") {
      const raw = b.battery.healthPercent;
      if (raw === null || raw === undefined || raw === "") {
        set.battery = { healthPercent: null, source: "seller_reported", reportedAt: null };
      } else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          return { error: "Battery health must be a whole number from 1 to 100" };
        }
        set.battery = { healthPercent: n, source: "seller_reported", reportedAt: new Date() };
      }
    }

    return { set, publish: typeof b.publish === "boolean" ? b.publish : undefined };
  }

  // Never expose the IMEI hash; show only the last 4 digits.
  function strip(doc) {
    const { __v, imei, ...rest } = doc;
    return { ...rest, imei: imei && imei.last4 ? { last4: imei.last4 } : null };
  }

  function sellerView(doc) {
    if (!doc) return null;
    const imei = doc.imei;
    return {
      productId: String(doc.productId),
      published: doc.published === true,
      deviceInfo: doc.deviceInfo || {},
      imei: imei && imei.last4 ? { last4: imei.last4 } : null,
      checks: doc.checks || [],
      battery: doc.battery || { healthPercent: null },
      cosmetic: doc.cosmetic || {},
      repairs: doc.repairs || [],
      knownFaults: doc.knownFaults || [],
      sellerReportedAt: doc.sellerReportedAt || null,
      updatedAt: doc.updatedAt || null
    };
  }

  function publicView(doc) {
    const d = strip(doc);
    return {
      productId: String(d.productId),
      deviceInfo: d.deviceInfo || {},
      imei: d.imei,
      checks: d.checks || [],
      battery: d.battery && d.battery.healthPercent ? d.battery : null,
      cosmetic: d.cosmetic || {},
      repairs: d.repairs || [],
      knownFaults: d.knownFaults || [],
      sellerReportedAt: d.sellerReportedAt || null,
      updatedAt: d.updatedAt || null
    };
  }

  // Same ownership rule the existing seller product routes use.
  async function ownProduct(req, res) {
    const id = req.params.productId;
    if (!isId(id)) { res.status(400).json({ error: "Invalid product id" }); return null; }
    const product = await Product.findById(id).select("vendorId").lean();
    if (!product) { res.status(404).json({ error: "Product not found" }); return null; }
    if (String(product.vendorId) !== String(req.seller.id)) {
      res.status(403).json({ error: "Not your product" });
      return null;
    }
    return product;
  }

  // Public: published passports only.
  router.get("/product/:productId", async (req, res) => {
    try {
      if (!isId(req.params.productId)) return res.status(400).json({ error: "Invalid product id" });
      const doc = await DevicePassport.findOne({ productId: req.params.productId, published: true }).lean();
      if (!doc) return res.status(404).json({ error: "No passport for this product" });
      res.json({ success: true, passport: publicView(doc) });
    } catch (err) {
      console.error("Passport read failed:", err.message);
      res.status(500).json({ error: "Could not load the passport" });
    }
  });

  // Seller: their own passport, including drafts.
  router.get("/mine/:productId", sellerAuth, async (req, res) => {
    try {
      const product = await ownProduct(req, res);
      if (!product) return;
      const doc = await DevicePassport.findOne({ productId: req.params.productId }).lean();
      res.json({ success: true, passport: sellerView(doc) });
    } catch (err) {
      console.error("Passport read failed:", err.message);
      res.status(500).json({ error: "Could not load the passport" });
    }
  });

  // Seller: create or update their own passport. Only whitelisted, seller-reported fields.
  router.put("/product/:productId", sellerAuth, async (req, res) => {
    try {
      const product = await ownProduct(req, res);
      if (!product) return;

      const cleaned = cleanBody(req.body);
      if (cleaned.error) return res.status(400).json({ error: cleaned.error });

      const productId = req.params.productId;
      const sellerId = String(req.seller.id);
      const existing = await DevicePassport.findOne({ productId }).lean();

      if (existing && String(existing.sellerId) !== sellerId) {
        return res.status(403).json({ error: "This passport belongs to another seller" });
      }

      const merged = { ...(existing || {}), ...cleaned.set };
      if (cleaned.publish === true &&
          !(merged.deviceInfo && merged.deviceInfo.brand && merged.deviceInfo.model &&
            merged.cosmetic && merged.cosmetic.grade)) {
        return res.status(400).json({ error: "Add the phone brand, model and a cosmetic grade before publishing" });
      }

      const set = { ...cleaned.set, sellerReportedAt: new Date() };
      if (cleaned.publish !== undefined) set.published = cleaned.publish;

      const saved = await DevicePassport.findOneAndUpdate(
        { productId, sellerId },
        { $set: set, $setOnInsert: { sellerId } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
      ).lean();

      res.json({ success: true, passport: sellerView(saved) });
    } catch (err) {
      console.error("Passport save failed:", err.message);
      res.status(500).json({ error: "Could not save the passport" });
    }
  });

  return router;
};
