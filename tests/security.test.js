const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isBuyerDisputeOwner,
  isSellerDisputeOwner,
  appendAuthenticatedDisputeReply,
  hasTokenSafely
} = require("../utils/securityHelpers");

test("buyer owns dispute when customer ID matches", () => {
  assert.equal(isBuyerDisputeOwner(
    { customerId: "buyer-1", customerEmail: "buyer@example.com" },
    "buyer-1",
    "other@example.com"
  ), true);
});

test("legacy dispute without customer ID falls back to email", () => {
  assert.equal(isBuyerDisputeOwner(
    { customerId: "", customerEmail: "buyer@example.com" },
    "buyer-1",
    "buyer@example.com"
  ), true);
});

test("different customer ID denies access even if email matches", () => {
  assert.equal(isBuyerDisputeOwner(
    { customerId: "buyer-2", customerEmail: "buyer@example.com" },
    "buyer-1",
    "buyer@example.com"
  ), false);
});

test("seller ownership requires matching seller ID", () => {
  assert.equal(isSellerDisputeOwner({ sellerId: "seller-1" }, "seller-1"), true);
  assert.equal(isSellerDisputeOwner({ sellerId: "seller-2" }, "seller-1"), false);
});

test("reply trims message, appends sender and saves dispute", async () => {
  const dispute = {
    status: "open",
    messages: [],
    saved: false,
    async save() { this.saved = true; }
  };

  await appendAuthenticatedDisputeReply(dispute, "  Please help  ", "Buyer", "customer");

  assert.deepEqual(dispute.messages, [
    { sender: "Buyer", senderType: "customer", message: "Please help" }
  ]);
  assert.equal(dispute.saved, true);
  assert.equal(dispute.status, "open");
});

test("seller reply updates dispute status", async () => {
  const dispute = {
    status: "open",
    messages: [],
    async save() {}
  };

  await appendAuthenticatedDisputeReply(dispute, "Reply", "Store", "seller");
  assert.equal(dispute.status, "seller_responded");
});

test("empty reply is rejected", async () => {
  const dispute = { status: "open", messages: [], async save() {} };
  await assert.rejects(
    appendAuthenticatedDisputeReply(dispute, "   ", "Buyer", "customer"),
    error => error.statusCode === 400
  );
});

test("reply over 5,000 characters is rejected", async () => {
  const dispute = { status: "open", messages: [], async save() {} };
  await assert.rejects(
    appendAuthenticatedDisputeReply(dispute, "x".repeat(5001), "Buyer", "customer"),
    error => error.statusCode === 400
  );
});

test("resolved and closed disputes reject replies", async () => {
  for (const status of ["resolved", "closed"]) {
    const dispute = { status, messages: [], async save() {} };
    await assert.rejects(
      appendAuthenticatedDisputeReply(dispute, "Reply", "Buyer", "customer"),
      error => error.statusCode === 409
    );
  }
});

test("blacklist lookup returns true for a revoked token", async () => {
  assert.equal(await hasTokenSafely("revoked", async () => ({ _id: "entry" })), true);
});

test("blacklist lookup returns false for a token not found", async () => {
  assert.equal(await hasTokenSafely("valid", async () => null), false);
});

test("blacklist database failure denies authentication", async () => {
  const logged = [];
  const logger = { error: (...args) => logged.push(args) };

  const result = await hasTokenSafely(
    "unknown",
    async () => { throw new Error("database unavailable"); },
    logger
  );

  assert.equal(result, true);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /denying authentication/);
});
