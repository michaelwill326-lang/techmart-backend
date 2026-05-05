require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const crypto = require("crypto");
const { Parser } = require("json2csv");

const app = express();
const server = http.createServer(app);

/* ===========================
   🌐 ENV
=========================== */
const FRONTEND_URL = process.env.FRONTEND_URL;

/* ===========================
   ⚡ SOCKET.IO
=========================== */
const io = new Server(server, {
  cors: { origin: "*" }
});

/* ===========================
   🌍 CORS
=========================== */
const allowedOrigins = [
  "http://localhost:5173",
  FRONTEND_URL
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error("CORS blocked"));
  },
  credentials: true
}));

/* ===========================
   🛡 MIDDLEWARE
=========================== */
app.use(express.json());
app.use(helmet());
app.use(compression());

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 150
}));

/* ===========================
   🧠 DATABASE
=========================== */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

/* ===========================
   📦 MODELS
=========================== */
const User = mongoose.model("User", new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  phone: String,
  password: String,
  role: { type: String, enum: ["customer","vendor","admin"], default: "customer" },
  otp: String,
  otpExpires: Date,
  createdAt: { type: Date, default: Date.now }
}));

const Product = mongoose.model("Product", new mongoose.Schema({
  name: String,
  description: String,
  price: Number,
  stock: Number,
  images: [String],
  vendorId: String,
  reviews: [{ user: String, rating: Number, comment: String, createdAt: Date }],
  createdAt: { type: Date, default: Date.now }
}));

const Order = mongoose.model("Order", new mongoose.Schema({
  customerId: String,
  vendorId: String,
  items: Array,
  amount: Number,
  commission: Number,
  reference: String,
  status: { type: String, default: "Pending" },
  trackingNumber: String,
  createdAt: { type: Date, default: Date.now }
}));

/* ===========================
   🔐 AUTH MIDDLEWARE
=========================== */
function auth(role) {
  return (req,res,next)=>{
    const token = req.headers.authorization?.split(" ")[1];
    if(!token) return res.status(401).json({ error:"No token" });

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if(role && decoded.role !== role) {
        return res.status(403).json({ error:"Forbidden" });
      }

      req.user = decoded;
      next();

    } catch {
      return res.status(401).json({ error:"Invalid token" });
    }
  };
}

/* ===========================
   🏠 ROOT
=========================== */
app.get("/", (req,res)=>{
  res.json({ message:"🚀 TechMart SaaS API Running" });
});

/* ===========================
   🔐 AUTH ROUTES
=========================== */
app.post("/api/auth/signup", async(req,res)=>{
  try {
    const { name, email, phone, password, role } = req.body;

    const hashed = await bcrypt.hash(password, 10);

    const user = await User.create({
      name, email, phone,
      password: hashed,
      role
    });

    res.json({ success:true });

  } catch(err) {
    res.status(500).json({ error:"Signup failed" });
  }
});

app.post("/api/auth/login", async(req,res)=>{
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if(!user) return res.status(401).json({ error:"Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if(!match) return res.status(401).json({ error:"Invalid credentials" });

    const token = jwt.sign(
      { id:user._id, role:user.role },
      process.env.JWT_SECRET,
      { expiresIn:"7d" }
    );

    res.json({ token, role:user.role });

  } catch {
    res.status(500).json({ error:"Login failed" });
  }
});

/* ===========================
   📦 PRODUCTS
=========================== */
app.get("/api/products", async(req,res)=>{
  const products = await Product.find();
  res.json(products);
});

app.post("/api/vendor/products", auth("vendor"), async(req,res)=>{
  const product = await Product.create({
    ...req.body,
    vendorId: req.user.id
  });

  res.json(product);
});

/* ===========================
   ⭐ REVIEWS
=========================== */
app.post("/api/products/:id/review", auth(), async(req,res)=>{
  const product = await Product.findById(req.params.id);

  product.reviews.push({
    ...req.body,
    user: req.user.id,
    createdAt: new Date()
  });

  await product.save();
  res.json(product);
});

/* ===========================
   📦 ORDERS
=========================== */
app.post("/api/orders", auth(), async(req,res)=>{
  const { items, amount } = req.body;

  const reference = "TX-" + Date.now();
  const commission = amount * 0.05;

  const order = await Order.create({
    customerId: req.user.id,
    vendorId: items[0]?.vendorId,
    items,
    amount,
    commission,
    reference
  });

  io.emit("newOrder", order);

  res.json(order);
});

/* ===========================
   📊 ADMIN ANALYTICS
=========================== */
app.get("/api/admin/analytics", auth("admin"), async(req,res)=>{
  const orders = await Order.find();

  const totalRevenue = orders.reduce((sum,o)=>sum+o.amount,0);
  const totalCommission = orders.reduce((sum,o)=>sum+o.commission,0);

  res.json({
    totalRevenue,
    totalCommission,
    totalOrders: orders.length
  });
});

/* ===========================
   💳 PAYSTACK
=========================== */
app.post("/api/paystack/init", async(req,res)=>{
  try {
    const { email, amount, cart } = req.body;
    const reference = "TX-" + Date.now();

    await Order.create({
      customerId: email,
      items: cart,
      amount,
      reference
    });

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: amount * 100,
        reference,
        callback_url: `${FRONTEND_URL}/success`
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    res.json({
      url: response.data.data.authorization_url
    });

  } catch (err) {
    res.status(500).json({ error:"Payment failed" });
  }
});

/* ===========================
   🔐 PAYSTACK WEBHOOK
=========================== */
app.post("/api/paystack/webhook", (req,res)=>{
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (hash === req.headers["x-paystack-signature"]) {
    const event = req.body;

    if (event.event === "charge.success") {
      const ref = event.data.reference;

      Order.findOneAndUpdate(
        { reference: ref },
        { status: "Paid" }
      ).then(() => console.log("✅ Payment verified"));
    }
  }

  res.sendStatus(200);
});

/* ===========================
   📱 OTP (TERMII)
=========================== */
app.post("/api/auth/otp", async(req,res)=>{
  const otp = Math.floor(100000 + Math.random()*900000);

  await axios.post(
    "https://api.termii.com/api/sms/send",
    {
      to: req.body.phone,
      sms: `Your OTP is ${otp}`,
      from: "TechMart"
    },
    {
      headers: {
        Authorization: process.env.TERMII_API_KEY
      }
    }
  );

  res.json({ success:true });
});

/* ===========================
   🚀 START SERVER
=========================== */
const PORT = process.env.PORT || 10000;

server.listen(PORT, ()=>{
  console.log("🚀 TechMart SaaS running on port " + PORT);
});