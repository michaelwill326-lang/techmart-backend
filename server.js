require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 10000;

/* ===========================
   MIDDLEWARE
=========================== */
app.use(cors({
  origin: "*",
  methods: ["GET","POST","PUT","DELETE"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

app.use(express.json());

/* ===========================
   MONGODB
=========================== */
mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log("✅ MongoDB Connected"))
.catch(err=>console.error("❌ MongoDB Error:", err));

/* ===========================
   EMAIL SETUP
=========================== */
const transporter = nodemailer.createTransport({
  service:"gmail",
  auth:{
    user:process.env.EMAIL_USER,
    pass:process.env.EMAIL_PASS
  }
});

/* ===========================
   MODELS
=========================== */

const productSchema = new mongoose.Schema({
  name:String,
  slug:String,
  price:Number,
  description:String,
  stock:Number,
  image:String,
  reviews:[{
    name:String,
    rating:Number,
    comment:String,
    createdAt:{type:Date,default:Date.now}
  }],
  createdAt:{type:Date,default:Date.now}
});

const Product = mongoose.model("Product", productSchema);

const orderSchema = new mongoose.Schema({
  customerName:String,
  email:String,
  address:String,
  items:Array,
  totalAmount:Number,
  paymentReference:String,
  status:{
    type:String,
    enum:["Processing","Shipped","Delivered"],
    default:"Processing"
  },
  trackingNumber:String,
  carrier:String,
  createdAt:{type:Date,default:Date.now}
});

const Order = mongoose.model("Order", orderSchema);

/* ===========================
   ADMIN LOGIN
=========================== */

app.post("/admin/login",(req,res)=>{

  const {email,password} = req.body;

  if(
    email === process.env.ADMIN_EMAIL &&
    password === process.env.ADMIN_PASSWORD
  ){
    const token = jwt.sign(
      {role:"admin"},
      process.env.JWT_SECRET,
      {expiresIn:"1d"}
    );

    return res.json({success:true,token});
  }

  res.status(401).json({success:false,message:"Invalid credentials"});
});

/* ===========================
   ADMIN AUTH
=========================== */

function verifyAdmin(req,res,next){

  const authHeader = req.headers.authorization;

  if(!authHeader){
    return res.status(401).json({error:"No token"});
  }

  const token = authHeader.split(" ")[1];

  try{
    const decoded = jwt.verify(token,process.env.JWT_SECRET);

    if(decoded.role !== "admin"){
      return res.status(403).json({error:"Forbidden"});
    }

    next();
  }catch(err){
    return res.status(401).json({error:"Invalid token"});
  }
}

/* ===========================
   PRODUCTS
=========================== */

app.get("/api/products", async(req,res)=>{
  const products = await Product.find();
  res.json(products);
});

app.get("/api/products/:slug", async(req,res)=>{
  const product = await Product.findOne({slug:req.params.slug});
  if(!product) return res.status(404).json({error:"Not found"});
  res.json(product);
});

app.post("/api/products", verifyAdmin, async(req,res)=>{
  const {name,price,description,stock} = req.body;

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g,"-");

  const product = new Product({
    name,slug,price,description,stock,image:""
  });

  await product.save();
  res.json(product);
});

app.delete("/api/products/:id", verifyAdmin, async(req,res)=>{
  await Product.findByIdAndDelete(req.params.id);
  res.json({success:true});
});

/* ===========================
   REVIEWS
=========================== */

app.post("/api/products/:slug/reviews", async(req,res)=>{
  const product = await Product.findOne({slug:req.params.slug});
  if(!product) return res.status(404).json({error:"Not found"});

  product.reviews.push(req.body);
  await product.save();

  res.json(product);
});

/* ===========================
   PAYSTACK INIT
=========================== */

app.post("/initialize-payment", async(req,res)=>{

  const {email,amount} = req.body;

  try{
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount:Math.round(amount*100),
        callback_url:"https://techmart-jb9k.onrender.com/thankyou.html"
      },
      {
        headers:{
          Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    res.json(response.data);

  }catch(err){
    console.error(err.response?.data||err.message);
    res.status(500).json({error:"Payment failed"});
  }

});

/* ===========================
   VERIFY PAYMENT + EMAIL
=========================== */

app.post("/verify-payment", async(req,res)=>{

  const {reference,orderData} = req.body;

  try{

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers:{
          Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    if(response.data.data.status === "success"){

      const newOrder = new Order({
        ...orderData,
        status:"Processing",
        paymentReference:reference,
        trackingNumber:"DHL"+Math.floor(Math.random()*1000000),
        carrier:"DHL"
      });

      const savedOrder = await newOrder.save();

      /* 🔥 REAL-TIME UPDATE */
      io.emit("new-order", savedOrder);

      /* EMAIL */
      await transporter.sendMail({
        from:`"TechMart" <${process.env.EMAIL_USER}>`,
        to:orderData.email,
        subject:"🛒 Order Confirmation - TechMart",

        html:`
        <h2>Thank you for your order!</h2>

        <p><strong>Order ID:</strong> ${savedOrder._id}</p>
        <p><strong>Total:</strong> ₦${savedOrder.totalAmount}</p>
        <p><strong>Status:</strong> ${savedOrder.status}</p>

        <p>
          <a href="https://techmart-jb9k.onrender.com/track-order.html?tracking=${savedOrder.trackingNumber}" 
          style="background:#0a7cff;color:white;padding:10px 15px;text-decoration:none;border-radius:5px;">
          📦 Track Your Order
          </a>
        </p>

        <ul>
        ${savedOrder.items.map(i=>`
          <li>${i.name} x ${i.quantity}</li>
        `).join("")}
        </ul>
        `
      });

      return res.json({
        success:true,
        orderId:savedOrder._id,
        trackingNumber:savedOrder.trackingNumber
      });

    }

    res.json({success:false});

  }catch(err){
    console.error(err);
    res.status(500).json({error:"Server error"});
  }

});

/* ===========================
   ORDERS
=========================== */

app.get("/api/orders", verifyAdmin, async(req,res)=>{
  const orders = await Order.find().sort({createdAt:-1});
  res.json(orders);
});

app.put("/api/orders/:id", verifyAdmin, async(req,res)=>{

  const {status} = req.body;

  const order = await Order.findByIdAndUpdate(
    req.params.id,
    {status},
    {new:true}
  );

  /* 🔥 LIVE UPDATE */
  io.emit("order-updated", order);

  res.json(order);
});

/* ===========================
   TRACK
=========================== */

app.get("/api/track/:trackingNumber", async(req,res)=>{

  const order = await Order.findOne({
    trackingNumber:req.params.trackingNumber
  });

  if(!order){
    return res.status(404).json({error:"Not found"});
  }

  res.json(order);

});

/* ===========================
   ROOT
=========================== */

app.get("/",(req,res)=>{
  res.send("TechMart Backend Running ✅");
});

/* ===========================
   SOCKET
=========================== */

io.on("connection",(socket)=>{
  console.log("Admin connected:", socket.id);
});

/* ===========================
   START SERVER
=========================== */

server.listen(PORT,()=>{
  console.log(`🚀 Server running on port ${PORT}`);
});