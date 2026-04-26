require("dotenv").config();

const mongoose = require("mongoose");
const axios = require("axios");
const nodemailer = require("nodemailer");

// ✅ USE BULLMQ (NOT bull)
const { Worker } = require("bullmq");
const IORedis = require("ioredis");

/* ===========================
🔗 REDIS
=========================== */
const connection = new IORedis(process.env.REDIS_URL);

connection.on("connect", ()=>{
  console.log("✅ Worker Redis Connected");
});

/* ===========================
🧠 DATABASE
=========================== */
mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log("✅ Worker MongoDB Connected"))
.catch(err=>console.log("❌ Mongo Error:", err));

/* ===========================
📦 MODEL
=========================== */
const Order = mongoose.model("Order", new mongoose.Schema({
  email:String,
  items:Array,
  totalAmount:Number,
  createdAt:{ type:Date, default:Date.now }
}));

/* ===========================
📧 EMAIL
=========================== */
const transporter = nodemailer.createTransport({
  service:"gmail",
  auth:{
    user:process.env.EMAIL_USER,
    pass:process.env.EMAIL_PASS
  }
});

/* ===========================
⚙️ WORKER
=========================== */
const worker = new Worker(
  "orderQueue",   // MUST MATCH server.js queue name
  async job => {

    const { orderId } = job.data;

    console.log("📦 Processing:", orderId);

    const order = await Order.findById(orderId);

    if(!order){
      console.log("❌ Order not found");
      return;
    }

    /* ===========================
    📧 EMAIL
    =========================== */
    try{
      await transporter.sendMail({
        from:`TechMart <${process.env.EMAIL_USER}>`,
        to:order.email,
        subject:"🛒 Order Confirmation",
        html:`<h3>Order received</h3><p>Total: ₦${order.totalAmount}</p>`
      });

      console.log("✅ Email sent");

    }catch(err){
      console.log("❌ Email failed");
    }

    /* ===========================
    🤖 AI
    =========================== */
    try{
      await axios.post("http://localhost:6000/analyze-order", order);
      console.log("🤖 AI processed");

    }catch{
      console.log("⚠️ AI service offline");
    }

    return true;
  },
  { connection }
);

/* ===========================
📊 EVENTS
=========================== */
worker.on("completed", job=>{
  console.log("✅ Job done:", job.id);
});

worker.on("failed", (job, err)=>{
  console.error("❌ Job failed:", err.message);
});

console.log("🚀 Worker running...");