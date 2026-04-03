require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

// Cloudinary + Upload
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
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

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "techmart",
    allowed_formats: ["jpg", "png", "jpeg"]
  }
});

const upload = multer({ storage });

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
const productSchema = new mongoose.Schema({
  name: String,
  slug: String,
  price: Number,
  description: String,
  stock: Number,
  image: String,
  reviews: [],
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
  status: { type: String, default: "Processing" },
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
      process.env.JWT_SECRET || "secretkey",
      { expiresIn: "1d" }
    );

    return res.json({ success: true, token });
  }

  res.json({ success: false, message: "Invalid credentials" });
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
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secretkey");

    if (decoded.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    next();

  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ===========================
   PRODUCTS
=========================== */

// GET ALL
app.get("/api/products", async (req, res) => {
  const products = await Product.find();
  res.json(products);
});

// ADD PRODUCT WITH IMAGE
app.post("/api/products", verifyAdmin, upload.single("image"), async (req, res) => {
  try {

    const { name, price, description, stock } = req.body;

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    const product = new Product({
      name,
      slug,
      price,
      description,
      stock,
      image: req.file ? req.file.path : ""
    });

    await product.save();

    res.json(product);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// DELETE PRODUCT
app.delete("/api/products/:id", verifyAdmin, async (req, res) => {
  await Product.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

/* ===========================
   PAYSTACK INIT
=========================== */
app.post("/initialize-payment", async (req, res) => {

  const { email, amount } = req.body;

  try {

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
    console.error(err);
    res.status(500).json({ error: "Payment failed" });
  }
});

/* ===========================
   VERIFY PAYMENT + ORDER
=========================== */
app.post("/verify-payment", async (req, res) => {

  const { reference, orderData } = req.body;

  try {

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    if (response.data.data.status === "success") {

      const newOrder = new Order({
        ...orderData,
        trackingNumber: "DHL" + Math.floor(Math.random() * 1000000),
        carrier: "DHL"
      });

      const savedOrder = await newOrder.save();

      // SEND EMAIL
      await transporter.sendMail({
        from: `"TechMart" <${process.env.EMAIL_USER}>`,
        to: orderData.email,
        subject: "Order Confirmation",
        html: `<h2>Thank you for your order!</h2>
               <p>Order ID: ${savedOrder._id}</p>
               <p>Total: ₦${savedOrder.totalAmount}</p>`
      });

      return res.json({
        success: true,
        orderId: savedOrder._id
      });
    }

    res.json({ success: false });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===========================
   ORDERS
=========================== */
app.get("/api/orders", verifyAdmin, async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 });
  res.json(orders);
});

/* ===========================
   TRACK ORDER
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
   START SERVER
=========================== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});