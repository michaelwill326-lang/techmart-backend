require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

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
   REGISTER
=========================== */
app.post("/api/register", async (req, res) => {
  try{

    let { name, email, password } = req.body;

    // ✅ FIX: Trim values
    name = name?.trim();
    email = email?.trim();
    password = password?.trim();

    console.log("REGISTER BODY:", { name, email, password });

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

    const hashed = await bcrypt.hash(password, 10);

    const user = new User({
      name,
      email,
      password: hashed
    });

    await user.save();

    res.json({ success:true });

  }catch(err){
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ success:false, message:"Register failed" });
  }
});

/* ===========================
   LOGIN
=========================== */
app.post("/api/login", async (req, res) => {
  try{

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
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success:true,
      token,
      user:{
        name:user.name,
        email:user.email
      }
    });

  }catch(err){
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ success:false, message:"Login failed" });
  }
});

/* ===========================
   START SERVER
=========================== */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});