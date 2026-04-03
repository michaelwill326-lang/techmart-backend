require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");

const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

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
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

/* ===========================
   EMAIL SETUP
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

// USER
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model("User", userSchema);

// PRODUCT
const productSchema = new mongoose.Schema({
  name: String,
  slug: String,
  price: Number,
  description: String,
  stock: Number,
  image: String,
  reviews: [
    {
      name: String,
      rating: Number,
      comment: String,
      createdAt: { type: Date, default: Date.now }
    }
  ],
  createdAt: { type: Date, default: Date.now }
});
const Product = mongoose.model("Product", productSchema);

// ORDER
const orderSchema = new mongoose.Schema({
  customerName: String,
  email: String,
  address: String,
  items: Array,
  totalAmount: Number,
  paymentReference: String,
  status: {
    type: String,
    enum: ["Processing", "Shipped", "Delivered"],
    default: "Processing"
  },
  trackingNumber: String,
  carrier: String,
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model("Order", orderSchema);

/* ===========================
   ADMIN LOGIN
=========================== */
app.post("/admin/login", (req, res) => {
  const { email, password } = req.body;

  if (
    email === process.env.ADMIN_EMAIL &&
    password === process.env.ADMIN_PASSWORD
  ) {
    const token = jwt.sign(
      { role: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    return res.json({ success: true, token });
  }

  res.status(401).json({ success: false, message: "Invalid credentials" });
});

/* ===========================
   ADMIN AUTH
=========================== */
function verifyAdmin(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "No token" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ===========================
   USER AUTH
=========================== */
function verifyUser(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "No token" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

/* ===========================
   USER ROUTES
=========================== */

// REGISTER
app.post("/api/users/register", async (req, res) => {
  const { name, email, password } = req.body;

  try {
    const existing = await User.findOne({ email });
    if (existing) {
      return res.json({ success: false, message: "User exists" });
    }

    const hashed = await bcrypt.hash(password, 10);

    const user = new User({
      name,
      email,
      password: hashed
    });

    await user.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Register failed" });
  }
});

// LOGIN
app.post("/api/users/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.json({ success: false });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ success: false });

    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ success: true, token, user });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

// MY ORDERS
app.get("/api/my-orders", verifyUser, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const orders = await Order.find({ email: user.email }).sort({ createdAt: -1 });
    res.json(orders);
  } catch {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/* ===========================
   PRODUCTS
=========================== */
app.get("/api/products", async (req, res) => {
  const products = await Product.find();
  res.json(products);
});

/* ===========================
   PAYSTACK
=========================== */
app.post("/initialize-payment", async (req, res) => {
  const { email, amount } = req.body;

  try {
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: Math.round(amount * 100)
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: "Payment failed" });
  }
});

/* ===========================
   VERIFY PAYMENT
=========================== */
app.post("/verify-payment", async (req, res) => {
  const { reference, orderData } = req.body;

  try {
    const newOrder = new Order({
      ...orderData,
      paymentReference: reference,
      trackingNumber: "DHL" + Math.floor(Math.random() * 1000000),
      carrier: "DHL"
    });

    const savedOrder = await newOrder.save();

    io.emit("new-order", savedOrder);

    res.json({
      success: true,
      orderId: savedOrder._id
    });

  } catch (err) {
    res.status(500).json({ error: "Verification failed" });
  }
});

/* ===========================
   ADMIN ORDERS
=========================== */
app.get("/api/orders", verifyAdmin, async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 });
  res.json(orders);
});

/* ===========================
   TRACK
=========================== */
app.get("/api/track/:trackingNumber", async (req, res) => {
  const order = await Order.findOne({
    trackingNumber: req.params.trackingNumber
  });

  if (!order) {
    return res.status(404).json({ error: "Not found" });
  }

  res.json(order);
});

/* ===========================
   ROOT
=========================== */
app.get("/", (req, res) => {
  res.send("TechMart Backend Running ✅");
});

/* ===========================
   SOCKET
=========================== */
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
});

/* ===========================
   START SERVER
=========================== */
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});