require("dotenv").config()

const express = require("express")
const cors = require("cors")
const mongoose = require("mongoose")
const axios = require("axios")
const nodemailer = require("nodemailer")

const http = require("http")
const {Server} = require("socket.io")

const app = express()
const PORT = process.env.PORT || 10000

/* ===========================
   CORS
=========================== */

app.use(cors({
origin:"*",
methods:["GET","POST","PUT","DELETE","OPTIONS"],
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
   EMAIL TRANSPORT
=========================== */

const transporter = nodemailer.createTransport({
service:"gmail",
auth:{
user:process.env.EMAIL_USER,
pass:process.env.EMAIL_PASS
}
})

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
price:Number,
description:String,
stock:Number,

createdAt:{
type:Date,
default:Date.now
}

})

const Product = mongoose.model("Product",productSchema)

/* ===========================
   PRODUCTS API
=========================== */

app.get("/api/products",async(req,res)=>{

const products = await Product.find()

res.json(products)

})

app.post("/api/products",async(req,res)=>{

const {name,price,description,stock} = req.body

const product = new Product({
name,
price,
description,
stock
})

const saved = await product.save()

res.json(saved)

})

app.delete("/api/products/:id",async(req,res)=>{

await Product.findByIdAndDelete(req.params.id)

res.json({success:true})

})

/* ===========================
   GET ORDERS
=========================== */

app.get("/api/orders",async(req,res)=>{

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
   GET SINGLE ORDER
=========================== */

app.get("/api/orders/:id",async(req,res)=>{

try{

const order=await Order.findById(req.params.id)

if(!order){
return res.status(404).json({error:"Order not found"})
}

res.json(order)

}catch(err){

res.status(404).json({error:"Order not found"})

}

})

/* ===========================
   UPDATE ORDER STATUS
=========================== */

app.put("/api/orders/:id/status",async(req,res)=>{

const {status}=req.body

const order=await Order.findByIdAndUpdate(
req.params.id,
{status},
{new:true}
)

res.json(order)

})

/* ===========================
   UPDATE TRACKING
=========================== */

app.put("/api/orders/:id/tracking",async(req,res)=>{

const {trackingNumber,carrier,status}=req.body

const order=await Order.findByIdAndUpdate(

req.params.id,

{
trackingNumber,
carrier,
status
},

{new:true}

)

/* SEND EMAIL WHEN SHIPPED */

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

<p>Thank you for shopping with TechMart.</p>

`

})

}

res.json(order)

})

/* ===========================
   TRACK ORDER
=========================== */

app.get("/api/track/:trackingNumber",async(req,res)=>{

const order=await Order.findOne({
trackingNumber:req.params.trackingNumber
})

if(!order){
return res.status(404).json({error:"Tracking not found"})
}

res.json(order)

})

/* ===========================
   EXPORT CSV
=========================== */

app.get("/api/orders/export",async(req,res)=>{

const orders=await Order.find()

let csv="Customer,Email,Total,Status,Date\n"

orders.forEach(o=>{
csv+=`${o.customerName},${o.email},${o.totalAmount},${o.status},${o.createdAt}\n`
})

res.header("Content-Type","text/csv")
res.attachment("orders.csv")
res.send(csv)

})

/* ===========================
   MONTHLY REVENUE
=========================== */

app.get("/api/revenue/monthly",async(req,res)=>{

const start=new Date()
start.setDate(1)

const orders=await Order.find({
createdAt:{$gte:start},
status:"Paid"
})

const total=orders.reduce((sum,o)=>sum+o.totalAmount,0)

res.json({
thisMonth:total
})

})

/* ===========================
   SALES CHART
=========================== */

app.get("/api/revenue/chart",async(req,res)=>{

const orders=await Order.find({status:"Paid"})

const days={}

orders.forEach(order=>{

const date=new Date(order.createdAt).toLocaleDateString()

if(!days[date]){
days[date]=0
}

days[date]+=order.totalAmount

})

res.json({
labels:Object.keys(days),
values:Object.values(days)
})

})

/* ===========================
   TOP PRODUCTS
=========================== */

app.get("/api/analytics/top-products",async(req,res)=>{

const orders=await Order.find({status:"Paid"})

const sales={}

orders.forEach(order=>{

order.items.forEach(item=>{

if(!sales[item.name]){
sales[item.name]=0
}

sales[item.name]+=item.quantity

})

})

res.json({
labels:Object.keys(sales),
values:Object.values(sales)
})

})

/* ===========================
   PAYSTACK INITIALIZE
=========================== */

app.post("/initialize-payment",async(req,res)=>{

const {email,amount}=req.body

try{

const response=await axios.post(

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

}catch(error){

res.status(500).json({
error:"Payment initialization failed"
})

}

})

/* ===========================
   VERIFY PAYMENT
=========================== */

app.post("/verify-payment",async(req,res)=>{

const {reference,orderData}=req.body

try{

const response=await axios.get(

`https://api.paystack.co/transaction/verify/${reference}`,

{
headers:{
Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`
}
}

)

const paymentData=response.data.data

if(paymentData.status==="success"){

const newOrder=new Order({

customerName:orderData.customerName,
email:orderData.email,
address:orderData.address,
items:orderData.items,
totalAmount:orderData.totalAmount,
paymentReference:reference,
status:"Paid"

})

const savedOrder=await newOrder.save()

io.emit("new-order",savedOrder)

return res.json({
success:true,
orderId:savedOrder._id
})

}

return res.json({success:false})

}catch(error){

return res.status(500).json({
success:false,
error:"Verification failed"
})

}

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