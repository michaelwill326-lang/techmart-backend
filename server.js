require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const app = express();

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
.catch(err=>console.log("❌ Mongo Error:", err));

/* ===========================
   USER MODEL
=========================== */
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String
});

const User = mongoose.model("User", userSchema);

/* ===========================
   ORDER MODEL (UPGRADED)
=========================== */
const orderSchema = new mongoose.Schema({
  userId: String,
  totalAmount: Number,

  status: {
    type:String,
    default:"Processing"
  },

  trackingNumber: {
    type:String,
    default: () => "TRK" + Date.now()
  },

  items: [
    {
      name: String,
      price: Number,
      quantity: Number,
      image: String
    }
  ]

},{ timestamps:true });

const Order = mongoose.model("Order", orderSchema);

/* ===========================
   AUTH MIDDLEWARE
=========================== */
function auth(req,res,next){

  const header = req.headers.authorization;

  if(!header){
    return res.status(401).json({ error:"No token" });
  }

  const token = header.split(" ")[1];

  try{
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  }catch{
    return res.status(401).json({ error:"Invalid token" });
  }
}

/* ===========================
   REGISTER
=========================== */
app.post("/api/register", async (req,res)=>{

  let { name, email, password } = req.body;

  name = name?.trim();
  email = email?.trim();
  password = password?.trim();

  if(!name || !email || !password){
    return res.status(400).json({
      success:false,
      message:"All fields are required"
    });
  }

  const exists = await User.findOne({ email });

  if(exists){
    return res.json({
      success:false,
      message:"User already exists"
    });
  }

  const hashed = await bcrypt.hash(password,10);

  const user = new User({
    name,
    email,
    password: hashed
  });

  await user.save();

  res.json({ success:true });

});

/* ===========================
   LOGIN
=========================== */
app.post("/api/login", async (req,res)=>{

  let { email, password } = req.body;

  email = email?.trim();
  password = password?.trim();

  if(!email || !password){
    return res.status(400).json({
      success:false,
      message:"Email and password required"
    });
  }

  const user = await User.findOne({ email });

  if(!user){
    return res.json({
      success:false,
      message:"User not found"
    });
  }

  const match = await bcrypt.compare(password, user.password);

  if(!match){
    return res.json({
      success:false,
      message:"Wrong password"
    });
  }

  const token = jwt.sign(
    { id:user._id },
    process.env.JWT_SECRET,
    { expiresIn:"7d" }
  );

  res.json({
    success:true,
    token,
    user:{
      name:user.name,
      email:user.email
    }
  });

});

/* ===========================
   PROFILE
=========================== */
app.get("/api/profile", auth, async (req,res)=>{
  const user = await User.findById(req.userId).select("-password");
  res.json(user);
});

/* ===========================
   CREATE ORDER
=========================== */
app.post("/api/create-order", auth, async (req,res)=>{

  const { totalAmount, items } = req.body;

  if(!totalAmount || !items){
    return res.status(400).json({
      success:false,
      message:"Missing order data"
    });
  }

  const order = new Order({
    userId: req.userId,
    totalAmount,
    items
  });

  await order.save();

  res.json({
    success:true,
    order
  });

});

/* ===========================
   GET MY ORDERS
=========================== */
app.get("/api/my-orders", auth, async (req,res)=>{

  const orders = await Order.find({ userId:req.userId })
    .sort({ createdAt:-1 });

  res.json(orders);

});

/* ===========================
   TRACK ORDER
=========================== */
app.get("/api/track/:trackingNumber", async (req,res)=>{

  const order = await Order.findOne({
    trackingNumber: req.params.trackingNumber
  });

  if(!order){
    return res.json({ error:"Order not found" });
  }

  res.json({
    trackingNumber: order.trackingNumber,
    status: order.status,
    items: order.items,
    totalAmount: order.totalAmount
  });

});

/* ===========================
   PAYSTACK PAYMENT
=========================== */
app.post("/initialize-payment", async (req,res)=>{

  const { email, amount } = req.body;

  try{

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: amount * 100,
        callback_url: "https://techmart-jb9k.onrender.com/success.html"
      },
      {
        headers:{
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type":"application/json"
        }
      }
    );

    res.json(response.data);

  }catch(err){
    console.error("PAYSTACK ERROR:", err.response?.data || err.message);
    res.status(500).json({ error:"Payment failed" });
  }

});

/* ===========================
   START SERVER
=========================== */
const PORT = process.env.PORT || 10000;

app.listen(PORT, ()=>{
  console.log("🚀 Server running on port " + PORT);
});