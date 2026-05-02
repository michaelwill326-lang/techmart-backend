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
  maxRetriesPerRequest: null
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
  .catch(err => console.log("❌ Mongo Error:", err));

/* ===========================
📦 ORDER MODEL
=========================== */
const Order = mongoose.model("Order", new mongoose.Schema({
  email: String,
  items: Array,
  totalAmount: Number,
  status: { type: String, default: "Pending" },
  createdAt: { type: Date, default: Date.now }
}));

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
⚙️ WORKER PROCESSOR
=========================== */
const worker = new Worker(
  "orderQueue",
  async (job) => {

    const { orderId } = job.data;

    console.log("📦 Processing order:", orderId);

    const order = await Order.findById(orderId);

    if (!order) {
      throw new Error("Order not found");
    }

    /* ===========================
    ⏳ SIMULATE PROCESSING
    =========================== */
    await new Promise(res => setTimeout(res, 1000));

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
          <p>Total: ₦${order.totalAmount}</p>
          <p>Status: ${order.status}</p>
        `
      });

      console.log("✅ Email sent");

    } catch (err) {
      console.log("❌ Email failed:", err.message);
      throw err; // 🔥 triggers retry
    }

    /* ===========================
    🤖 AI SERVICE (OPTIONAL)
    =========================== */
    try {
      await axios.post("http://localhost:6000/analyze-order", order);
      console.log("🤖 AI processed");
    } catch (err) {
      console.log("⚠️ AI service skipped");
    }

    console.log("✅ Order fully processed:", orderId);

    return true;
  },
  {
    connection,
    concurrency: 5, // 🔥 process multiple jobs
    attempts: 5, // 🔁 retry failed jobs
    backoff: {
      type: "exponential",
      delay: 2000
    }
  }
);

/* ===========================
📊 EVENTS (IMPORTANT)
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