const express = require("express");
const router = express.Router();
const Groq = require("groq-sdk");
const mongoose = require("mongoose");

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

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
       GET PRODUCT MODEL
    =========================== */
    const Product = mongoose.models.Product;

    if (!Product) {
      return res.status(500).json({
        error: "AI chat failed",
        details: "Product model not loaded yet"
      });
    }

    /* ===========================
       SEARCH PRODUCTS
    =========================== */
    const products = await Product.find({
      $or: [
        { name: { $regex: message, $options: "i" } },
        { description: { $regex: message, $options: "i" } },
        { category: { $regex: message, $options: "i" } },
      ],
    }).limit(5);

    const productContext = products
      .map(
        (p) => `
Name: ${p.name}
Price: ₦${p.price?.toLocaleString()}
Description: ${p.description}
Category: ${p.category}
Stock: ${p.stock}
`
      )
      .join("\n");

    /* ===========================
       GROQ REQUEST
    =========================== */
    const completion = await client.chat.completions.create({
      model: "llama3-8b-8192",

      messages: [
        {
          role: "system",
          content: `
You are TechMart AI, a friendly and professional shopping assistant for a Nigerian tech store.

Your job:
- Help customers find products
- Recommend products based on their needs
- Answer questions about products, pricing and availability
- Be friendly, concise, and encouraging
- Always respond in plain text, no markdown
- Prices are in Nigerian Naira (₦)

${productContext
  ? `Available matching products:\n${productContext}`
  : "No specific products matched the query. Suggest the customer browse the store or ask about a specific category."
}
`,
        },
        {
          role: "user",
          content: message,
        },
      ],

      max_tokens: 500,
      temperature: 0.7,
    });

    const reply = completion.choices[0]?.message?.content;

    if (!reply) {
      return res.status(500).json({
        error: "AI returned empty response",
        details: "No content in completion choices"
      });
    }

    res.json({
      reply,
      products,
    });

  } catch (err) {

    console.error("AI ERROR:", err);

    if (err?.status === 401) {
      return res.status(500).json({
        error: "AI chat failed",
        details: "Invalid Groq API key"
      });
    }

    if (err?.status === 429) {
      return res.status(500).json({
        error: "AI chat failed",
        details: "Groq rate limit exceeded — try again in a moment"
      });
    }

    res.status(500).json({
      error: "AI chat failed",
      details: err.message
    });

  }
});

module.exports = router;