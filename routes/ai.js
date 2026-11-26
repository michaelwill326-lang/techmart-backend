const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Groq = require("groq-sdk");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

/* =========================================================================
   🤖 CONTEXT-AWARE GROQ AI SHOPPING ASSISTANT (NAIRA PRICING)
========================================================================= */
router.post("/chat", async (req, res) => {
  try {
    const { message, history = [], userEmail = "Guest", userName = "Guest" } = req.body;

    if (!message) {
      return res.status(400).json({
        error: "Message is required",
      });
    }

    // Safely look up the Product model directly from Mongoose's active registration registry
    const Product = mongoose.models.Product || mongoose.model("Product");

    // 1. Fetch live product catalog cleanly from injected model
    const liveProducts = await Product.find({ stock: { $gt: 0 } }).select("name price stock category description");
    
    // 2. Format catalog with Naira (₦) currency markers
    const catalogContext = liveProducts.map(p => 
      `- ${p.name} (₦${p.price.toLocaleString()}) | Category: ${p.category} | Stock: ${p.stock} left. [Desc: ${p.description.substring(0, 60)}...]`
    ).join("\n");

    // 3. System Prompt
    const systemInstruction = {
      role: "system",
      content: `You are the brilliant, witty, and incredibly helpful AI Sales Assistant for TechMart, Nigeria's elite e-commerce store for gadgets and electronics.
      
CURRENT USER CONTEXT: You are chatting with: ${userName !== "Guest" ? userName : "a guest"}. Greet them by first name when appropriate.

YOUR STRICT RULES:
1. ALWAYS quote all prices in Nigerian Naira using the '₦' symbol (e.g., ₦50,000). Never use dollars ($) or any other currency.
2. ONLY recommend products that are explicitly listed in the LIVE CATALOG below.
3. If a user asks for something out of stock or not listed, politely guide them to a close alternative we DO have in the store.
4. Keep answers concise, energetic, highly engaging, and structured with clear bullet points where helpful.
5. ABSOLUTELY REFUSE to answer questions outside of tech, gadgets, e-commerce, or TechMart support. If users ask for food recipes or software code debugging, playfully pull them back to tech shopping.

LIVE INVENTORY CATALOG:
${catalogContext}`
    };

    // 4. Set up message pipeline
    const messagesPayload = [
      systemInstruction,
      ...history.map(msg => ({
        role: msg.sender === "user" ? "user" : "assistant",
        content: msg.text
      })),
      { role: "user", content: message }
    ];

    // 5. Query Groq
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile", 
      messages: messagesPayload,
      temperature: 0.7,
      max_tokens: 500,
    });

    res.json({
      reply: completion.choices[0].message.content,
    });

  } catch (err) {
    console.error("GROQ ERROR:", err);
    res.status(500).json({
      error: "AI server error",
      details: err.message,
    });
  }
});

module.exports = router;