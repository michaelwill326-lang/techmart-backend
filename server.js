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
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 10000;

/* ===========================
   MIDDLEWARE
=========================== */
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage()
});

/* ===========================
   CLOUDINARY
=========================== */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME?.trim(),
  api_key: process.env.CLOUDINARY_API_KEY?.trim(),
  api_secret: process.env.CLOUDINARY_API_SECRET?.trim()
});

/* ===========================
   MONGODB
=========================== */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

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
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  verified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model("User", userSchema);

const reviewSchema = new mongoose.Schema(
  {
    name: String,
    rating: Number,
    comment: String,
    createdAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const productSchema = new mongoose.Schema({
  name: String,
  slug: String,
  price: Number,
  description: String,
  stock: Number,
  image: String,
  reviews: [reviewSchema],
  createdAt: { type: Date, default: Date.now }
});
const Product = mongoose.model("Product", productSchema);

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
   OTP STORE
=========================== */
const otpStore = {};

/* ===========================
   HELPERS
=========================== */
function createSlug(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function generateTrackingNumber() {
  return "DHL" + Math.floor(100000 + Math.random() * 900000);
}

function verifyAdmin(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "No token" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "secretkey"
    );

    if (decoded.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function verifyUser(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "No token" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "secretkey"
    );

    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

async function uploadImageToCloudinary(fileBuffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "techmart" },
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      }
    );

    streamifier.createReadStream(fileBuffer).pipe(stream);
  });
}

/* ===========================
   USER AUTH
=========================== */
app.post("/api/send-otp", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    otpStore[email] = {
      otp,
      expires: Date.now() + 5 * 60 * 1000
    };

    await transporter.sendMail({
      from: `"TechMart" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Your TechMart OTP Code",
      html: `
        <h2>Your OTP Code</h2>
        <p><strong>${otp}</strong></p>
        <p>This code is valid for 5 minutes.</p>
      `
    });

    res.json({ success: true, message: "OTP sent" });
  } catch (err) {
    console.error("SEND OTP ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to send OTP" });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password, otp } = req.body;

    if (!name || !email || !password || !otp) {
      return res.status(400).json({
        success: false,
        message: "All fields are required"
      });
    }

    const record = otpStore[email];

    if (!record) {
      return res.json({ success: false, message: "OTP not sent" });
    }

    if (record.expires < Date.now()) {
      delete otpStore[email];
      return res.json({ success: false, message: "OTP expired" });
    }

    if (record.otp !== String(otp)) {
      return res.json({ success: false, message: "Invalid OTP" });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.json({ success: false, message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      name,
      email,
      password: hashedPassword,
      verified: true
    });

    await user.save();
    delete otpStore[email];

    res.json({ success: true, message: "Account created successfully" });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ success: false, message: "Registration failed" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.json({ success: false, message: "Invalid credentials" });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.json({ success: false, message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.json({ success: false, message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || "secretkey",
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email
      }
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ success: false, message: "Login failed" });
  }
});

app.get("/api/my-orders", verifyUser, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const orders = await Order.find({ email: user.email }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error("MY ORDERS ERROR:", err);
    res.status(500).json({ error: "Failed to load orders" });
  }
});

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
      process.env.JWT_SECRET || "secretkey",
      { expiresIn: "1d" }
    );

    return res.json({ success: true, token });
  }

  res.json({ success: false, message: "Invalid credentials" });
});

/* ===========================
   PRODUCTS
=========================== */
app.get("/api/products", async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    console.error("GET PRODUCTS ERROR:", err);
    res.status(500).json({ error: "Failed to load products" });
  }
});

app.get("/api/products/:slug", async (req, res) => {
  try {
    const product = await Product.findOne({ slug: req.params.slug });

    if (!product) {
      return res.status(404).json({ error: "Not found" });
    }

    res.json(product);
  } catch (err) {
    console.error("GET PRODUCT ERROR:", err);
    res.status(500).json({ error: "Failed to load product" });
  }
});

app.post("/api/products", verifyAdmin, upload.single("image"), async (req, res) => {
  try {
    const { name, description } = req.body;
    const price = Number(req.body.price);
    const stock = Number(req.body.stock);

    if (!name || Number.isNaN(price) || Number.isNaN(stock)) {
      return res.status(400).json({
        error: "Name, price, and stock are required and must be valid"
      });
    }

    const slug = createSlug(name);

    let imageUrl = "https://via.placeholder.com/400";

    if (req.file) {
      const result = await uploadImageToCloudinary(req.file.buffer);
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
  } catch (err) {
    console.error("PRODUCT UPLOAD ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/products/:id", verifyAdmin, async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE PRODUCT ERROR:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

app.post("/api/products/:slug/reviews", async (req, res) => {
  try {
    const product = await Product.findOne({ slug: req.params.slug });

    if (!product) {
      return res.status(404).json({ error: "Not found" });
    }

    product.reviews.push({
      name: req.body.name,
      rating: Number(req.body.rating),
      comment: req.body.comment
    });

    await product.save();
    res.json(product);
  } catch (err) {
    console.error("ADD REVIEW ERROR:", err);
    res.status(500).json({ error: "Failed to add review" });
  }
});

/* ===========================
   PAYSTACK
=========================== */
app.post("/initialize-payment", async (req, res) => {
  try {
    const { email, amount } = req.body;

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: Math.round(amount * 100),
        callback_url: "https://techmart-jb9k.onrender.com/verify.html"
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    console.error("PAYSTACK INIT ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "Payment failed" });
  }
});

app.post("/verify-payment", async (req, res) => {
  try {
    const { reference, orderData } = req.body;

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    if (response.data.data.status === "success") {
      const trackingNumber = generateTrackingNumber();

      const newOrder = new Order({
        ...orderData,
        paymentReference: reference,
        status: "Processing",
        trackingNumber,
        carrier: "DHL"
      });

      const savedOrder = await newOrder.save();

      await transporter.sendMail({
        from: `"TechMart" <${process.env.EMAIL_USER}>`,
        to: orderData.email,
        subject: "🛒 Order Confirmation - TechMart",
        html: `
          <h2>🛒 Order Confirmed</h2>
          <p><strong>Order ID:</strong> ${savedOrder._id}</p>
          <p><strong>Total:</strong> ₦${savedOrder.totalAmount}</p>
          <p><strong>Tracking Number:</strong> ${trackingNumber}</p>

          <p>
            <a href="https://techmart-jb9k.onrender.com/tracking.html?tracking=${trackingNumber}">
              Track Order
            </a>
          </p>
        `
      });

      return res.json({
        success: true,
        orderId: savedOrder._id,
        trackingNumber
      });
    }

    res.json({ success: false });
  } catch (err) {
    console.error("VERIFY PAYMENT ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===========================
   ORDERS
=========================== */
app.get("/api/orders", verifyAdmin, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error("GET ORDERS ERROR:", err);
    res.status(500).json({ error: "Failed to load orders" });
  }
});

app.put("/api/orders/:id", verifyAdmin, async (req, res) => {
  try {
    const { status } = req.body;

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    res.json(order);
  } catch (err) {
    console.error("UPDATE ORDER ERROR:", err);
    res.status(500).json({ error: "Update failed" });
  }
});

/* ===========================
   TRACK ORDER
=========================== */
app.get("/api/track/:trackingNumber", async (req, res) => {
  try {
    const order = await Order.findOne({
      trackingNumber: req.params.trackingNumber
    });

    if (!order) {
      return res.status(404).json({ error: "Not found" });
    }

    res.json(order);
  } catch (err) {
    console.error("TRACK ORDER ERROR:", err);
    res.status(500).json({ error: "Failed to track order" });
  }
});

/* ===========================
   ROOT
=========================== */
app.get("/", (req, res) => {
  res.send("TechMart Backend Running ✅");
});

/* ===========================
   START
=========================== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});