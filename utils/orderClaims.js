// Replaces free-text AI replies that claim an order or payment succeeded.
// Real order confirmations come only from the checkout routes, after the order exists.
const CLAIM_PATTERNS = [
  /\byour\s+(order|purchase|payment)\b[^.!?\n]{0,40}\b(has been|was|is now)\s+(placed|confirmed|complete|completed|successful|received|processed)\b/i,
  /\b(order|purchase|payment)\s+(placed|confirmed|successful|complete|completed)\s*[!.✅]/i,
  /\bi(?:'|’)ve\s+(placed|ordered|purchased|bought)\b/i,
  /\bi\s+have\s+(placed|ordered|purchased|bought|paid)\b/i,
  /\bsuccessfully\s+(placed|ordered|purchased|paid)\b/i,
  /\bpayment\s+(was\s+|has\s+been\s+)?(successful|received|confirmed)\b/i,
];
const DENIAL = /(no order has been placed|no order was placed|not been placed|cannot place|can't place|can’t place|can not place|unable to place|have not placed|haven't placed|did not place)/i;
const SAFE = "I can't place or pay for orders. To buy something, add it to your cart and complete payment at checkout. No order has been placed.";

function claimsOrderSuccess(text) {
  const s = String(text == null ? "" : text);
  return CLAIM_PATTERNS.some((re) => re.test(s)) && !DENIAL.test(s);
}
function scrubOrderClaims(text) {
  return claimsOrderSuccess(text) ? SAFE : String(text == null ? "" : text);
}
module.exports = { scrubOrderClaims, claimsOrderSuccess, SAFE };
