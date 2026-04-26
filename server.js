require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const compression = require("compression");

// 🔥 REDIS + QUEUE
const IORedis = require("ioredis");
const { Queue } = require("bullmq");

const app = express();

/* ===========================
⚡ MIDDLEWARE
=========================== */
app.use(cors());
app.use(express.json());
app.use(compression());

/* ===========================
🔗 REDIS CONNECTION
=========================== */
const connection = new IORedis(process.env.REDIS_URL);

connection.on("connect", () => {
  console.log("✅ Redis Connected");
});

connection.on("error", (err) => {
  console.error("❌ Redis Error:", err);
});

/* ===========================
📦 QUEUE (ORDER PROCESSING)
=========================== */
const orderQueue = new Queue("orderQueue", {
  connection
});

/* ===========================
🧠 DATABASE
=========================== */
mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log("✅ MongoDB Connected"))
.catch(err=>console.log("❌ Mongo Error:", err));

/* ===========================
📊 MODELS
=========================== */
const User = mongoose.model("User", new mongoose.Schema({
  name:String,
  email:{ type:String, unique:true },
  password:String,
  phone:String,
  isAdmin:{ type:Boolean, default:false }
}));

const Product = mongoose.model("Product", new mongoose.Schema({
  name:String,
  price:Number,
  image:String,
  stock:{ type:Number, default:0 },

  reviews:[
    {
      name:String,
      rating:Number,
      comment:String,
      createdAt:{ type:Date, default:Date.now }
    }
  ]
}));

const Order = mongoose.model("Order", new mongoose.Schema({
  email:String,
  items:Array,
  totalAmount:Number,
  status:{ type:String, default:"Pending" },
  createdAt:{ type:Date, default:Date.now }
}));

/* ===========================
🌐 SOCKET.IO
=========================== */
const server = http.createServer(app);

const io = new Server(server, {
  cors:{ origin:"*" }
});

app.set("io", io);

io.on("connection", (socket)=>{
  console.log("⚡ Admin connected:", socket.id);

  socket.on("disconnect", ()=>{
    console.log("❌ Admin disconnected:", socket.id);
  });
});

/* ===========================
📡 EVENT EMITTER
=========================== */
function emitEvent(type, payload){
  io.emit(type, payload);
}

/* ===========================
🛒 CREATE ORDER (QUEUE BASED)
=========================== */
app.post("/api/order", async (req,res)=>{

  try{

    const order = await Order.create(req.body);

    // 🔥 Add to queue
    await orderQueue.add("processOrder", {
      orderId: order._id
    });

    // ⚡ Real-time update
    emitEvent("order:new", order);

    res.json({ success:true });

  }catch(err){
    console.error(err);
    res.status(500).json({ error:"Order failed" });
  }

});

/* ===========================
⭐ ADD REVIEW
=========================== */
app.post("/api/products/:id/review", async (req,res)=>{

  try{

    const { name, rating, comment } = req.body;

    if(!name || !rating || !comment){
      return res.status(400).json({ error:"All fields required" });
    }

    const product = await Product.findById(req.params.id);

    if(!product){
      return res.status(404).json({ error:"Product not found" });
    }

    product.reviews.push({
      name,
      rating:Number(rating),
      comment
    });

    await product.save();

    emitEvent("review:new", { productId: product._id });

    res.json({ success:true });

  }catch(err){
    res.status(500).json({ error:"Review failed" });
  }

});

/* ===========================
📦 GET PRODUCTS
=========================== */
app.get("/api/products", async (req,res)=>{
  const products = await Product.find().lean();
  res.json(products);
});

/* ===========================
📊 ADMIN DASHBOARD
=========================== */
app.get("/api/admin/dashboard", async (req,res)=>{

  const orders = await Order.find().lean();
  const products = await Product.find().lean();

  res.json({
    totalOrders: orders.length,
    totalRevenue: orders.reduce((a,b)=>a+(b.totalAmount||0),0),
    products
  });

});

/* ===========================
🚀 SERVER START
=========================== */
const PORT = process.env.PORT || 10000;

server.listen(PORT, ()=>{
  console.log("🚀 Level 6 Server running on port " + PORT);
});