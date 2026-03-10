require("dotenv").config()

const express = require("express")
const cors = require("cors")
const mongoose = require("mongoose")
const axios = require("axios")
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
   GET PRODUCTS
=========================== */

app.get("/api/products", async(req,res)=>{

const products = await Product.find()

res.json(products)

})

/* ===========================
   GET PRODUCT BY SLUG
=========================== */

app.get("/api/products/:slug", async(req,res)=>{

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

app.post("/api/products", upload.single("image"), async(req,res)=>{

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

app.delete("/api/products/:id", async(req,res)=>{

await Product.findByIdAndDelete(req.params.id)

res.json({success:true})

})

/* ===========================
   ADD REVIEW
=========================== */

app.post("/api/products/:slug/reviews", async(req,res)=>{

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
   GET REVIEWS
=========================== */

app.get("/api/products/:slug/reviews", async(req,res)=>{

const product = await Product.findOne({
slug:req.params.slug
})

if(!product){
return res.status(404).json({error:"Product not found"})
}

res.json(product.reviews)

})

/* ===========================
   PRODUCT RECOMMENDATIONS
=========================== */

app.get("/api/products/:slug/recommendations", async(req,res)=>{

try{

const product = await Product.findOne({
slug:req.params.slug
})

if(!product){
return res.status(404).json({error:"Product not found"})
}

const recommendations = await Product.find({
slug:{ $ne:req.params.slug }
}).limit(4)

res.json(recommendations)

}catch(err){

console.error(err)

res.status(500).json({error:"Server error"})

}

})

/* ===========================
   PAYSTACK INITIALIZE
=========================== */

app.post("/initialize-payment", async(req,res)=>{

const {email,amount} = req.body

try{

const response = await axios.post(

"https://api.paystack.co/transaction/initialize",

{
email,
amount:Math.round(amount*100)
},

{
headers:{
Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
"Content-Type":"application/json"
}
}

)

res.json(response.data)

}catch(err){

console.error("Paystack Init Error:",err.response?.data||err.message)

res.status(500).json({
error:"Payment initialization failed"
})

}

})

/* ===========================
   VERIFY PAYMENT
=========================== */

app.post("/verify-payment", async(req,res)=>{

const {reference,orderData} = req.body

try{

const response = await axios.get(

`https://api.paystack.co/transaction/verify/${reference}`,

{
headers:{
Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`
}
}

)

const paymentData = response.data.data

if(paymentData.status==="success"){

const newOrder = new Order({

customerName:orderData.customerName,
email:orderData.email,
address:orderData.address,
items:orderData.items,
totalAmount:orderData.totalAmount,
paymentReference:reference,
status:"Paid"

})

const savedOrder = await newOrder.save()

io.emit("new-order",savedOrder)

return res.json({
success:true,
orderId:savedOrder._id
})

}

return res.json({success:false})

}catch(err){

console.error("Verification Error:",err.response?.data||err.message)

res.status(500).json({
success:false
})

}

})

/* ===========================
   GET ALL ORDERS
=========================== */

app.get("/api/orders", async(req,res)=>{

const orders = await Order.find()
.sort({createdAt:-1})

res.json(orders)

})

/* ===========================
   GET SINGLE ORDER
=========================== */

app.get("/api/orders/:id", async(req,res)=>{

try{

const order = await Order.findById(req.params.id)

if(!order){
return res.status(404).json({error:"Order not found"})
}

res.json(order)

}catch(err){

res.status(500).json({error:"Server error"})

}

})

/* ===========================
   TRACK ORDER
=========================== */

app.get("/api/track/:trackingNumber", async(req,res)=>{

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

const server = http.createServer(app)

const io = new Server(server,{
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