const { BrevoClient } = require("@getbrevo/brevo");

// 🔍 Runtime Environment Diagnostics Check
if (!process.env.BREVO_API_KEY) {
  console.error("❌ DEPLOYMENT CRITICAL: process.env.BREVO_API_KEY is undefined or empty inside Render environment settings!");
} else {
  console.log(`📡 BREVO ENV CHECK: Key is present (Length: ${process.env.BREVO_API_KEY.length} chars)`);
}

// 1. Initialize the modern BrevoClient directly with your key (safeguarded against spaces)
const brevo = new BrevoClient({
  apiKey: process.env.BREVO_API_KEY ? process.env.BREVO_API_KEY.trim() : "",
});

// 2. Define your default verified sender identity
const FROM = { email: "michaelwill326@gmail.com", name: "TechMart" };

/* =========================================================================
   💳 ORDER CONFIRMATION EMAIL (WITH NAIRA CALCULATIONS)
========================================================================= */
const sendOrderConfirmation = async (order) => {
  try {
    // Generate HTML table rows dynamically for each cart item
    const itemRows = order.items.map(item => `
      <tr>
        <td style="color: #aaa; font-size: 14px; padding: 8px 0;">${item.name} (x${item.quantity || 1})</td>
        <td style="color: #fff; font-size: 14px; font-weight: 600; text-align: right;">₦${(item.price * (item.quantity || 1)).toLocaleString()}</td>
      </tr>
    `).join("");

    const html = `
      <!DOCTYPE html>
      <html>
      <body style="margin: 0; padding: 0; background: #0a0a0a; font-family: Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; padding: 32px 16px;">

          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="color: #f97316; font-size: 28px; font-weight: 900; margin: 0;">TechMart</h1>
            <p style="color: #888; font-size: 13px; margin: 4px 0 0;">Order Receipt</p>
          </div>

          <div style="background: linear-gradient(135deg, #10b981, #059669); border-radius: 16px; padding: 32px; text-align: center; margin-bottom: 24px;">
            <p style="font-size: 48px; margin: 0;">📦</p>
            <h2 style="color: #fff; font-size: 24px; font-weight: 800; margin: 16px 0 8px;">Order Confirmed!</h2>
            <p style="color: rgba(255,255,255,0.9); font-size: 15px; margin: 0;">Thank you for your purchase. We are preparing your order.</p>
          </div>

          <div style="background: #111; border: 1px solid #222; border-radius: 16px; padding: 24px; margin-bottom: 24px;">
            <h3 style="color: #fff; font-size: 16px; font-weight: 700; margin: 0 0 16px;">Order Summary</h3>
            <table style="width: 100%; border-collapse: collapse;">
              ${itemRows}
              <tr><td colspan="2" style="border-top: 1px solid #222; padding: 8px 0;"></td></tr>
              <tr>
                <td style="color: #fff; font-size: 16px; font-weight: 700; padding: 8px 0;">Total Amount</td>
                <td style="color: #f97316; font-size: 18px; font-weight: 800; text-align: right;">₦${order.amount.toLocaleString()}</td>
              </tr>
            </table>
          </div>

          <div style="text-align: center; border-top: 1px solid #222; padding-top: 24px;">
            <p style="color: #f97316; font-weight: 800; font-size: 18px; margin: 0 0 4px;">TechMart</p>
            <p style="color: #555; font-size: 12px; margin: 0;">Built with ❤️ in Nigeria 🇳🇬</p>
          </div>

        </div>
      </body>
      </html>
    `;

    await brevo.transactionalEmails.sendTransacEmail({
      sender: FROM,
      to: [{ email: order.email }],
      subject: `🛒 TechMart Order Confirmation [${order.reference}]`,
      htmlContent: html,
    });

    console.log(`📧 Order confirmation email sent to ${order.email}`);
  } catch (err) {
    console.error("❌ BREVO ERROR inside sendOrderConfirmation:", err.message);
  }
};

/* =========================================================================
   👤 WELCOME EMAIL
========================================================================= */
const sendWelcomeEmail = async (user) => {
  try {
    const html = `
      <!DOCTYPE html>
      <html>
      <body style="margin: 0; padding: 0; background: #0a0a0a; font-family: Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; padding: 32px 16px;">

          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="color: #f97316; font-size: 28px; font-weight: 900; margin: 0;">TechMart</h1>
            <p style="color: #888; font-size: 13px; margin: 4px 0 0;">The Store of the Future</p>
          </div>

          <div style="background: linear-gradient(135deg, #f97316, #dc2626); border-radius: 16px; padding: 32px; text-align: center; margin-bottom: 24px;">
            <p style="font-size: 48px; margin: 0;">🎉</p>
            <h2 style="color: #fff; font-size: 24px; font-weight: 800; margin: 16px 0 8px;">Welcome to TechMart, ${user.name}!</h2>
            <p style="color: rgba(255,255,255,0.9); font-size: 15px; margin: 0;">Your account has been created successfully.</p>
          </div>

          <div style="background: #111; border: 1px solid #222; border-radius: 16px; padding: 24px; margin-bottom: 24px;">
            <h3 style="color: #fff; font-size: 16px; font-weight: 700; margin: 0 0 16px;">🚀 What you can do on TechMart</h3>
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
              <span style="font-size: 20px;">🛍️</span>
              <span style="color: #aaa; font-size: 14px;">Shop the latest tech products</span>
            </div>
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
              <span style="font-size: 20px;">🤍</span>
              <span style="color: #aaa; font-size: 14px;">Save products to your wishlist</span>
            </div>
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
              <span style="font-size: 20px;">📦</span>
              <span style="color: #aaa; font-size: 14px;">Track your orders in real time</span>
            </div>
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
              <span style="font-size: 20px;">🤖</span>
              <span style="color: #aaa; font-size: 14px;">Chat with our AI shopping assistant</span>
            </div>
            <div style="display: flex; align-items: center; gap: 12px;">
              <span style="font-size: 20px;">⭐</span>
              <span style="color: #aaa; font-size: 14px;">Leave reviews on products you buy</span>
            </div>
          </div>

          <div style="text-align: center; margin-bottom: 32px;">
            <a href="${process.env.FRONTEND_URL}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #f97316, #dc2626); color: #fff; text-decoration: none; border-radius: 12px; font-weight: 700; font-size: 15px;">
              🛍️ Start Shopping
            </a>
          </div>

          <div style="text-align: center; border-top: 1px solid #222; padding-top: 24px;">
            <p style="color: #f97316; font-weight: 800; font-size: 18px; margin: 0 0 4px;">TechMart</p>
            <p style="color: #555; font-size: 12px; margin: 0;">Built with ❤️ in Nigeria 🇳🇬</p>
          </div>

        </div>
      </body>
      </html>
    `;

    await brevo.transactionalEmails.sendTransacEmail({
      sender: FROM,
      to: [{ email: user.email }],
      subject: `🎉 Welcome to TechMart, ${user.name}!`,
      htmlContent: html,
    });

    console.log(`📧 Welcome email sent to ${user.email}`);
  } catch (err) {
    console.error("❌ BREVO ERROR inside sendWelcomeEmail:", err.message);
  }
};

/* =========================================================================
   🚚 SHIPPING UPDATE
========================================================================= */
const sendShippingUpdate = async (order) => {
  try {
    const html = `
      <!DOCTYPE html>
      <html>
      <body style="margin: 0; padding: 0; background: #0a0a0a; font-family: Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; padding: 32px 16px;">

          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="color: #f97316; font-size: 28px; font-weight: 900; margin: 0;">TechMart</h1>
          </div>

          <div style="background: linear-gradient(135deg, #3b82f6, #1d4ed8); border-radius: 16px; padding: 32px; text-align: center; margin-bottom: 24px;">
            <p style="font-size: 48px; margin: 0;">🚚</p>
            <h2 style="color: #fff; font-size: 24px; font-weight: 800; margin: 16px 0 8px;">Your Order is on the Way!</h2>
            <p style="color: rgba(255,255,255,0.9); font-size: 15px; margin: 0;">Order ${order.reference} has been shipped.</p>
          </div>

          <div style="background: #111; border: 1px solid #222; border-radius: 16px; padding: 24px; margin-bottom: 24px;">
            <table style="width: 100%;">
              <tr>
                <td style="color: #888; font-size: 14px; padding: 8px 0;">Reference</td>
                <td style="color: #f97316; font-size: 14px; font-weight: 700; text-align: right;">${order.reference}</td>
              </tr>
              <tr><td colspan="2" style="border-top: 1px solid #222;"></td></tr>
              <tr>
                <td style="color: #888; font-size: 14px; padding: 8px 0;">Status</td>
                <td style="color: #3b82f6; font-size: 14px; font-weight: 700; text-align: right;">🚚 Shipped</td>
              </tr>
              ${order.trackingNumber ? `
              <tr><td colspan="2" style="border-top: 1px solid #222;"></td></tr>
              <tr>
                <td style="color: #888; font-size: 14px; padding: 8px 0;">Tracking Number</td>
                <td style="color: #fff; font-size: 14px; font-weight: 700; text-align: right;">${order.trackingNumber}</td>
              </tr>
              ` : ""}
            </table>
          </div>

          <div style="text-align: center; margin-bottom: 32px;">
            <a href="${process.env.FRONTEND_URL}/tracking" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #f97316, #dc2626); color: #fff; text-decoration: none; border-radius: 12px; font-weight: 700; font-size: 15px;">
              📦 Track Your Order
            </a>
          </div>

          <div style="text-align: center; border-top: 1px solid #222; padding-top: 24px;">
            <p style="color: #f97316; font-weight: 800; font-size: 18px; margin: 0 0 4px;">TechMart</p>
            <p style="color: #555; font-size: 12px; margin: 0;">Built with ❤️ in Nigeria 🇳🇬</p>
          </div>

        </div>
      </body>
      </html>
    `;

    await brevo.transactionalEmails.sendTransacEmail({
      sender: FROM,
      to: [{ email: order.email }],
      subject: `🚚 Your Order ${order.reference} has been Shipped!`,
      htmlContent: html,
    });

    console.log(`📧 Shipping update sent to ${order.email}`);
  } catch (err) {
    console.error("❌ BREVO ERROR inside sendShippingUpdate:", err.message);
  }
};

module.exports = {
  sendOrderConfirmation,
  sendWelcomeEmail,
  sendShippingUpdate,
};