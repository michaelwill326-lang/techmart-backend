require("dotenv").config();

const mongoose = require("mongoose");
const axios = require("axios");
const nodemailer = require("nodemailer");
const { Worker } = require("bullmq");
const IORedis = require("ioredis");

/* ===========================
🔗 REDIS CONNECTION
=========================== */
const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

connection.on("connect", () => {
  console.log("✅ Worker Redis Connected");
});

connection.on("error", (err) => {
  console.error("❌ Redis Error:", err);
});

/* ===========================
🧠 MONGODB
=========================== */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Worker MongoDB Connected"))
  .catch(err => console.error("❌ Mongo Error:", err));

/* ===========================
📦 ORDER MODEL
(MUST MATCH server.js)
=========================== */
const orderSchema = new mongoose.Schema({
  userId: String,
  email: String,
  totalAmount: Number,
  paymentReference: String,
  status: { type: String, default: "Processing" },
  trackingNumber: String,
  items: [
    {
      name: String,
      price: Number,
      quantity: Number,
      image: String
    }
  ]
}, { timestamps: true });

const Order = mongoose.model("Order", orderSchema);

/* ===========================
📧 EMAIL SETUP
=========================== */
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

/* ===========================
⚙️ WORKER (QUEUE PROCESSOR)
=========================== */
const worker = new Worker(
  "orderQueue", // ⚠️ MUST MATCH server.js
  async (job) => {

    const { orderId } = job.data;

    console.log("📦 Processing order:", orderId);

    // 🔍 Get order
    const order = await Order.findById(orderId);

    if (!order) {
      throw new Error("Order not found");
    }

    /* ===========================
    📧 SEND EMAIL
    =========================== */
    try {

      await transporter.sendMail({
        from: `TechMart <${process.env.EMAIL_USER}>`,
        to: order.email,
        subject: "🛒 Order Confirmation",
        html: `
          <h2>Order Confirmed</h2>
          <p><strong>Total:</strong> ₦${order.totalAmount}</p>
          <p><strong>Tracking:</strong> ${order.trackingNumber}</p>
        `
      });

      console.log("✅ Email sent");

    } catch (err) {
      console.error("❌ Email failed:", err.message);
      throw err; // 🔁 retry job
    }

    /* ===========================
    🔄 UPDATE ORDER STATUS
    =========================== */
    order.status = "Confirmed";
    await order.save();

    console.log("✅ Order updated");

    /* ===========================
    🤖 OPTIONAL AI CALL
    =========================== */
    try {
      await axios.post("http://localhost:6000/analyze-order", order);
      console.log("🤖 AI processed");
    } catch {
      console.log("⚠️ AI service not running (skipped)");
    }

    return true;
  },
  {
    connection,
    concurrency: 5 // 🔥 parallel jobs
  }
);

/* ===========================
📊 WORKER EVENTS
=========================== */
worker.on("completed", (job) => {
  console.log("✅ Job completed:", job.id);
});

worker.on("failed", (job, err) => {
  console.error("❌ Job failed:", job.id, err.message);
});

worker.on("error", (err) => {
  console.error("🚨 Worker error:", err);
});

console.log("🚀 Worker running...");