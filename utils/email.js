// Configure the Gmail Transporter with explicit port handling
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,                  // Secure SMTP Port
    secure: true,                // Use SSL/TLS directly
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    connectionTimeout: 10000,    // 10 seconds timeout limit
  });
/* ===========================
   📧 ORDER CONFIRMATION
=========================== */
const sendOrderConfirmation = async (order) => {
  const itemsHTML = order.items?.map(item => `
    <tr>
      <td style="padding: 12px; border-bottom: 1px solid #222; color: #fff;">${item.name}</td>
      <td style="padding: 12px; border-bottom: 1px solid #222; color: #fff; text-align: center;">${item.quantity || 1}</td>
      <td style="padding: 12px; border-bottom: 1px solid #222; color: #f97316; text-align: right;">₦${(item.price * (item.quantity || 1)).toLocaleString()}</td>
    </tr>
  `).join("") || "";

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"/></head>
    <body style="margin: 0; padding: 0; background: #0a0a0a; font-family: Arial, sans-serif;">
      <div style="max-width: 600px; margin: 0 auto; padding: 32px 16px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #f97316; font-size: 28px; font-weight: 900; margin: 0;">TechMart</h1>
          <p style="color: #888; font-size: 13px; margin: 4px 0 0;">The Store of the Future</p>
        </div>
        <div style="background: linear-gradient(135deg, #f97316, #dc2626); border-radius: 16px; padding: 32px; text-align: center; margin-bottom: 24px;">
          <p style="font-size: 48px; margin: 0;">✅</p>
          <h2 style="color: #fff; font-size: 24px; font-weight: 800; margin: 16px 0 8px;">Order Confirmed!</h2>
          <p style="color: rgba(255,255,255,0.9); font-size: 15px; margin: 0;">Thank you for shopping with TechMart</p>
        </div>
        <div style="background: #111; border: 1px solid #222; border-radius: 16px; padding: 24px; margin-bottom: 24px;">
          <h3 style="color: #fff; font-size: 16px; font-weight: 700; margin: 0 0 16px;">📦 Order Details</h3>
          <table style="width: 100%;">
            <tr>
              <td style="color: #888; font-size: 14px; padding: 8px 0;">Reference</td>
              <td style="color: #f97316; font-size: 14px; font-weight: 700; text-align: right;">${order.reference}</td>
            </tr>
            <tr><td colspan="2" style="border-top: 1px solid #222; padding: 0;"></td></tr>
            <tr>
              <td style="color: #888; font-size: 14px; padding: 8px 0;">Email</td>
              <td style="color: #fff; font-size: 14px; text-align: right;">${order.email}</td>
            </tr>
            <tr><td colspan="2" style="border-top: 1px solid #222; padding: 0;"></td></tr>
            <tr>
              <td style="color: #888; font-size: 14px; padding: 8px 0;">Status</td>
              <td style="color: #22c55e; font-size: 14px; font-weight: 700; text-align: right;">✅ Confirmed</td>
            </tr>
          </table>
        </div>
        <div style="background: #111; border: 1px solid #222; border-radius: 16px; padding: 24px; margin-bottom: 24px;">
          <h3 style="color: #fff; font-size: 16px; font-weight: 700; margin: 0 0 16px;">🛍️ Order Items</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr>
                <th style="color: #888; font-size: 12px; text-align: left; padding: 8px 12px; border-bottom: 1px solid #222;">Product</th>
                <th style="color: #888; font-size: 12px; text-align: center; padding: 8px 12px; border-bottom: 1px solid #222;">Qty</th>
                <th style="color: #888; font-size: 12px; text-align: right; padding: 8px 12px; border-bottom: 1px solid #222;">Price</th>
              </tr>
            </thead>
            <tbody>${itemsHTML}</tbody>
            <tfoot>
              <tr>
                <td colspan="2" style="padding: 16px 12px; color: #fff; font-weight: 800; font-size: 16px;">Total</td>
                <td style="padding: 16px 12px; color: #f97316; font-weight: 800; font-size: 18px; text-align: right;">₦${order.amount?.toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div style="background: #111; border: 1px solid #222; border-radius: 16px; padding: 24px; margin-bottom: 24px;">
          <h3 style="color: #fff; font-size: 16px; font-weight: 700; margin: 0 0 16px;">📬 What happens next?</h3>
          <div style="display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px;">
            <span style="font-size: 24px;">📦</span>
            <div>
              <p style="color: #fff; font-weight: 600; font-size: 14px; margin: 0 0 4px;">Order Processing</p>
              <p style="color: #888; font-size: 13px; margin: 0;">We'll prepare your items within 24 hours.</p>
            </div>
          </div>
          <div style="display: flex; align-items: flex-start; gap: 12px;">
            <span style="font-size: 24px;">🚚</span>
            <div>
              <p style="color: #fff; font-weight: 600; font-size: 14px; margin: 0 0 4px;">Delivery</p>
              <p style="color: #888; font-size: 13px; margin: 0;">Your order will arrive in 2-5 business days.</p>
            </div>
          </div>
        </div>
        <div style="text-align: center; margin-bottom: 32px;">
          <a href="${process.env.FRONTEND_URL}/tracking" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #f97316, #dc2626); color: #fff; text-decoration: none; border-radius: 12px; font-weight: 700; font-size: 15px;">
            📦 Track Your Order
          </a>
        </div>
        <div style="text-align: center; border-top: 1px solid #222; padding-top: 24px;">
          <p style="color: #f97316; font-weight: 800; font-size: 18px; margin: 0 0 4px;">TechMart</p>
          <p style="color: #555; font-size: 12px; margin: 0;">Built with ❤️ in Nigeria 🇳🇬</p>
          <p style="color: #555; font-size: 12px; margin: 8px 0 0;">© 2026 TechMart. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    await transporter.sendMail({
      from: `"TechMart" <${process.env.EMAIL_USER}>`,
      to: order.email,
      subject: `✅ Order Confirmed - ${order.reference}`,
      html,
    });
    console.log(`📧 Order confirmation sent successfully to ${order.email}`);
  } catch (error) {
    console.error(`❌ Nodemailer Order Email Error for ${order.email}:`, error);
  }
};

/* ===========================
   👤 WELCOME EMAIL
=========================== */
const sendWelcomeEmail = async (user) => {
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

  try {
    await transporter.sendMail({
      from: `"TechMart" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: `🎉 Welcome to TechMart, ${user.name}!`,
      html,
    });
    console.log(`📧 Welcome email sent successfully to ${user.email}`);
  } catch (error) {
    console.error(`❌ Nodemailer Welcome Email Error for ${user.email}:`, error);
  }
};

/* ===========================
   🚚 SHIPPING UPDATE
=========================== */
const sendShippingUpdate = async (order) => {
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

  try {
    await transporter.sendMail({
      from: `"TechMart" <${process.env.EMAIL_USER}>`,
      to: order.email,
      subject: `🚚 Your Order ${order.reference} has been Shipped!`,
      html,
    });
    console.log(`📧 Shipping update sent successfully to ${order.email}`);
  } catch (error) {
    console.error(`❌ Nodemailer Shipping Email Error for ${order.email}:`, error);
  }
};

module.exports = {
  sendOrderConfirmation,
  sendWelcomeEmail,
  sendShippingUpdate,
};