require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const app = express();

app.use(cors());
app.use(express.json());

console.log("🔥 NEW VERSION DEPLOYED");

/* ===========================
   MONGODB
=========================== */
mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log("✅ MongoDB Connected"))
.catch(err=>console.log("❌ Mongo Error:", err));

/* ===========================
   MODELS
=========================== */

// USER
const userSchema = new mongoose.Schema({
  name:String,
  email:{ type:String, unique:true },
  password:String
});
const User = mongoose.model("User", userSchema);

// ORDER
const orderSchema = new mongoose.Schema({
  userId:String,
  email:String,
  totalAmount:Number,
  paymentReference:String,

  status:{
    type:String,
    default:"Processing"
  },

  trackingNumber:{
    type:String,
    default:()=> "TRK" + Date.now()
  },

  items:[
    {
      name:String,
      price:Number,
      quantity:Number,
      image:String
    }
  ]

},{ timestamps:true });

const Order = mongoose.model("Order", orderSchema);

/* ===========================
   PRODUCTS (FIXED)
=========================== */

const products = [
  {
    _id:"1",
    name:"Wireless Headphones",
    price:25000,
    image:"https://via.placeholder.com/200"
  },
  {
    _id:"2",
    name:"Smart Watch",
    price:40000,
    image:"https://via.placeholder.com/200"
  },
  {
    _id:"3",
    name:"Laptop",
    price:350000,
    image:"https://via.placeholder.com/200"
  }
];

app.get("/api/products",(req,res)=>{
  res.json(products);
});

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
   AUTH
=========================== */

// REGISTER
app.post("/api/register", async (req,res)=>{

  let { name,email,password } = req.body;

  name = name?.trim();
  email = email?.trim();
  password = password?.trim();

  if(!name || !email || !password){
    return res.status(400).json({ success:false });
  }

  const exists = await User.findOne({ email });
  if(exists){
    return res.json({ success:false, message:"User exists" });
  }

  const hashed = await bcrypt.hash(password,10);

  const user = new User({
    name,
    email,
    password:hashed
  });

  await user.save();

  res.json({ success:true });
});

// LOGIN
app.post("/api/login", async (req,res)=>{

  let { email,password } = req.body;

  email = email?.trim();
  password = password?.trim();

  const user = await User.findOne({ email });

  if(!user){
    return res.json({ success:false });
  }

  const match = await bcrypt.compare(password,user.password);

  if(!match){
    return res.json({ success:false });
  }

  const token = jwt.sign(
    { id:user._id },
    process.env.JWT_SECRET,
    { expiresIn:"7d" }
  );

  res.json({
    success:true,
    token,
    user
  });

});

/* ===========================
   ORDERS
=========================== */

app.get("/api/my-orders", auth, async (req,res)=>{
  const orders = await Order.find({ userId:req.userId })
  .sort({ createdAt:-1 });

  res.json(orders);
});

app.get("/api/track/:trackingNumber", async (req,res)=>{
  const order = await Order.findOne({
    trackingNumber:req.params.trackingNumber
  });

  if(!order){
    return res.json({ error:"Not found" });
  }

  res.json(order);
});

/* ===========================
   PAYSTACK INIT
=========================== */
app.post("/initialize-payment", async (req,res)=>{

  try{

    const { email, amount, items, userId } = req.body;

    console.log("PAYSTACK INPUT:", { email, amount });

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: Math.round(amount * 100), // ✅ FIXED
        callback_url: `${process.env.FRONTEND_URL}/success`,
        metadata:{
          items,
          userId,
          amount
        }
      },
      {
        headers:{
          Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type":"application/json"
        }
      }
    );

    res.json({
      authorization_url: response.data.data.authorization_url
    });

  }catch(err){

    console.error("PAYSTACK ERROR:", err.response?.data || err.message);

    res.status(500).json({
      error:"Payment failed",
      details: err.response?.data
    });

  }

});

/* ===========================
   VERIFY PAYMENT
=========================== */
app.get("/verify-payment/:reference", async (req,res)=>{

  try{

    const { reference } = req.params;

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers:{
          Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const data = response.data.data;

    if(data.status === "success"){

      const metadata = data.metadata;

      const order = new Order({
        userId: metadata.userId,
        email: data.customer.email,
        totalAmount: metadata.amount,
        paymentReference: reference,
        items: metadata.items
      });

      await order.save();

      return res.json({
        success:true,
        order
      });

    }else{
      return res.json({ success:false });
    }

  }catch(err){
    console.error(err);
    res.status(500).json({ error:"Verification failed" });
  }

});

/* ===========================
   SERVER
=========================== */
const PORT = process.env.PORT || 5002;

app.listen(PORT,()=>{
  console.log("🚀 Server running on port " + PORT);
});