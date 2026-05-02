require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const http = require("http");
const { Server } = require("socket.io");
const compression = require("compression");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Parser } = require("json2csv");

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
🔗 REDIS
=========================== */
const connection = new IORedis(process.env.REDIS_URL);

connection.on("connect", () => console.log("✅ Redis Connected"));
connection.on("error", (err) => console.error("❌ Redis Error:", err));

const orderQueue = new Queue("orderQueue", { connection });

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
  isAdmin:{ type:Boolean, default:false }
}));

const Product = mongoose.model("Product", new mongoose.Schema({
  name:String,
  price:Number,
  stock:Number,
  image:String,
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

const Audit = mongoose.model("Audit", new mongoose.Schema({
  action:String,
  adminId:String,
  createdAt:{ type:Date, default:Date.now }
}));

/* ===========================
🔐 AUTH
=========================== */
function adminAuth(req,res,next){
  const token = req.headers.authorization?.split(" ")[1];
  if(!token) return res.status(401).json({ error:"No token" });

  try{
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if(!decoded.isAdmin) return res.status(403).json({ error:"Not admin" });

    req.userId = decoded.id;
    next();
  }catch{
    res.status(401).json({ error:"Invalid token" });
  }
}

/* ===========================
🌐 SOCKET.IO
=========================== */
const server = http.createServer(app);

const io = new Server(server,{
  cors:{ origin:"*" }
});

function emitEvent(type,data){
  io.emit(type,data);
}

/* ===========================
🛒 CREATE ORDER
=========================== */
app.post("/api/order", async (req,res)=>{
  try{
    const order = await Order.create(req.body);

    await orderQueue.add("processOrder",{
      orderId: order._id
    },{
      attempts:5,
      backoff:{ type:"exponential", delay:2000 }
    });

    emitEvent("order:new", order);

    res.json({ success:true });

  }catch(err){
    console.error(err);
    res.status(500).json({ error:"Order failed" });
  }
});

/* ===========================
📊 DASHBOARD
=========================== */
app.get("/api/admin/dashboard", adminAuth, async (req,res)=>{
  const orders = await Order.find().lean();

  const totalRevenue = orders.reduce((a,b)=>a+(b.totalAmount||0),0);

  const productMap = {};
  orders.forEach(o=>{
    (o.items || []).forEach(i=>{
      productMap[i.name]=(productMap[i.name]||0)+(i.quantity||1);
    });
  });

  const topProducts = Object.entries(productMap)
    .map(([name,qty])=>({ name, qty }))
    .sort((a,b)=>b.qty-a.qty)
    .slice(0,5);

  res.json({
    totalOrders: orders.length,
    totalRevenue,
    orders,
    topProducts
  });
});

/* ===========================
✏️ UPDATE ORDER
=========================== */
app.put("/api/admin/order/:id", adminAuth, async (req,res)=>{
  await Order.findByIdAndUpdate(req.params.id,{
    status:req.body.status
  });

  await Audit.create({
    action:`Updated order ${req.params.id} → ${req.body.status}`,
    adminId:req.userId
  });

  res.json({ success:true });
});

/* ===========================
🔐 ADMIN LOGIN (FIXED)
=========================== */
app.post("/api/admin/login", async (req,res)=>{
  try{
    const { email,password } = req.body;

    if(!email || !password){
      return res.status(400).json({ success:false, message:"Missing fields" });
    }

    const user = await User.findOne({ email });

    if(!user || !user.isAdmin){
      return res.json({ success:false, message:"Invalid credentials" });
    }

    const match = await bcrypt.compare(password,user.password);

    if(!match){
      return res.json({ success:false, message:"Invalid credentials" });
    }

    const token = jwt.sign(
      { id:user._id, isAdmin:true },
      process.env.JWT_SECRET,
      { expiresIn:"7d" }
    );

    res.json({ success:true, token });

  }catch(err){
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ success:false });
  }
});
/* ===========================
🛠 CREATE ADMIN USER (ONE-TIME)
=========================== */
app.post("/api/admin/create", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // 🚫 Prevent empty fields
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "All fields required"
      });
    }

    // 🔍 Check if admin already exists
    const existing = await User.findOne({ email });

    if (existing) {
      return res.json({
        success: false,
        message: "Admin already exists"
      });
    }

    // 🔐 Hash password
    const hashed = await bcrypt.hash(password, 10);

    // 👤 Create admin
    const user = await User.create({
      name,
      email,
      password: hashed,
      isAdmin: true
    });

    res.json({
      success: true,
      message: "Admin created successfully"
    });

  } catch (err) {
    console.error("CREATE ADMIN ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});
/* ===========================
🚀 START
=========================== */
const PORT = process.env.PORT || 10000;

server.listen(PORT, ()=>{
  console.log("🚀 Server running on port " + PORT);
});