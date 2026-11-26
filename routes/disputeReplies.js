const express = require("express");
const {
  isBuyerDisputeOwner,
  isSellerDisputeOwner,
  appendAuthenticatedDisputeReply
} = require("../utils/securityHelpers");

module.exports = function createDisputeReplyRouter({
  auth, sellerAuth, adminOnly, User, Seller, Dispute
}) {
  const router = express.Router();

  router.post("/api/disputes/:id/reply", auth, async (req, res) => {
    try {
      const user = await User.findById(req.user.id);
      if (!user) return res.status(401).json({ error: "User account not found" });

      const dispute = await Dispute.findById(req.params.id);
      if (!dispute) return res.status(404).json({ error: "Dispute not found" });
      if (!isBuyerDisputeOwner(dispute, req.user.id, user.email)) {
        return res.status(403).json({ error: "Not your dispute" });
      }

      const updated = await appendAuthenticatedDisputeReply(
        dispute, req.body.message, user.name || user.email, "customer"
      );
      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(err.statusCode || 500).json({
        error: err.statusCode ? err.message : "Failed to reply to dispute"
      });
    }
  });

  router.post("/api/seller/disputes/:id/reply", sellerAuth, async (req, res) => {
    try {
      const seller = await Seller.findById(req.seller.id);
      if (!seller) return res.status(401).json({ error: "Seller account not found" });

      const dispute = await Dispute.findById(req.params.id);
      if (!dispute) return res.status(404).json({ error: "Dispute not found" });
      if (!isSellerDisputeOwner(dispute, seller._id)) {
        return res.status(403).json({ error: "This dispute does not belong to your store" });
      }

      const updated = await appendAuthenticatedDisputeReply(
        dispute, req.body.message, seller.storeName || seller.name || "Seller", "seller"
      );
      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(err.statusCode || 500).json({
        error: err.statusCode ? err.message : "Failed to reply to dispute"
      });
    }
  });

  router.post("/api/admin/disputes/:id/reply", adminOnly, async (req, res) => {
    try {
      const admin = await User.findById(req.user.id);
      if (!admin) return res.status(401).json({ error: "Admin account not found" });

      const dispute = await Dispute.findById(req.params.id);
      if (!dispute) return res.status(404).json({ error: "Dispute not found" });

      const updated = await appendAuthenticatedDisputeReply(
        dispute, req.body.message, admin.name || admin.email || "TechMart Admin", "admin"
      );
      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(err.statusCode || 500).json({
        error: err.statusCode ? err.message : "Failed to reply to dispute"
      });
    }
  });

  return router;
};
