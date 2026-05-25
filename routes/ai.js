const express = require("express");
const router = express.Router();
const Groq = require("groq-sdk");
const Product = require("../models/Product"); // 👈 Make sure this path correctly points to your Product model file

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

/* =========================================================================
   🤖 CONTEXT-AWARE GROQ AI SHOPPING ASSISTANT (NAIRA PRICING)
========================================================================= */
router.post("/chat", async (req, res) => {
  try {
    const { message, history = [], userEmail = "Guest" } = req.body;

    if (!message) {
      return res.status(400).json({
        error: "Message is required",
      });
    }

    // 1. Fetch live product catalog from database for real-time context
    const liveProducts = await Product.find({ stock: { $gt: 0 } }).select("name price stock category description");
    
    // 2. Format catalog into a lightweight string with Naira (₦) symbols
    const catalogContext = liveProducts.map(p => 
      `- ${p.name} (₦${p.price.toLocaleString()}) | Category: ${p.category} | Stock: ${p.stock} left. [Desc: ${p.description.substring(0, 60)}...]`
    ).join("\n");

    // 3. Craft the Naira-focused System Prompt
    const systemInstruction = {
      role: "system",
      content: `You are the brilliant, witty, and incredibly helpful AI Sales Assistant for TechMart, Nigeria's elite e-commerce store for gadgets and electronics.
      
CURRENT USER CONTEXT: You are chatting with user: ${userEmail}.

YOUR STRICT RULES:
1. ALWAYS quote all prices in Nigerian Naira using the '₦' symbol (e.g., ₦50,000). Never use dollars ($) or any other currency.
2. ONLY recommend products that are explicitly listed in the LIVE CATALOG below.
3. If a user asks for something out of stock or not listed, politely guide them to a close alternative we DO have in the store.
4. Keep answers concise, energetic, highly engaging, and structured with clear bullet points where helpful.
5. ABSOLUTELY REFUSE to answer questions outside of tech, gadgets, e-commerce, or TechMart support. If users ask for food recipes or software code debugging, playfully pull them back to tech shopping.

LIVE INVENTORY CATALOG:
${catalogContext}`
    };

    // 4. Reconstruct history with the system prompt injected at index 0
    const messagesPayload = [
      systemInstruction,
      ...history.map(msg => ({
        role: msg.sender === "user" ? "user" : "assistant",
        content: msg.text
      })),
      { role: "user", content: message }
    ];

    // 5. Fire request to Groq API using your existing SDK configuration
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-speculator", 
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