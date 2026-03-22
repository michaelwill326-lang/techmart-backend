require("dotenv").config()

const express = require("express")
const cors = require("cors")
const mongoose = require("mongoose")
const axios = require("axios")

const http = require("http")
const { Server } = require("socket.io")

const app = express()
const PORT = process.env.PORT || 10000

/* ===========================
   MIDDLEWARE
=========================== */

app.use(cors({
origin:"*",
methods:["GET","POST","PUT","DELETE"],
allowedHeaders:["Content-Type","Authorization"]
}))

app.use(express.json())

/* ===========================
   ROOT ROUTE (FIXES "Cannot GET /")
=========================== */

app.get("/", (req,res)=>{
res.send("🚀 TechMart Backend Running")
})

/* ===========================
   MONGODB
=========================== */

mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log("✅ MongoDB Connected"))
.catch(err=>console.error(err))

/* ===========================
   MODELS
=========================== */

const userSchema = new mongoose.Schema({
name:String,
email:{ type:String, unique:true },
password:String,
createdAt:{ type:Date, default:Date.now }
})

const User = mongoose.model("User",userSchema)

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
   PRODUCTS
=========================== */

app.get("/api/products", async(req,res)=>{
const products = await Product.find()
res.json(products)
})

app.get("/api/products/:slug", async(req,res)=>{
const product = await Product.findOne({slug:req.params.slug})

if(!product){
return res.status(404).json({error:"Product not found"})
}

res.json(product)
})

/* ===========================
   ORDERS
=========================== */

/* GET ALL ORDERS */
app.get("/api/orders", async(req,res)=>{
const orders = await Order.find().sort({createdAt:-1})
res.json(orders)
})

/* ✅ GET SINGLE ORDER (FIXED) */
app.get("/api/orders/:id", async(req,res)=>{

try{

const order = await Order.findById(req.params.id)

if(!order){
return res.status(404).json({error:"Order not found"})
}

res.json(order)

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
amount: Math.round(amount * 100)
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

console.error(err.response?.data || err.message)
res.status(500).json({error:"Payment initialization failed"})

}

})

/* ===========================
   VERIFY PAYMENT (SAVE ORDER)
=========================== */

app.post("/verify-payment", async(req,res)=>{

try{

const {reference,orderData} = req.body

if(!reference){
return res.status(400).json({success:false,error:"No reference"})
}

const response = await axios.get(
`https://api.paystack.co/transaction/verify/${reference}`,
{
headers:{
Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`
}
}
)

if(response.data.data.status === "success"){

const newOrder = new Order(orderData)
const savedOrder = await newOrder.save()

io.emit("new-order", savedOrder)

return res.json({
success:true,
orderId:savedOrder._id
})

}

res.json({success:false})

}catch(err){

console.error("VERIFY ERROR:", err.response?.data || err.message)

res.status(500).json({
success:false,
error:"Verification failed"
})

}

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