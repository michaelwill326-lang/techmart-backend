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
  enableReadyCheck: false,
  tls: {},
  retryStrategy(times) {
    return Math.min(times * 1000, 5000);
  },
});

let redisConnected = false;

connection.on("connect", () => {
  if (!redisConnected) {
    console.log("✅ Worker Redis Connected");
    redisConnected = true;
  }
});

connection.on("error", (err) => {
  console.log("❌ Redis Error:", err.message);
});

/* ===========================
   🧠 MONGODB
=========================== */

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ Worker MongoDB Connected");
  })
  .catch((err) => {
    console.log("❌ Mongo Error:", err.message);
  });

/* ===========================
   📦 ORDER MODEL
=========================== */

const Order = mongoose.model(
  "Order",
  new mongoose.Schema({
    email: String,

    items: Array,

    amount: Number,

    status: {
      type: String,
      default: "Pending",
    },

    reference: String,

    trackingNumber: String,

    createdAt: {
      type: Date,
      default: Date.now,
    },
  })
);

/* ===========================
   📧 EMAIL SETUP
=========================== */

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/* ===========================
   ⚙️ WORKER PROCESSOR
=========================== */

const worker = new Worker(
  "orderQueue",

  async (job) => {
    try {
      const { orderId } = job.data;

      console.log("📦 Processing order:", orderId);

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

            <p>Your order has been received successfully.</p>

            <p><strong>Reference:</strong> ${order.reference}</p>

            <p><strong>Amount:</strong> ₦${order.amount}</p>

            <p><strong>Status:</strong> ${order.status}</p>

            <p>Thank you for shopping with TechMart 🚀</p>
          `,
        });

        console.log("✅ Confirmation email sent");
      } catch (emailErr) {
        console.log(
          "❌ Email Error:",
          emailErr.message
        );
      }

      /* ===========================
         🤖 OPTIONAL AI SERVICE
      =========================== */

      if (process.env.AI_SERVICE_URL) {
        try {
          await axios.post(
            process.env.AI_SERVICE_URL,
            order
          );

          console.log("🤖 AI processed order");
        } catch (aiErr) {
          console.log(
            "⚠️ AI service skipped"
          );
        }
      }

      console.log(
        "✅ Order fully processed:",
        orderId
      );

      return true;
    } catch (err) {
      console.log(
        "❌ Worker Processing Error:",
        err.message
      );

      throw err;
    }
  },

  {
    connection,

    concurrency: 5,

    removeOnComplete: {
      count: 100,
    },

    removeOnFail: {
      count: 50,
    },
  }
);

/* ===========================
   📊 WORKER EVENTS
=========================== */

worker.on("completed", (job) => {
  console.log(
    `✅ Job completed: ${job.id}`
  );
});

worker.on("failed", (job, err) => {
  console.log(
    `❌ Job failed: ${job?.id} - ${err.message}`
  );
});

worker.on("error", (err) => {
  if (
    err.message.includes("Connection is closed")
  ) {
    return;
  }

  console.log(
    "🚨 Worker error:",
    err.message
  );
});

/* ===========================
   🚀 START
=========================== */

console.log("🚀 Worker running...");