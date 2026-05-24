require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const http = require("http");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const aiRoutes = require("./routes/ai");

const app = express();
app.set("trust proxy", 1);

/* ===========================
   🔒 SECURITY
=========================== */
app.use(helmet());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: {
    error: "Too many requests, try again later."
  }
});

app.use(limiter);

/* ===========================
   🌐 CORS CONFIG
=========================== */
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://techmart-store-ppri.onrender.com",
  "https://techmart-frontend.onrender.com"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(
      new Error("CORS blocked: " + origin)
    );
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors());

/* ===========================
   📦 BODY PARSER
=========================== */
app.use(express.json({ limit: "10mb" }));

/* ===========================
   🤖 AI ROUTES
=========================== */
app.use("/api/ai", aiRoutes);

/* ===========================
   🧠 DATABASE
=========================== */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB Connected");
  })
  .catch((err) => {
    console.error("❌ MongoDB Error:", err);
  });

/* ===========================
   👤 MODELS
=========================== */
const User = mongoose.model(
  "User",
  new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    password: String,
    role: { type: String, default: "customer" },
    createdAt: { type: Date, default: Date.now }
  })
);

const Product = mongoose.model(
  "Product",
  new mongoose.Schema({
    name: String,
    price: Number,
    images: [String],
    description: String,
    stock: Number,
    vendorId: String,
    vendorName: String,
    category: String,
    rating: { type: Number, default: 0 },
    reviews: [
      {
        user: String,
        comment: String,
        stars: Number,
        createdAt: { type: Date, default: Date.now }
      }
    ],
    createdAt: { type: Date, default: Date.now }
  })
);

const Order = mongoose.model(
  "Order",
  new mongoose.Schema({
    email: String,
    items: Array,
    amount: Number,
    status: { type: String, default: "Pending" },
    reference: String,
    trackingNumber: String,
    createdAt: { type: Date, default: Date.now }
  })
);

/* ===========================
   🔐 AUTH MIDDLEWARE
=========================== */
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "No token" });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function adminOnly(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "No token" });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== "admin") {
      return res.status(403).json({ error: "Admin only" });
    }
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
  res.json({ status: "TechMart Enterprise API 🚀" });
});

/* ===========================
   🔐 AUTH ROUTES
=========================== */

/* SIGNUP */
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "All fields required" });
    }
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: "User already exists" });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashedPassword });
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.status(201).json({ success: true, token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Signup failed" });
  }
});

/* LOGIN */
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: "User not found" });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ error: "Wrong password" });
    }
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ success: true, token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

/* ===========================
   🛍 PRODUCTS
=========================== */

/* GET ALL PRODUCTS */
app.get("/api/products", async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

/* GET SINGLE PRODUCT */
app.get("/api/products/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

/* CREATE PRODUCT */
app.post("/api/products", adminOnly, async (req, res) => {
  try {
    const product = await Product.create(req.body);
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create product" });
  }
});

/* ===========================
   📦 ORDERS
=========================== */

/* CREATE ORDER */
app.post("/api/orders", auth, async (req, res) => {
  try {
    const { items, amount } = req.body;
    const order = await Order.create({
      email: req.user.email,
      items,
      amount,
      reference: "TX-" + Date.now()
    });
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Order failed" });
  }
});

/* USER ORDERS */
app.get("/api/orders/me", auth, async (req, res) => {
  try {
    const orders = await Order.find({ email: req.user.email });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/* ===========================
   💳 PAYSTACK
=========================== */
app.post("/api/paystack/init", async (req, res) => {
  try {
    const { email, amount, cart } = req.body;
    if (!email || !amount) {
      return res.status(400).json({ error: "Missing payment info" });
    }
    const reference = "TX-" + Date.now();
    await Order.create({
      email,
      items: cart,
      amount,
      reference,
      status: "Pending"
    });
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: amount * 100,
        reference,
        callback_url: `${process.env.FRONTEND_URL}/success`
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    res.json({ url: response.data.data.authorization_url });
  } catch (err) {
    console.error("PAYSTACK ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "Payment failed" });
  }
});

/* ===========================
   👑 ADMIN
=========================== */
app.get("/api/admin/stats", adminOnly, async (req, res) => {
  try {
    const orders = await Order.find();
    const users = await User.find();
    const revenue = orders
      .filter((o) => o.status !== "Cancelled" && o.status !== "Pending")
      .reduce((sum, o) => sum + (o.amount || 0), 0);
    res.json({
      totalOrders: orders.length,
      totalUsers: users.length,
      totalRevenue: revenue
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

/* ===========================
   👑 ADMIN ROUTES
=========================== */

/* GET ALL ORDERS */
app.get("/api/admin/orders", adminOnly, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/* UPDATE ORDER STATUS */
app.put("/api/admin/orders/:id", adminOnly, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update order" });
  }
});

/* GET ALL USERS */
app.get("/api/admin/users", adminOnly, async (req, res) => {
  try {
    const users = await User.find().select("-password").sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

/* DELETE PRODUCT */
app.delete("/api/products/:id", adminOnly, async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete product" });
  }
});

/* UPDATE PRODUCT */
app.put("/api/products/:id", adminOnly, async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update product" });
  }
});

/* ADMIN STATS WITH REVENUE BY DATE */
app.get("/api/admin/analytics", adminOnly, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    const users = await User.find();

    const revenue = orders
      .filter((o) => o.status !== "Cancelled" && o.status !== "Pending")
      .reduce((sum, o) => sum + (o.amount || 0), 0);

    const revenueByDate = {};
    orders
      .filter((o) => o.status !== "Cancelled" && o.status !== "Pending")
      .forEach((o) => {
        const date = new Date(o.createdAt).toLocaleDateString("en-NG");
        revenueByDate[date] = (revenueByDate[date] || 0) + o.amount;
      });

    res.json({
      totalOrders: orders.length,
      totalUsers: users.length,
      totalRevenue: revenue,
      revenueByDate,
      recentOrders: orders.slice(0, 5),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

/* ===========================
   📦 TRACKING
=========================== */

/* GET ORDER BY REFERENCE */
app.get("/api/orders/track/:reference", async (req, res) => {
  try {
    const order = await Order.findOne({
      reference: req.params.reference
    });
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to track order" });
  }
});

/* GET MY ORDERS */
app.get("/api/orders/my", auth, async (req, res) => {
  try {
    const orders = await Order.find({
      email: req.user.email
    }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/* UPDATE TRACKING (admin) */
app.put("/api/orders/:id/tracking", adminOnly, async (req, res) => {
  try {
    const { trackingNumber, status } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { trackingNumber, status },
      { new: true }
    );
    
    // Emit socket event to notify customer
    io.emit("orderUpdated", {
      orderId: order._id,
      status: order.status,
      trackingNumber: order.trackingNumber
    });

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update tracking" });
  }
});
/* ===========================
   ⚡ SOCKET.IO
=========================== */
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});

io.on("connection", (socket) => {
  console.log("⚡ Connected:", socket.id);
  socket.on("disconnect", () => {
    console.log("❌ Disconnected:", socket.id);
  });
});

/* ===========================
   ❌ ERROR HANDLER
=========================== */
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong" });
});

/* ===========================
   🏓 KEEP ALIVE
=========================== */
setInterval(() => {
  fetch("https://techmart-backend-ecbi.onrender.com/")
    .then(() => console.log("🏓 Keep alive ping"))
    .catch(() => console.log("⚠️ Ping failed"));
}, 14 * 60 * 1000);

/* ===========================
   🚀 START SERVER
=========================== */
const PORT = process.env.PORT || 5002;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});