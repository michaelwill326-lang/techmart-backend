require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const multer = require("multer");
const streamifier = require("streamifier");
const cloudinary = require("cloudinary").v2;

const app = express();
const PORT = process.env.PORT || 10000;

/* ===========================
   MIDDLEWARE
=========================== */
app.use(cors());
app.use(express.json());

/* ===========================
   MONGODB
=========================== */
mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log("✅ MongoDB Connected"))
.catch(err=>console.error("❌ MongoDB Error:", err));

/* ===========================
   CLOUDINARY CONFIG
=========================== */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

/* ===========================
   MULTER (MEMORY)
=========================== */
const upload = multer();

/* ===========================
   EMAIL
=========================== */
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

/* ===========================
   MODELS
=========================== */
const Product = mongoose.model("Product", new mongoose.Schema({
  name: String,
  slug: String,
  price: Number,
  description: String,
  stock: Number,
  image: String,
  createdAt: { type: Date, default: Date.now }
}));

const Order = mongoose.model("Order", new mongoose.Schema({
  customerName: String,
  email: String,
  address: String,
  items: Array,
  totalAmount: Number,
  status: { type: String, default: "Processing" },
  trackingNumber: String,
  carrier: String,
  createdAt: { type: Date, default: Date.now }
}));

/* ===========================
   ADMIN LOGIN
=========================== */
app.post("/admin/login", (req,res)=>{
  const { email, password } = req.body;

  if(email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD){
    const token = jwt.sign({ role:"admin" }, process.env.JWT_SECRET || "secret", { expiresIn:"1d" });
    return res.json({ success:true, token });
  }

  res.json({ success:false });
});

/* ===========================
   VERIFY ADMIN
=========================== */
function verifyAdmin(req,res,next){
  const auth = req.headers.authorization;

  if(!auth) return res.status(401).json({error:"No token"});

  try{
    const token = auth.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");

    if(decoded.role !== "admin"){
      return res.status(403).json({error:"Forbidden"});
    }

    next();
  }catch{
    res.status(401).json({error:"Invalid token"});
  }
}

/* ===========================
   PRODUCTS
=========================== */

// GET PRODUCTS
app.get("/api/products", async (req,res)=>{
  const products = await Product.find();
  res.json(products);
});

// ADD PRODUCT (FINAL FIX)
app.post("/api/products", verifyAdmin, upload.single("image"), async (req,res)=>{
  try{

    console.log("BODY:", req.body);
    console.log("FILE:", req.file);

    const { name, price, description, stock } = req.body;

    if(!name || !price){
      return res.status(400).json({error:"Missing fields"});
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g,"-");

    let imageUrl = "https://via.placeholder.com/400";

    // ✅ Upload image to Cloudinary
    if(req.file){
      const uploadFromBuffer = () => {
        return new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: "techmart" },
            (error, result) => {
              if (result) resolve(result);
              else reject(error);
            }
          );
          streamifier.createReadStream(req.file.buffer).pipe(stream);
        });
      };

      const result = await uploadFromBuffer();
      imageUrl = result.secure_url;
    }

    const product = new Product({
      name,
      slug,
      price,
      description,
      stock,
      image: imageUrl
    });

    await product.save();

    res.json(product);

  }catch(err){
    console.error("🔥 UPLOAD ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE PRODUCT
app.delete("/api/products/:id", verifyAdmin, async (req,res)=>{
  await Product.findByIdAndDelete(req.params.id);
  res.json({success:true});
});

/* ===========================
   PAYSTACK
=========================== */
app.post("/initialize-payment", async (req,res)=>{
  const { email, amount } = req.body;

  try{
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: Math.round(amount * 100),
        callback_url: "https://techmart-jb9k.onrender.com/verify.html"
      },
      {
        headers:{
          Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    res.json(response.data);

  }catch(err){
    console.error(err);
    res.status(500).json({error:"Payment failed"});
  }
});

/* ===========================
   VERIFY PAYMENT
=========================== */
app.post("/verify-payment", async (req,res)=>{
  const { reference, orderData } = req.body;

  try{
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers:{
          Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    if(response.data.data.status === "success"){

      const order = new Order({
        ...orderData,
        trackingNumber:"DHL"+Math.floor(Math.random()*1000000),
        carrier:"DHL"
      });

      const saved = await order.save();

      return res.json({ success:true, orderId:saved._id });
    }

    res.json({success:false});

  }catch(err){
    console.error(err);
    res.status(500).json({error:"Verify failed"});
  }
});

/* ===========================
   TRACK ORDER
=========================== */
app.get("/api/track/:trackingNumber", async (req,res)=>{
  const order = await Order.findOne({trackingNumber:req.params.trackingNumber});

  if(!order) return res.status(404).json({error:"Not found"});

  res.json(order);
});

/* ===========================
   ROOT
=========================== */
app.get("/", (req,res)=>{
  res.send("TechMart Backend Running ✅");
});

/* ===========================
   START SERVER
=========================== */
app.listen(PORT, ()=>{
  console.log(`🚀 Server running on port ${PORT}`);
});