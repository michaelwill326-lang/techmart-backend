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

const app = express();
const server = http.createServer(app);

/* ===========================
   🌐 CORS (SAFE FOR DEBUG)
=========================== */
app.use(cors({
  origin: "*"
}));

/* ===========================
   ⚡ MIDDLEWARE
=========================== */
app.use(express.json());
app.use(helmet());
app.use(compression());

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 200
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
const Product = mongoose.model("Product", new mongoose.Schema({
  name: String,
  description: String,
  price: Number,
  stock: Number,
  images: [String],
  createdAt: { type: Date, default: Date.now }
}));

const User = mongoose.model("User", new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  phone: String,
  password: String,
  role: { type: String, default: "customer" },
}));

const Order = mongoose.model("Order", new mongoose.Schema({
  email: String,
  items: Array,
  amount: Number,
  reference: String,
  status: { type: String, default: "Pending" },
  createdAt: { type: Date, default: Date.now }
}));

/* ===========================
   🔐 AUTH MIDDLEWARE
=========================== */
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ===========================
   🏠 ROOT
=========================== */
app.get("/", (req, res) => {
  res.json({ message: "🚀 TechMart API Running" });
});

/* ===========================
   📦 PRODUCTS (FIXED)
=========================== */
app.get("/api/products", async (req, res) => {
  try {
    const products = await Product.find();
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

/* ===========================
   ➕ ADD PRODUCT (TEST)
=========================== */
app.post("/api/products", async (req, res) => {
  try {
    const product = await Product.create(req.body);
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: "Failed to create product" });
  }
});

/* ===========================
   🔐 AUTH
=========================== */
app.post("/api/auth/signup", async (req, res) => {
  const { email, password } = req.body;

  const hashed = await bcrypt.hash(password, 10);

  await User.create({ email, password: hashed });

  res.json({ success: true });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user) return res.status(401).json({ error: "Invalid" });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid" });

  const token = jwt.sign(
    { id: user._id },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ token });
});

/* ===========================
   📦 ORDERS
=========================== */
app.post("/api/orders", async (req, res) => {
  const { email, items, amount } = req.body;

  const order = await Order.create({
    email,
    items,
    amount,
    reference: "TX-" + Date.now()
  });

  res.json(order);
});

/* ===========================
   💳 PAYSTACK
=========================== */
app.post("/api/paystack/init", async (req, res) => {
  try {
    const { email, amount, cart } = req.body;

    const reference = "TX-" + Date.now();

    await Order.create({
      email,
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
        callback_url: process.env.FRONTEND_URL + "/success"
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
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Payment failed" });
  }
});

/* ===========================
   🔐 PAYSTACK WEBHOOK
=========================== */
app.post("/api/paystack/webhook", (req, res) => {
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
   ⚡ SOCKET.IO
=========================== */
const io = new Server(server, {
  cors: { origin: "*" }
});

io.on("connection", socket => {
  console.log("⚡ Client connected:", socket.id);
});

/* ===========================
   🚀 START SERVER
=========================== */
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});