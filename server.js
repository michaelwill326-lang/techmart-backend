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
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.log(err));

/* ===========================
   👤 MODELS
=========================== */
const User = mongoose.model(
  "User",
  new mongoose.Schema({
    name: String,
    email: String,
    password: String,
    role: { type: String, default: "customer" },
    createdAt: { type: Date, default: Date.now },
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
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    createdAt: {
      type: Date,
      default: Date.now,
    },
  })
);

const Order = mongoose.model(
  "Order",
  new mongoose.Schema({
    email: String,
    items: Array,
    amount: Number,
    status: {
      type: String,
      default: "Pending",
    },
    reference: String,
    trackingNumber: String,

    createdAt: {
      type: Date,
      default: Date.now,
    },
  })
);

/* ===========================
   🔐 AUTH MIDDLEWARE
=========================== */
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      error: "No token",
    });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    req.user = decoded;

    next();
  } catch {
    return res.status(401).json({
      error: "Invalid token",
    });
  }
}

function adminOnly(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      error: "No token",
    });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    if (decoded.role !== "admin") {
      return res.status(403).json({
        error: "Admin only",
      });
    }

    req.user = decoded;

    next();
  } catch {
    return res.status(401).json({
      error: "Invalid token",
    });
  }
}

/* ===========================
   🏠 ROOT
=========================== */
app.get("/", (req, res) => {
  res.json({
    status: "TechMart Enterprise API 🚀",
  });
});

/* ===========================
   🔐 AUTH ROUTES
=========================== */
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const exists = await User.findOne({ email });

    if (exists) {
      return res.status(400).json({
        error: "User exists",
      });
    }

    const hashed = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email,
      password: hashed,
    });

    const token = jwt.sign(
      {
        id: user._id,
        email: user.email,
        role: user.role,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      }
    );

    res.json({ user, token });
  } catch (err) {
    console.log(err);

    res.status(500).json({
      error: "Signup failed",
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({
        error: "User not found",
      });
    }

    const match = await bcrypt.compare(
      password,
      user.password
    );

    if (!match) {
      return res.status(400).json({
        error: "Wrong password",
      });
    }

    const token = jwt.sign(
      {
        id: user._id,
        email: user.email,
        role: user.role,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      }
    );

    res.json({ user, token });
  } catch (err) {
    console.log(err);

    res.status(500).json({
      error: "Login failed",
    });
  }
});

/* ===========================
   🛍 PRODUCTS
=========================== */

// Get all products
app.get("/api/products", async (req, res) => {
  try {
    const products = await Product.find().sort({
      createdAt: -1,
    });

    res.json(products);
  } catch (err) {
    console.log(err);

    res.status(500).json({
      error: "Failed to fetch products",
    });
  }
});

// Get single product
app.get("/api/products/:id", async (req, res) => {
  try {
    const product = await Product.findById(
      req.params.id
    );

    if (!product) {
      return res.status(404).json({
        error: "Product not found",
      });
    }

    res.json(product);
  } catch (err) {
    console.log(err);

    res.status(500).json({
      error: "Failed to fetch product",
    });
  }
});

// Create product
app.post("/api/products", adminOnly, async (req, res) => {
  try {
    const {
      name,
      price,
      images,
      description,
      stock,
      vendorId,
      vendorName,
      category,
    } = req.body;

    const product = await Product.create({
      name,
      price,
      images,
      description,
      stock,
      vendorId,
      vendorName,
      category,
    });

    res.json(product);
  } catch (err) {
    console.log(err);

    res.status(500).json({
      error: "Failed to create product",
    });
  }
});

/* ===========================
   📦 ORDERS
=========================== */
app.post("/api/orders", auth, async (req, res) => {
  try {
    const { items, amount } = req.body;

    const order = await Order.create({
      email: req.user.email,
      items,
      amount,
      reference: "TX-" + Date.now(),
    });

    res.json(order);
  } catch (err) {
    console.log(err);

    res.status(500).json({
      error: "Order failed",
    });
  }
});

app.get("/api/orders/me", auth, async (req, res) => {
  try {
    const orders = await Order.find({
      email: req.user.email,
    });

    res.json(orders);
  } catch (err) {
    console.log(err);

    res.status(500).json({
      error: "Failed to fetch orders",
    });
  }
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
      reference,
    });

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: amount * 100,
        reference,
        callback_url: `${process.env.FRONTEND_URL}/success`,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    res.json({
      url: response.data.data.authorization_url,
    });
  } catch (err) {
    console.log(err);

    res.status(500).json({
      error: "Payment initialization failed",
    });
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
      .filter((o) => o.status === "Paid")
      .reduce((sum, o) => sum + o.amount, 0);

    res.json({
      totalOrders: orders.length,
      totalUsers: users.length,
      totalRevenue: revenue,
    });
  } catch (err) {
    console.log(err);

    res.status(500).json({
      error: "Failed to fetch stats",
    });
  }
});

/* ===========================
   ⚡ SOCKET.IO
=========================== */
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

io.on("connection", (socket) => {
  console.log("⚡ Connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("❌ Disconnected:", socket.id);
  });
});

/* ===========================
   🚀 START SERVER
=========================== */
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(
    `🚀 Server running on port ${PORT}`
  );
});