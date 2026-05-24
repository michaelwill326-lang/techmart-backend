const express = require("express");
const router = express.Router();
const Groq = require("groq-sdk");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

router.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        error: "Message is required",
      });
    }

    const completion = await groq.chat.completions.create({
 model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content:
            "You are TechMart AI Assistant. Help customers with products, orders, payments, shipping, and shopping advice.",
        },
        {
          role: "user",
          content: message,
        },
      ],
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