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
🌐 CORS FIX (IMPORTANT)
=========================== */
const allowedOrigins = [
  "http://localhost:5173",
  "https://techmart-frontend.onrender.com"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS blocked"));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

/* ===========================
⚡ MIDDLEWARE
=========================== */
app.use(express.json());
app.use(compression());

/* ===========================
🏠 ROOT ROUTE (FIXED)
=========================== */
app.get("/", (req, res) => {
  res.json({
    message: "🚀 TechMart Backend is running",
    status: "OK"
  });
});

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
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ Mongo Error:", err));

/* ===========================
📊 MODELS
=========================== */
const User = mongoose.model("User", new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  isAdmin: { type: Boolean, default: false }
}));

const Order = mongoose.model("Order", new mongoose.Schema({
  name: String,
  email: String,
  items: Array,
  amount: Number,
  status: { type: String, default: "Pending" },
  trackingNumber: String,
  carrier: String,
  createdAt: { type: Date, default: Date.now }
}));

/* ===========================
🔐 AUTH MIDDLEWARE
=========================== */
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "No token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.isAdmin) {
      return res.status(403).json({ error: "Not admin" });
    }

    req.userId = decoded.id;
    next();

  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ===========================
🔐 ADMIN LOGIN
=========================== */
app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log("LOGIN ATTEMPT:", email);

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Missing fields"
      });
    }

    const user = await User.findOne({ email });

    if (!user || !user.isAdmin) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials"
      });
    }

    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials"
      });
    }

    const token = jwt.sign(
      { id: user._id, isAdmin: true },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      token,
      email: user.email
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

/* ===========================
🧪 TEST ROUTE
=========================== */
app.get("/api/admin/test", adminAuth, (req, res) => {
  res.json({
    message: "Admin access granted ✅",
    userId: req.userId
  });
});

/* ===========================
📦 GET PRODUCTS (IMPORTANT)
=========================== */
app.get("/api/products", async (req, res) => {
  try {
    const products = await mongoose.connection.db
      .collection("products")
      .find()
      .toArray();

    res.json(products);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

/* ===========================
📦 GET ORDERS (ADMIN)
=========================== */
app.get("/api/admin/orders", adminAuth, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/* ===========================
✏️ UPDATE ORDER STATUS
=========================== */
app.put("/api/admin/orders/:id/status", adminAuth, async (req, res) => {
  try {
    const { status } = req.body;

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "Failed to update status" });
  }
});

/* ===========================
🚚 ADD TRACKING
=========================== */
app.put("/api/admin/orders/:id/tracking", adminAuth, async (req, res) => {
  try {
    const { trackingNumber, carrier } = req.body;

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { trackingNumber, carrier },
      { new: true }
    );

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "Failed to update tracking" });
  }
});

/* ===========================
📊 EXPORT CSV
=========================== */
app.get("/api/admin/orders/export", adminAuth, async (req, res) => {
  try {
    const orders = await Order.find();

    const parser = new Parser();
    const csv = parser.parse(orders);

    res.header("Content-Type", "text/csv");
    res.attachment("orders.csv");
    res.send(csv);

  } catch (err) {
    res.status(500).json({ error: "Export failed" });
  }
});

/* ===========================
🌍 TRACK ORDER (PUBLIC)
=========================== */
app.get("/api/orders/track/:trackingNumber", async (req, res) => {
  try {
    const order = await Order.findOne({
      trackingNumber: req.params.trackingNumber
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(order);

  } catch (err) {
    res.status(500).json({ error: "Tracking failed" });
  }
});

/* ===========================
🚀 SERVER + SOCKET.IO
=========================== */
const PORT = process.env.PORT || 10000;
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins
  }
});

io.on("connection", (socket) => {
  console.log("⚡ Client connected:", socket.id);
});

server.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});