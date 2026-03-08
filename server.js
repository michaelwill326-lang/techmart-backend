require("dotenv").config()

const express = require("express")
const cors = require("cors")
const mongoose = require("mongoose")
const axios = require("axios")
const nodemailer = require("nodemailer")

const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")

const multer = require("multer")
const { CloudinaryStorage } = require("multer-storage-cloudinary")
const cloudinary = require("cloudinary").v2

const http = require("http")
const { Server } = require("socket.io")

const app = express()
const PORT = process.env.PORT || 10000

/* ===========================
   CORS
=========================== */

app.use(cors({
origin:"*",
methods:["GET","POST","PUT","DELETE"],
allowedHeaders:["Content-Type","Authorization"]
}))

app.use(express.json())

/* ===========================
   MONGODB
=========================== */

mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log("✅ MongoDB Connected"))
.catch(err=>console.error("MongoDB Error:",err))

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
   EMAIL
=========================== */

const transporter = nodemailer.createTransport({
service:"gmail",
auth:{
user:process.env.EMAIL_USER,
pass:process.env.EMAIL_PASS
}
})

/* ===========================
   USER SCHEMA
=========================== */

const userSchema = new mongoose.Schema({

name:String,

email:{
type:String,
unique:true
},

password:String,

createdAt:{
type:Date,
default:Date.now
}

})

const User = mongoose.model("User",userSchema)

/* ===========================
   ORDER SCHEMA
=========================== */

const orderSchema = new mongoose.Schema({

customerName:String,
email:String,
address:String,

items:Array,

totalAmount:Number,

paymentReference:String,

status:{
type:String,
default:"Processing"
},

trackingNumber:{
type:String,
default:""
},

carrier:{
type:String,
default:""
},

createdAt:{
type:Date,
default:Date.now
}

})

const Order = mongoose.model("Order",orderSchema)

/* ===========================
   PRODUCT SCHEMA
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

createdAt:{
type:Date,
default:Date.now
}

}],

createdAt:{
type:Date,
default:Date.now
}

})

const Product = mongoose.model("Product",productSchema)

/* ===========================
   REGISTER USER
=========================== */

app.post("/api/users/register", async (req,res)=>{

const {name,email,password} = req.body

const existing = await User.findOne({email})

if(existing){
return res.status(400).json({error:"User already exists"})
}

const hashedPassword = await bcrypt.hash(password,10)

const user = new User({

name,
email,
password:hashedPassword

})

await user.save()

res.json({message:"Account created"})

})

/* ===========================
   LOGIN USER
=========================== */

app.post("/api/users/login", async (req,res)=>{

const {email,password} = req.body

const user = await User.findOne({email})

if(!user){
return res.status(400).json({error:"Invalid email"})
}

const valid = await bcrypt.compare(password,user.password)

if(!valid){
return res.status(400).json({error:"Invalid password"})
}

const token = jwt.sign({

id:user._id

}, process.env.JWT_SECRET , {

expiresIn:"7d"

})

res.json({
token,
user:{
id:user._id,
name:user.name,
email:user.email
}
})

})

/* ===========================
   GET PRODUCTS
=========================== */

app.get("/api/products", async (req,res)=>{

const products = await Product.find()

res.json(products)

})

/* ===========================
   GET PRODUCT BY SLUG
=========================== */

app.get("/api/products/:slug", async (req,res)=>{

const product = await Product.findOne({
slug:req.params.slug
})

if(!product){
return res.status(404).json({error:"Product not found"})
}

res.json(product)

})

/* ===========================
   ADD PRODUCT
=========================== */

app.post("/api/products", upload.single("image"), async (req,res)=>{

const {name,price,description,stock} = req.body

const slug = name
.toLowerCase()
.replace(/[^a-z0-9]+/g,"-")
.replace(/(^-|-$)/g,"")

const image = req.file ? req.file.path : ""

const product = new Product({

name,
slug,
price,
description,
stock,
image

})

const saved = await product.save()

res.json(saved)

})

/* ===========================
   DELETE PRODUCT
=========================== */

app.delete("/api/products/:id", async (req,res)=>{

await Product.findByIdAndDelete(req.params.id)

res.json({success:true})

})

/* ===========================
   ADD PRODUCT REVIEW
=========================== */

app.post("/api/products/:slug/reviews", async (req,res)=>{

const {name,rating,comment} = req.body

const product = await Product.findOne({
slug:req.params.slug
})

if(!product){
return res.status(404).json({error:"Product not found"})
}

product.reviews.push({
name,
rating,
comment
})

await product.save()

res.json(product)

})

/* ===========================
   GET PRODUCT REVIEWS
=========================== */

app.get("/api/products/:slug/reviews", async (req,res)=>{

const product = await Product.findOne({
slug:req.params.slug
})

if(!product){
return res.status(404).json({error:"Product not found"})
}

res.json(product.reviews)

})

/* ===========================
   GET ORDERS
=========================== */

app.get("/api/orders", async (req,res)=>{

const page=parseInt(req.query.page)||1
const limit=parseInt(req.query.limit)||50

const skip=(page-1)*limit

const orders=await Order.find()
.sort({createdAt:-1})
.skip(skip)
.limit(limit)

const total=await Order.countDocuments()

res.json({
orders,
total
})

})

/* ===========================
   UPDATE ORDER STATUS
=========================== */

app.put("/api/orders/:id/status", async (req,res)=>{

const {status}=req.body

const order = await Order.findByIdAndUpdate(
req.params.id,
{status},
{new:true}
)

res.json(order)

})

/* ===========================
   UPDATE TRACKING
=========================== */

app.put("/api/orders/:id/tracking", async (req,res)=>{

const {trackingNumber,carrier,status}=req.body

const order = await Order.findByIdAndUpdate(

req.params.id,

{
trackingNumber,
carrier,
status
},

{new:true}

)

if(status==="Shipped" && trackingNumber){

const trackingLink=`https://yourstore.netlify.app/track.html?tracking=${trackingNumber}`

await transporter.sendMail({

from:`TechMart <${process.env.EMAIL_USER}>`,
to:order.email,

subject:"Your TechMart Order Has Shipped 🚚",

html:`

<h2>Your order has shipped!</h2>

<p><b>Carrier:</b> ${carrier}</p>
<p><b>Tracking Number:</b> ${trackingNumber}</p>

<p>
Track your order here:
<br><br>
<a href="${trackingLink}">
${trackingLink}
</a>
</p>

`

})

}

res.json(order)

})

/* ===========================
   TRACK ORDER
=========================== */

app.get("/api/track/:trackingNumber", async (req,res)=>{

const order = await Order.findOne({
trackingNumber:req.params.trackingNumber
})

if(!order){
return res.status(404).json({error:"Tracking not found"})
}

res.json(order)

})

/* ===========================
   SOCKET.IO
=========================== */

const server=http.createServer(app)

const io=new Server(server,{
cors:{origin:"*"}
})

io.on("connection",(socket)=>{
console.log("Admin connected:",socket.id)
})

/* ===========================
   START SERVER
=========================== */

server.listen(PORT,()=>{

console.log(`🚀 Server running on port ${PORT}`)

})