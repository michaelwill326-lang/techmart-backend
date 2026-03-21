require("dotenv").config()

const express = require("express")
const cors = require("cors")
const mongoose = require("mongoose")
const axios = require("axios")
const multer = require("multer")
const { CloudinaryStorage } = require("multer-storage-cloudinary")
const cloudinary = require("cloudinary").v2
const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")

const http = require("http")
const { Server } = require("socket.io")

const app = express()
const PORT = process.env.PORT || 10000

/* ===========================
   ROOT ROUTE
=========================== */
app.get("/", (req, res) => {
  res.send("TechMart Backend Running ✅")
})

/* ===========================
   MIDDLEWARE
=========================== */
app.use(cors({ origin: "*" }))
app.use(express.json())

/* ===========================
   MONGODB
=========================== */
mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log("✅ MongoDB Connected"))
.catch(err=>console.error(err))

/* ===========================
   CLOUDINARY
=========================== */
cloudinary.config({
  cloud_name:process.env.CLOUDINARY_CLOUD_NAME,
  api_key:process.env.CLOUDINARY_API_KEY,
  api_secret:process.env.CLOUDINARY_API_SECRET
})

const storage = new CloudinaryStorage({
  cloudinary,
  params:{
    folder:"techmart_products",
    allowed_formats:["jpg","png","jpeg"]
  }
})

const upload = multer({storage})

/* ===========================
   MODELS
=========================== */

// USER
const userSchema = new mongoose.Schema({
  name:String,
  email:{ type:String, unique:true },
  password:String,
  createdAt:{ type:Date, default:Date.now }
})
const User = mongoose.model("User",userSchema)

// PRODUCT
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
    createdAt:{ type:Date, default:Date.now }
  }],
  createdAt:{ type:Date, default:Date.now }
})
const Product = mongoose.model("Product",productSchema)

// ORDER
const orderSchema = new mongoose.Schema({
  customerName:String,
  email:String,
  address:String,
  items:Array,
  totalAmount:Number,
  paymentReference:String,
  status:{ type:String, default:"Processing" },
  trackingNumber:String,
  carrier:String,
  createdAt:{ type:Date, default:Date.now }
})
const Order = mongoose.model("Order",orderSchema)

/* ===========================
   🔥 SEED PRODUCTS
=========================== */
app.get("/seed-products", async (req, res) => {
  try {

    await Product.deleteMany()

    const products = [
      {
        name: "Gaming Laptop",
        slug: "gaming-laptop",
        price: 1200,
        description: "High performance gaming laptop",
        stock: 10,
        image: "https://via.placeholder.com/400"
      },
      {
        name: "Wireless Headphones",
        slug: "wireless-headphones",
        price: 150,
        description: "Noise cancelling headphones",
        stock: 20,
        image: "https://via.placeholder.com/400"
      },
      {
        name: "Mechanical Keyboard",
        slug: "mechanical-keyboard",
        price: 95,
        description: "RGB keyboard",
        stock: 15,
        image: "https://via.placeholder.com/400"
      },
      {
        name: "Gaming Mouse",
        slug: "gaming-mouse",
        price: 60,
        description: "High precision mouse",
        stock: 25,
        image: "https://via.placeholder.com/400"
      },
      {
        name: "4K Monitor",
        slug: "4k-monitor",
        price: 450,
        description: "Ultra HD monitor",
        stock: 8,
        image: "https://via.placeholder.com/400"
      }
    ]

    await Product.insertMany(products)

    res.json({ message: "Products seeded", count: products.length })

  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/* ===========================
   AUTH
=========================== */
app.post("/api/users/register", async(req,res)=>{
  const {name,email,password} = req.body
  const hashed = await bcrypt.hash(password,10)
  const user = new User({name,email,password:hashed})
  await user.save()
  res.json({message:"Registered"})
})

app.post("/api/users/login", async(req,res)=>{
  const {email,password} = req.body
  const user = await User.findOne({email})
  if(!user) return res.status(400).json({error:"User not found"})
  const valid = await bcrypt.compare(password,user.password)
  if(!valid) return res.status(400).json({error:"Wrong password"})
  const token = jwt.sign({id:user._id},"secret",{expiresIn:"7d"})
  res.json({token})
})

/* ===========================
   PRODUCTS
=========================== */
app.get("/api/products", async(req,res)=>{
  const products = await Product.find()
  res.json(products)
})

app.get("/api/products/:slug", async(req,res)=>{
  const product = await Product.findOne({slug:req.params.slug})
  if(!product) return res.status(404).json({error:"Not found"})
  res.json(product)
})

app.post("/api/products", upload.single("image"), async(req,res)=>{
  const {name,price,description,stock} = req.body
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g,"-")
  const image = req.file ? req.file.path : ""
  const product = new Product({name,slug,price,description,stock,image})
  const saved = await product.save()
  res.json(saved)
})

app.delete("/api/products/:id", async(req,res)=>{
  await Product.findByIdAndDelete(req.params.id)
  res.json({success:true})
})

/* ===========================
   REVIEWS
=========================== */
app.post("/api/products/:slug/reviews", async(req,res)=>{
  const product = await Product.findOne({slug:req.params.slug})
  product.reviews.push(req.body)
  await product.save()
  res.json(product)
})

/* ===========================
   PAYSTACK
=========================== */
app.post("/initialize-payment", async(req,res)=>{
  const {email,amount} = req.body

  const response = await axios.post(
    "https://api.paystack.co/transaction/initialize",
    { email, amount:Math.round(amount*100) },
    { headers:{ Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
  )

  res.json(response.data)
})

app.post("/verify-payment", async(req,res)=>{
  const {reference,orderData} = req.body

  const response = await axios.get(
    `https://api.paystack.co/transaction/verify/${reference}`,
    { headers:{ Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
  )

  if(response.data.data.status==="success"){
    const order = new Order(orderData)
    const saved = await order.save()
    res.json({success:true,orderId:saved._id})
  } else {
    res.json({success:false})
  }
})

/* ===========================
   ORDERS
=========================== */
app.get("/api/orders", async(req,res)=>{
  const orders = await Order.find().sort({createdAt:-1})
  res.json(orders)
})

app.get("/api/track/:trackingNumber", async(req,res)=>{
  const order = await Order.findOne({trackingNumber:req.params.trackingNumber})
  if(!order) return res.status(404).json({error:"Not found"})
  res.json(order)
})

/* ===========================
   SOCKET
=========================== */
const server = http.createServer(app)
const io = new Server(server,{ cors:{origin:"*"} })

io.on("connection",(socket)=>{
  console.log("Admin connected:",socket.id)
})

/* ===========================
   START SERVER
=========================== */
server.listen(PORT,()=>{
  console.log(`🚀 Server running on port ${PORT}`)
})