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
   ORDER SCHEMA
=========================== */
const orderSchema = new mongoose.Schema({
  customerName: String,
  email: String,
  address: String,
  items: Array,
  totalAmount: Number,
  paymentReference: String,
  status: { type: String, default: "Paid" },
  createdAt: { type: Date, default: Date.now }
});

const Order = mongoose.model("Order", orderSchema);

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
   GET SINGLE ORDER
=========================== */
app.get("/api/orders/:id", async (req, res) => {

  try {

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(order);

  } catch (err) {

    res.status(404).json({ error: "Order not found" });

  }

});

/* ===========================
   PAYSTACK INITIALIZE
=========================== */
app.post("/initialize-payment", async (req, res) => {

  const { email, amount } = req.body;

  try {

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: Math.round(amount * 100)
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

    res.status(500).json({
      error: "Payment initialization failed"
    });

  }

});

/* ===========================
   VERIFY PAYMENT + SAVE ORDER
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

    const paymentData = response.data.data;

    console.log("Paystack verification:", paymentData);

    if (paymentData.status === "success") {

      const newOrder = new Order({
        customerName: orderData.customerName,
        email: orderData.email,
        address: orderData.address,
        items: orderData.items,
        totalAmount: orderData.totalAmount,
        paymentReference: reference,
        status: "Paid"
      });

      const savedOrder = await newOrder.save();

      return res.json({
        success: true,
        orderId: savedOrder._id
      });

    }

    return res.json({ success: false });

  } catch (error) {

    console.error("Verification Error:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: "Verification failed"
    });

  }

});

/* ===========================
   START SERVER
=========================== */
app.listen(PORT, () => {

  console.log(`🚀 Server running on port ${PORT}`);

});