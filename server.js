require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;

/* ===========================
   CORS
=========================== */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

/* ===========================
   MONGODB
=========================== */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

/* ===========================
   PRODUCTS ROUTE
=========================== */
const products = [
  {
    id: 1,
    name: "Wireless Headphones",
    price: 99.99,
    description: "Noise-cancelling over-ear headphones with Bluetooth."
  },
  {
    id: 2,
    name: "Smart Watch",
    price: 149.99,
    description: "Fitness tracking and notifications on your wrist."
  },
  {
    id: 3,
    name: "Mechanical Keyboard",
    price: 79.99,
    description: "RGB backlit keyboard with tactile switches."
  },
  {
    id: 4,
    name: "4K Monitor",
    price: 299.99,
    description: "27-inch UHD display with HDR support."
  },
  {
    id: 5,
    name: "Gaming Mouse",
    price: 49.99,
    description: "High DPI precision with customizable buttons."
  }
];

app.get("/api/products", (req, res) => {
  res.json(products);
});

/* ===========================
   PAYSTACK INITIALIZE
=========================== */
app.post("/initialize-payment", async (req, res) => {
  const { email, amount } = req.body;

  try {
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      { email, amount: amount * 100 },
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

/* ===========================
   VERIFY PAYMENT
=========================== */
app.post("/verify-payment", async (req, res) => {
  const { reference } = req.body;

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
      res.json({ success: true });
    } else {
      res.json({ success: false });
    }

  } catch (error) {
    console.error("Verification Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Verification failed" });
  }
});

/* ===========================
   START SERVER
=========================== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});