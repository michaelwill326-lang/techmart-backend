require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

/* ===========================
   🌐 MIDDLEWARE
=========================== */
app.use(cors({ origin: "*" }));
app.use(express.json());

/* ===========================
   🧠 DATABASE
=========================== */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log(err));

/* ===========================
   👤 MODELS
=========================== */
const User = mongoose.model("User", new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, default: "customer" }
}));

const Order = mongoose.model("Order", new mongoose.Schema({
  email: String,
  items: Array,
  amount: Number,
  reference: String,
  status: { type: String, default: "Pending" },
  trackingNumber: String,
  createdAt: { type: Date, default: Date.now }
}));

const Product = mongoose.model("Product", new mongoose.Schema({
  name: String,
  price: Number,
  images: [String],
  description: String,
  stock: Number
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

function adminOnly(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) return res.status(401).json({ error: "No token" });

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
   🔐 AUTH
=========================== */
app.post("/api/auth/signup", async (req, res) => {
  const { name, email, password } = req.body;

  const exists = await User.findOne({ email });
  if (exists) return res.status(400).json({ error: "User exists" });

  const hashed = await bcrypt.hash(password, 10);

  const user = await User.create({
    name,
    email,
    password: hashed
  });

  const token = jwt.sign(
    { id: user._id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ user, token });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user) return res.status(400).json({ error: "User not found" });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).json({ error: "Wrong password" });

  const token = jwt.sign(
    { id: user._id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ user, token });
});

/* ===========================
   🛍 PRODUCTS
=========================== */
app.get("/api/products", async (req, res) => {
  const products = await Product.find();
  res.json(products);
});

/* ===========================
   📦 ORDERS
=========================== */
app.post("/api/orders", auth, async (req, res) => {
  const { items, amount } = req.body;

  const order = await Order.create({
    email: req.user.email,
    items,
    amount,
    reference: "TX-" + Date.now()
  });

  res.json(order);
});

app.get("/api/orders/me", auth, async (req, res) => {
  const orders = await Order.find({ email: req.user.email });
  res.json(orders);
});

/* ===========================
   💳 PAYSTACK INIT
=========================== */
app.post("/api/paystack/init", async (req, res) => {
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
      callback_url: `${process.env.FRONTEND_URL}/success`
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      }
    }
  );

  res.json({ url: response.data.data.authorization_url });
});

/* ===========================
   🔍 VERIFY PAYMENT
=========================== */
app.get("/api/paystack/verify/:ref", async (req, res) => {
  const ref = req.params.ref;

  const response = await axios.get(
    `https://api.paystack.co/transaction/verify/${ref}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      }
    }
  );

  const data = response.data.data;

  if (data.status === "success") {
    await Order.findOneAndUpdate(
      { reference: ref },
      { status: "Paid" }
    );
  }

  res.json(data);
});

/* ===========================
   👑 ADMIN APIs
=========================== */
app.get("/api/admin/stats", adminOnly, async (req, res) => {
  const orders = await Order.find();
  const users = await User.find();

  const revenue = orders
    .filter(o => o.status === "Paid")
    .reduce((sum, o) => sum + o.amount, 0);

  res.json({
    totalOrders: orders.length,
    totalUsers: users.length,
    totalRevenue: revenue
  });
});

app.get("/api/admin/orders", adminOnly, async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 });
  res.json(orders);
});

app.put("/api/admin/orders/:id", adminOnly, async (req, res) => {
  const { status, trackingNumber } = req.body;

  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { status, trackingNumber },
    { new: true }
  );

  // 🔔 REAL-TIME EVENT
  io.emit("orderUpdated", order);

  res.json(order);
});
/* ===========================
   📊 ANALYTICS DASHBOARD
=========================== */
app.get("/api/admin/analytics", adminOnly, async (req, res) => {
  try {
    const orders = await Order.find();
    const users = await User.find();

    const totalRevenue = orders
      .filter(o => o.status === "Paid")
      .reduce((sum, o) => sum + o.amount, 0);

    const totalOrders = orders.length;
    const totalUsers = users.length;

    // 📈 Revenue per day
    const revenueByDate = {};

    orders.forEach(order => {
      const date = new Date(order.createdAt).toLocaleDateString();

      if (!revenueByDate[date]) {
        revenueByDate[date] = 0;
      }

      if (order.status === "Paid") {
        revenueByDate[date] += order.amount;
      }
    });

    res.json({
      totalRevenue,
      totalOrders,
      totalUsers,
      revenueByDate
    });

  } catch (err) {
    res.status(500).json({ error: "Analytics failed" });
  }
});
/* ===========================
   ⚡ SOCKET.IO (REAL-TIME)
=========================== */
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const onlineUsers = new Map();

io.on("connection", (socket) => {
  console.log("⚡ Connected:", socket.id);

  socket.on("register", (email) => {
    onlineUsers.set(email, socket.id);
  });

  socket.on("disconnect", () => {
    for (let [email, id] of onlineUsers) {
      if (id === socket.id) {
        onlineUsers.delete(email);
      }
    }
  });
});

/* ===========================
   🚀 START SERVER
=========================== */
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});