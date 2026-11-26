function isBuyerDisputeOwner(dispute, userId, userEmail) {
  const customerId = dispute?.customerId;
  const hasCustomerId = customerId != null && String(customerId).trim() !== "";
  return hasCustomerId
    ? String(customerId) === String(userId)
    : dispute?.customerEmail === userEmail;
}

function isSellerDisputeOwner(dispute, sellerId) {
  return String(dispute?.sellerId) === String(sellerId);
}

async function appendAuthenticatedDisputeReply(dispute, message, sender, senderType) {
  const cleanMessage = typeof message === "string" ? message.trim() : "";
  if (!cleanMessage || cleanMessage.length > 5000) {
    const error = new Error("Message is required and must be 5,000 characters or fewer");
    error.statusCode = 400;
    throw error;
  }
  if (["resolved", "closed"].includes(dispute.status)) {
    const error = new Error("This dispute is no longer accepting replies");
    error.statusCode = 409;
    throw error;
  }

  dispute.messages.push({ sender, senderType, message: cleanMessage });
  if (senderType === "seller") dispute.status = "seller_responded";
  await dispute.save();
  return dispute;
}

async function hasTokenSafely(token, exists, logger = console) {
  try {
    return !!(await exists({ token }));
  } catch (err) {
    logger.error("Token blacklist lookup failed; denying authentication:", err.message);
    return true;
  }
}

module.exports = {
  isBuyerDisputeOwner,
  isSellerDisputeOwner,
  appendAuthenticatedDisputeReply,
  hasTokenSafely
};
