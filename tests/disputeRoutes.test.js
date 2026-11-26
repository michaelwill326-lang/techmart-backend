const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const createDisputeReplyRouter = require("../routes/disputeReplies");

async function setup({ disputeExists = true, buyerExists = true, sellerExists = true } = {}) {
  const dispute = {
    _id: "dispute-1",
    customerId: "buyer-1",
    customerEmail: "buyer@example.com",
    sellerId: "seller-1",
    status: "open",
    messages: [],
    async save() {}
  };

  const app = express();
  app.use(express.json());
  app.use(createDisputeReplyRouter({
    auth(req, res, next) {
      req.user = { id: "buyer-1" };
      next();
    },
    sellerAuth(req, res, next) {
      req.seller = { id: "seller-1" };
      next();
    },
    adminOnly(req, res, next) {
      req.user = { id: "admin-1" };
      next();
    },
    User: {
      async findById(id) {
        if (id === "buyer-1" && buyerExists) return { email: "buyer@example.com", name: "Buyer" };
        if (id === "admin-1") return { email: "admin@example.com", name: "Admin" };
        return null;
      }
    },
    Seller: {
      async findById() {
        return sellerExists ? { _id: "seller-1", storeName: "Test Store" } : null;
      }
    },
    Dispute: {
      async findById() {
        return disputeExists ? dispute : null;
      }
    }
  }));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    dispute,
    async post(path, body) {
      return fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    },
    async close() {
      await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  };
}

test("buyer can reply to their own dispute", async () => {
  const ctx = await setup();
  try {
    const response = await ctx.post("/api/disputes/dispute-1/reply", { message: "  Please help  " });
    assert.equal(response.status, 200);
    assert.equal(ctx.dispute.messages[0].message, "Please help");
    assert.equal(ctx.dispute.messages[0].senderType, "customer");
  } finally { await ctx.close(); }
});

test("buyer cannot reply to another buyer's dispute", async () => {
  const ctx = await setup();
  ctx.dispute.customerId = "another-buyer";
  try {
    const response = await ctx.post("/api/disputes/dispute-1/reply", { message: "Hello" });
    assert.equal(response.status, 403);
    assert.equal(ctx.dispute.messages.length, 0);
  } finally { await ctx.close(); }
});

test("seller can reply to a dispute belonging to their store", async () => {
  const ctx = await setup();
  try {
    const response = await ctx.post("/api/seller/disputes/dispute-1/reply", { message: "We will investigate" });
    assert.equal(response.status, 200);
    assert.equal(ctx.dispute.messages[0].sender, "Test Store");
    assert.equal(ctx.dispute.status, "seller_responded");
  } finally { await ctx.close(); }
});

test("seller cannot reply to another store's dispute", async () => {
  const ctx = await setup();
  ctx.dispute.sellerId = "another-seller";
  try {
    const response = await ctx.post("/api/seller/disputes/dispute-1/reply", { message: "Hello" });
    assert.equal(response.status, 403);
    assert.equal(ctx.dispute.messages.length, 0);
  } finally { await ctx.close(); }
});

test("admin can reply to an existing dispute", async () => {
  const ctx = await setup();
  try {
    const response = await ctx.post("/api/admin/disputes/dispute-1/reply", { message: "Reviewed" });
    assert.equal(response.status, 200);
    assert.equal(ctx.dispute.messages[0].senderType, "admin");
  } finally { await ctx.close(); }
});

test("reply routes return 404 when dispute does not exist", async () => {
  const ctx = await setup({ disputeExists: false });
  try {
    const response = await ctx.post("/api/disputes/missing/reply", { message: "Hello" });
    assert.equal(response.status, 404);
  } finally { await ctx.close(); }
});

test("reply routes reject empty messages", async () => {
  const ctx = await setup();
  try {
    const response = await ctx.post("/api/disputes/dispute-1/reply", { message: "  " });
    assert.equal(response.status, 400);
    assert.equal(ctx.dispute.messages.length, 0);
  } finally { await ctx.close(); }
});
