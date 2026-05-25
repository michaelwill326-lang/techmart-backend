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
const Groq = require("groq-sdk");

const aiRoutes = require("./routes/ai");
const { sendOrderConfirmation, sendWelcomeEmail, sendShippingUpdate } = require("./utils/email");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage });
const app = express();
app.set("trust proxy", 1);

/* ===========================
   🔒 SECURITY
=========================== */
app.use(helmet());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: "Too many requests, try again later." }
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
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("CORS blocked: " + origin));
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
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

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
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: String, default: null },
    referralCount: { type: Number, default: 0 },
    referralCredits: { type: Number, default: 0 },
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
        email: String,
        comment: String,
        stars: Number,
        verified: { type: Boolean, default: false },
        approved: { type: Boolean, default: false },
        flagged: { type: Boolean, default: false },
        sentiment: { type: String, default: "neutral" },
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
   🎁 REFERRAL CODE GENERATOR
=========================== */
function generateReferralCode(name) {
  const clean = name.replace(/\s+/g, "").toUpperCase().slice(0, 5);
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${clean}${random}`;
}
/* ===========================
   🔐 AUTH MIDDLEWARE
=========================== */
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
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
    if (decoded.role !== "admin") return res.status(403).json({ error: "Admin only" });
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
    if (!name || !email || !password) return res.status(400).json({ error: "All fields required" });
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: "User already exists" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashedPassword });
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // 📧 SEND WELCOME EMAIL
    try {
      await sendWelcomeEmail(user);
    } catch (e) {
      console.log("Welcome email failed:", e.message);
    }

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
    if (!user) return res.status(400).json({ error: "User not found" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Wrong password" });
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
app.get("/api/products", async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

app.post("/api/products", adminOnly, async (req, res) => {
  try {
    const product = await Product.create(req.body);
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create product" });
  }
});

app.put("/api/products/:id", adminOnly, async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update product" });
  }
});

app.delete("/api/products/:id", adminOnly, async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete product" });
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
      reference: "TX-" + Date.now()
    });
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Order failed" });
  }
});

app.get("/api/orders/me", auth, async (req, res) => {
  try {
    const orders = await Order.find({ email: req.user.email });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/* =========================================================================
   💳 PAYSTACK (INTEGRATED WITH ATOMIC STOCK HANDLING & IDEMPOTENT WEBHOOK)
========================================================================= */

/* 1. INITIALIZE TRANSACTION & LOCK STOCK */
app.post("/api/paystack/init", async (req, res) => {
  try {
    const { email, amount, cart } = req.body;
    if (!email || !amount || !cart || cart.length === 0) {
      return res.status(400).json({ error: "Missing checkout payload information" });
    }

    const reference = "TX-" + Date.now();
    const allocatedItems = [];

    // ⚡ RUN ATOMIC CHECK & DECREMENT LOOP FOR ALL CART ITEMS
    try {
      for (const item of cart) {
        // Find item and decrement stock ONLY if existing stock is >= requested qty
        const updatedProduct = await Product.findOneAndUpdate(
          {
            _id: item._id || item.productId,
            stock: { $gte: item.quantity || 1 }
          },
          {
            $inc: { stock: -(item.quantity || 1) }
          },
          { new: true }
        );

        // If update yields null, it means stock is insufficient
        if (!updatedProduct) {
          throw new Error(`Item "${item.name || 'Product'}" is out of stock or unavailable.`);
        }

        // Log local tracking array to roll back changes if an upcoming item checks out failing
        allocatedItems.push({
          productId: item._id || item.productId,
          quantity: item.quantity || 1
        });
      }
    } catch (stockError) {
      // 🔄 ROLLBACK COMPLETED DECREMENTS IF THE TRANSACTION CALL ABORTS MID-LOOP
      for (const rollbackItem of allocatedItems) {
        await Product.findByIdAndUpdate(rollbackItem.productId, {
          $inc: { stock: rollbackItem.quantity }
        });
      }
      return res.status(400).json({ error: stockError.message });
    }

    // Create pending database record since items are locked down securely
    await Order.create({ email, items: cart, amount, reference, status: "Pending" });

    // 📧 SEND ORDER CONFIRMATION EMAIL
    try {
      await sendOrderConfirmation({ email, items: cart, amount, reference });
    } catch (e) {
      console.log("Order confirmation email failed:", e.message);
    }

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
    res.status(500).json({ error: "Payment routing setup failed" });
  }
});

/* 2. SECURE & IDEMPOTENT WEBHOOK RECEIVER */
app.post("/api/paystack/webhook", async (req, res) => {
  try {
    const crypto = require("crypto");
    const hash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      return res.status(401).json({ error: "Invalid webhook signature token" });
    }

    const event = req.body;

    if (event.event === "charge.success") {
      const { reference, customer } = event.data;

      console.log(`📦 Processing webhook for Reference: ${reference}`);

      // ENFORCE IDEMPOTENCY VIA MONGOOSE CONDITIONAL UPDATE
      const updatedOrder = await Order.findOneAndUpdate(
        { 
          reference: reference,
          status: "Pending" 
        },
        { 
          $set: { status: "Paid" } 
        },
        { new: true }
      );

      if (!updatedOrder) {
        console.log(`⚠️ Webhook Ignored: Reference ${reference} was already marked as Paid or doesn't exist.`);
        return res.status(200).json({ status: "success", message: "Already processed" });
      }

      console.log(`✅ Order ${reference} successfully confirmed and updated via webhook.`);
      
      if (io) {
        io.emit("paymentConfirmed", { reference, email: customer.email });
      }
    }

    return res.status(200).json({ status: "success" });

  } catch (err) {
    console.error("❌ WEBHOOK ERROR:", err.message);
    return res.status(500).json({ error: "Webhook system processing failed" });
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
    res.json({ totalOrders: orders.length, totalUsers: users.length, totalRevenue: revenue });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

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

    // 📧 SEND SHIPPING EMAIL
    if (req.body.status === "Shipped") {
      try {
        await sendShippingUpdate(order);
      } catch (e) {
        console.log("Shipping email failed:", e.message);
      }
    }

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update order" });
  }
});

app.get("/api/admin/users", adminOnly, async (req, res) => {
  try {
    const users = await User.find().select("-password").sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

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
   ⭐ REVIEWS
=========================== */

/* ADD REVIEW - verified buyers only */
app.post("/api/products/:id/review", auth, async (req, res) => {
  try {
    const { comment, stars } = req.body;
    if (!comment || !stars) return res.status(400).json({ error: "Comment and stars required" });

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    const order = await Order.findOne({
      email: req.user.email,
      status: { $in: ["Paid", "Shipped", "Delivered"] },
    });
    const isVerified = !!order;

    const alreadyReviewed = product.reviews.find((r) => r.email === req.user.email);
    if (alreadyReviewed) return res.status(400).json({ error: "You already reviewed this product" });

    let sentiment = "neutral";
    try {
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const sentimentRes = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: `Analyze the sentiment of this product review and respond with ONLY one word: "positive", "negative", or "neutral". Nothing else.`
          },
          { role: "user", content: comment }
        ],
        max_tokens: 10,
        temperature: 0,
      });
      const raw = sentimentRes.choices[0]?.message?.content?.trim().toLowerCase();
      if (["positive", "negative", "neutral"].includes(raw)) sentiment = raw;
    } catch (err) {
      console.log("Sentiment analysis failed:", err.message);
    }

    const review = {
      user: req.user.email.split("@")[0],
      email: req.user.email,
      comment,
      stars: Number(stars),
      verified: isVerified,
      approved: false,
      flagged: false,
      sentiment,
      createdAt: new Date(),
    };

    product.reviews.push(review);

    const approvedReviews = product.reviews.filter((r) => r.approved);
    if (approvedReviews.length > 0) {
      product.rating = (
        approvedReviews.reduce((sum, r) => sum + r.stars, 0) / approvedReviews.length
      ).toFixed(1);
    }

    await product.save();
    res.json({ success: true, message: "Review submitted and pending approval" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to submit review" });
  }
});

/* GET PENDING REVIEWS - admin */
app.get("/api/admin/reviews/pending", adminOnly, async (req, res) => {
  try {
    const products = await Product.find({ "reviews.approved": false });
    const pending = [];
    products.forEach((p) => {
      p.reviews
        .filter((r) => !r.approved && !r.flagged)
        .forEach((r) => {
          pending.push({ ...r.toObject(), productId: p._id, productName: p.name });
        });
    });
    res.json(pending);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch pending reviews" });
  }
});

/* GET FLAGGED REVIEWS - admin */
app.get("/api/admin/reviews/flagged", adminOnly, async (req, res) => {
  try {
    const products = await Product.find({ "reviews.flagged": true });
    const flagged = [];
    products.forEach((p) => {
      p.reviews
        .filter((r) => r.flagged)
        .forEach((r) => {
          flagged.push({ ...r.toObject(), productId: p._id, productName: p.name });
        });
    });
    res.json(flagged);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch flagged reviews" });
  }
});

/* APPROVE REVIEW - admin */
app.put("/api/products/:id/review/:reviewId/approve", adminOnly, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    const review = product.reviews.id(req.params.reviewId);
    if (!review) return res.status(404).json({ error: "Review not found" });
    review.approved = true;
    review.flagged = false;
    const approvedReviews = product.reviews.filter((r) => r.approved);
    if (approvedReviews.length > 0) {
      product.rating = (
        approvedReviews.reduce((sum, r) => sum + r.stars, 0) / approvedReviews.length
      ).toFixed(1);
    }
    await product.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to approve review" });
  }
});

/* FLAG REVIEW */
app.put("/api/products/:id/review/:reviewId/flag", auth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    const review = product.reviews.id(req.params.reviewId);
    if (!review) return res.status(404).json({ error: "Review not found" });
    review.flagged = true;
    review.approved = false;
    await product.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to flag review" });
  }
});

/* DELETE REVIEW - admin */
app.delete("/api/products/:id/review/:reviewId", adminOnly, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    product.reviews = product.reviews.filter(
      (r) => r._id.toString() !== req.params.reviewId
    );
    await product.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete review" });
  }
});

/* GET SENTIMENT ANALYTICS - admin */
app.get("/api/admin/reviews/sentiment", adminOnly, async (req, res) => {
  try {
    const products = await Product.find();
    const stats = { positive: 0, negative: 0, neutral: 0, total: 0 };
    const productSentiments = [];

    products.forEach((p) => {
      const approved = p.reviews.filter((r) => r.approved);
      const pos = approved.filter((r) => r.sentiment === "positive").length;
      const neg = approved.filter((r) => r.sentiment === "negative").length;
      const neu = approved.filter((r) => r.sentiment === "neutral").length;

      stats.positive += pos;
      stats.negative += neg;
      stats.neutral += neu;
      stats.total += approved.length;

      if (approved.length > 0) {
        productSentiments.push({
          name: p.name,
          positive: pos,
          negative: neg,
          neutral: neu,
          total: approved.length,
          score: ((pos - neg) / approved.length * 100).toFixed(0),
        });
      }
    });

    productSentiments.sort((a, b) => b.score - a.score);
    res.json({ stats, productSentiments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch sentiment data" });
  }
});

/* ===========================
   📦 TRACKING
=========================== */
app.get("/api/orders/track/:reference", async (req, res) => {
  try {
    const order = await Order.findOne({ reference: req.params.reference });
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to track order" });
  }
});

app.get("/api/orders/my", auth, async (req, res) => {
  try {
    const orders = await Order.find({ email: req.user.email }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

app.put("/api/orders/:id/tracking", adminOnly, async (req, res) => {
  try {
    const { trackingNumber, status } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { trackingNumber, status },
      { new: true }
    );
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
   🖼️ IMAGE UPLOAD
=========================== */
app.post("/api/upload", adminOnly, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image provided" });

    // Upload to Cloudinary
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          folder: "techmart/products",
          transformation: [
            { width: 800, height: 800, crop: "limit" },
            { quality: "auto" },
            { fetch_format: "auto" }
          ]
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      ).end(req.file.buffer);
    });

    res.json({
      success: true,
      url: result.secure_url,
      public_id: result.public_id,
    });

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Image upload failed" });
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