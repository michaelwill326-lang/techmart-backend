require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const crypto = require("crypto");
const OpenAI = require("openai");
const compression = require("compression");
const NodeCache = require("node-cache");
const nodemailer = require("nodemailer");

const app = express();

/* ===========================
⚡ PERFORMANCE
=========================== */
app.use(compression());

const cache = new NodeCache({ stdTTL: 60 });

app.use((req,res,next)=>{
  res.setHeader("Cache-Control","public, max-age=300");
  next();
});

/* ===========================
WEBHOOK RAW BODY
=========================== */
app.use("/paystack/webhook", express.raw({ type: "*/*" }));

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

console.log("🔥 FINAL SYSTEM WITH REVIEWS ACTIVE");

/* ===========================
MONGODB
=========================== */
mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log("✅ MongoDB Connected"))
.catch(err=>console.log("❌ Mongo Error:", err));

/* ===========================
MODELS
=========================== */
const userSchema = new mongoose.Schema({
  name:String,
  email:{ type:String, unique:true },
  password:String,
  phone:String,
  isAdmin:{ type:Boolean, default:false }
});
const User = mongoose.model("User", userSchema);

/* ✅ PRODUCT WITH REVIEWS */
const productSchema = new mongoose.Schema({
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
});
const Product = mongoose.model("Product", productSchema);

const orderSchema = new mongoose.Schema({
  userId:String,
  email:String,
  totalAmount:Number,
  paymentReference:{ type:String, unique:true },
  status:{ type:String, default:"Processing" },
  trackingNumber:{
    type:String,
    default:()=> "TRK" + Date.now()
  },
  items:[
    { name:String, price:Number, quantity:Number, image:String }
  ]
},{ timestamps:true });

const Order = mongoose.model("Order", orderSchema);

/* ===========================
AUTH
=========================== */
function adminAuth(req,res,next){
  const header = req.headers.authorization;
  if(!header) return res.status(401).json({ error:"No token" });

  const token = header.split(" ")[1];

  try{
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if(!decoded.isAdmin){
      return res.status(403).json({ error:"Not admin" });
    }

    req.userId = decoded.id;
    next();

  }catch{
    return res.status(401).json({ error:"Invalid token" });
  }
}

/* ===========================
PRODUCTS (CACHED)
=========================== */
app.get("/api/products", async (req,res)=>{
  try{
    const cached = cache.get("products");
    if(cached) return res.json(cached);

    const products = await Product.find().lean();
    cache.set("products", products);

    res.json(products);

  }catch(err){
    res.status(500).json({ error:"Failed to fetch products" });
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

    res.json({ success:true });

  }catch(err){
    console.error(err);
    res.status(500).json({ error:"Failed to add review" });
  }
});

/* ===========================
⭐ GET REVIEWS
=========================== */
app.get("/api/products/:id/reviews", async (req,res)=>{
  try{

    const product = await Product.findById(req.params.id).lean();

    if(!product){
      return res.status(404).json({ error:"Product not found" });
    }

    res.json(product.reviews || []);

  }catch(err){
    res.status(500).json({ error:"Failed to load reviews" });
  }
});

/* ===========================
ADMIN LOGIN
=========================== */
app.post("/api/admin/login", async (req,res)=>{
  try{

    const { email,password } = req.body;

    const user = await User.findOne({ email }).lean();

    if(!user || !user.isAdmin){
      return res.json({ success:false });
    }

    const match = await bcrypt.compare(password,user.password);

    if(!match){
      return res.json({ success:false });
    }

    const token = jwt.sign(
      { id:user._id, isAdmin:true },
      process.env.JWT_SECRET,
      { expiresIn:"7d" }
    );

    res.json({ success:true, token });

  }catch{
    res.status(500).json({ error:"Login failed" });
  }
});

/* ===========================
ORDERS
=========================== */
app.get("/api/admin/orders", adminAuth, async (req,res)=>{
  const orders = await Order.find().sort({ createdAt:-1 }).lean();
  res.json(orders);
});

/* ===========================
SERVER
=========================== */
const PORT = process.env.PORT || 10000;

app.listen(PORT,()=>{
  console.log("🚀 Server running on port " + PORT);
});