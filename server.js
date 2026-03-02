require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const axios = require("axios");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 5002;

app.use(cors());
app.use(express.json());

/* =====================================================
   ✅ MONGODB CONNECTION
===================================================== */

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

/* =====================================================
   ✅ ORDER SCHEMA
===================================================== */

const orderSchema = new mongoose.Schema({
  customerName: String,
  email: String,
  address: String,
  items: [
    {
      name: String,
      quantity: Number,
      price: Number
    }
  ],
  totalAmount: Number,
  paymentReference: String,
  paymentStatus: { type: String, default: "Pending" },
  createdAt: { type: Date, default: Date.now }
});

const Order = mongoose.model("Order", orderSchema);

/* =====================================================
   ✅ ADMIN SCHEMA
===================================================== */

const adminSchema = new mongoose.Schema({
  email: String,
  password: String
});

const Admin = mongoose.model("Admin", adminSchema);

/* =====================================================
   ✅ ADMIN REGISTER (One-time use)
===================================================== */

app.post("/api/admin/register", async (req, res) => {
  const { email, password } = req.body;

  const hashedPassword = await bcrypt.hash(password, 10);

  const admin = new Admin({
    email,
    password: hashedPassword
  });

  await admin.save();
  res.json({ message: "Admin created successfully" });
});

/* =====================================================
   ✅ ADMIN LOGIN
===================================================== */

app.post("/api/admin/login", async (req, res) => {
  const { email, password } = req.body;

  const admin = await Admin.findOne({ email });
  if (!admin) return res.status(400).json({ message: "Admin not found" });

  const isMatch = await bcrypt.compare(password, admin.password);
  if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });

  const token = jwt.sign({ id: admin._id }, process.env.JWT_SECRET, {
    expiresIn: "1d"
  });

  res.json({ token });
});

/* =====================================================
   ✅ PAYSTACK INITIALIZE PAYMENT
===================================================== */

app.post("/initialize-payment", async (req, res) => {
  const { email, amount } = req.body;

  try {
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: amount * 100
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("Paystack Init Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Payment initialization failed" });
  }
});

/* =====================================================
   ✅ PAYSTACK VERIFY + SAVE ORDER
===================================================== */

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

    const paymentData = response.data.data;

    if (paymentData.status === "success") {
      const newOrder = new Order({
        ...orderData,
        paymentReference: reference,
        paymentStatus: "Paid"
      });

      await newOrder.save();

      res.json({ success: true });
    } else {
      res.json({ success: false });
    }

  } catch (error) {
    console.error("Verification Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Verification failed" });
  }
});

/* =====================================================
   ✅ GET ALL ORDERS (Admin)
===================================================== */

app.get("/api/orders", async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 });
  res.json(orders);
});

/* =====================================================
   ✅ START SERVER
===================================================== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});