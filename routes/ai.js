const express = require("express");
const router = express.Router();
const OpenAI = require("openai");
const mongoose = require("mongoose");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ===========================
   USE EXISTING PRODUCT MODEL
=========================== */
const Product = mongoose.models.Product;

/* ===========================
   AI CHAT ROUTE
=========================== */
router.post("/chat", async (req, res) => {

  try {

    const { message } = req.body;

    if (!message) {

      return res.status(400).json({
        error: "Message required",
      });

    }

    /* ===========================
       SEARCH PRODUCTS
    =========================== */
    const products = await Product.find({
      $or: [
        {
          name: {
            $regex: message,
            $options: "i",
          },
        },
        {
          description: {
            $regex: message,
            $options: "i",
          },
        },
        {
          category: {
            $regex: message,
            $options: "i",
          },
        },
      ],
    }).limit(5);

    const productContext = products
      .map(
        (p) => `
Name: ${p.name}
Price: $${p.price}
Description: ${p.description}
Category: ${p.category}
Stock: ${p.stock}
`
      )
      .join("\n");

    /* ===========================
       OPENAI REQUEST
    =========================== */
    const completion =
      await client.chat.completions.create({

        model: "gpt-4o-mini",

        messages: [
          {
            role: "system",

            content: `
You are TechMart AI assistant.

Your job:
- help customers shop
- recommend products
- answer questions
- be friendly and professional
- encourage purchases

Available products:
${productContext}
`,
          },

          {
            role: "user",
            content: message,
          },
        ],

        temperature: 0.7,
      });

    const reply =
      completion.choices[0].message.content;

    res.json({
      reply,
      products,
    });

  } catch (err) {

    console.log("AI ERROR:", err);

    res.status(500).json({
      error: "AI chat failed",
    });

  }
});

module.exports = router;