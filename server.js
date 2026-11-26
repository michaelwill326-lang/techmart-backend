const crypto = require("crypto");
require("dotenv").config();

const express = require("express");
const { randomInt } = require("crypto");
const cors = require("cors");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const xss = require("xss");
// MongoDB-backed JWT blacklist with TTL — survives restarts and scales across instances.
const InvalidatedTokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true, index: true },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } }
});
const InvalidatedToken = mongoose.models.InvalidatedToken ||
  mongoose.model("InvalidatedToken", InvalidatedTokenSchema);

const { hasTokenSafely } = require("./utils/securityHelpers");

const tokenBlacklist = {
  async has(token) {
    return hasTokenSafely(token, (filter) => InvalidatedToken.exists(filter));
  },
  async add(token) {
    try {
      const decoded = jwt.decode(token);
      const expiresAt = decoded && decoded.exp
        ? new Date(decoded.exp * 1000)
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await InvalidatedToken.updateOne({ token }, { token, expiresAt }, { upsert: true });
    } catch (err) {
      console.error("Blacklist write failed:", err.message);
    }
  }
};

// Sanitize user input to prevent XSS
const sanitize = (str) => {
  if (typeof str !== "string") return str;
  return xss(str.trim(), { whiteList: {}, stripIgnoreTag: true, stripIgnoreTagBody: ["script"] });
};
const bcrypt = require("bcryptjs");
const axios = require("axios");
const http = require("http");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");
const Groq = require("groq-sdk");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const PHONE_CHECKER_MODEL = "openai/gpt-oss-20b";

const { sendOrderConfirmation, sendWelcomeEmail, sendShippingUpdate, sendPasswordResetEmail, sendAdminOrderNotification, sendLowStockAlert, sendOTPEmail, sendAbandonedCartEmail, sendPinChangedEmail } = require("./utils/email");
const cron = require("node-cron");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage });

const phoneCheckUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPEG, PNG, and WebP images are allowed"));
  }
});

// Strong password security rule
function isStrongPassword(password) {
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*]).{8,}$/.test(password);
}

const app = express();
app.set("trust proxy", 1);

/* ===========================
   🔒 SECURITY
=========================== */
app.use(helmet());

/* =========================================================================
   PROVIDER ABSTRACTION LAYER
   ========================================================================= */
const VIRTUAL_ACCOUNT_ENABLED = false;

const providers = {
  paystack: {
    name: "Paystack",
    async createVirtualAccount(user) {
      if (!VIRTUAL_ACCOUNT_ENABLED) throw new Error("Virtual accounts not yet enabled");
      const { data: customer } = await axios.post(
        "https://api.paystack.co/customer",
        { email: user.email, first_name: user.name.split(" ")[0], last_name: user.name.split(" ").slice(1).join(" ") || user.name, phone: user.phone },
        { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
      );
      const { data: dva } = await axios.post(
        "https://api.paystack.co/dedicated_account",
        { customer: customer.data.customer_code, preferred_bank: "titan-paystack" },
        { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
      );
      return { accountNumber: dva.data.account_number, bankName: dva.data.bank.name, providerRef: customer.data.customer_code };
    }
  },
  flutterwave: {
    name: "Flutterwave",
    async createVirtualAccount(user) {
      if (!VIRTUAL_ACCOUNT_ENABLED) throw new Error("Virtual accounts not yet enabled");
      const { data } = await axios.post(
        "https://api.flutterwave.com/v3/virtual-account-numbers",
        { email: user.email, is_permanent: true, bvn: user.bvn || "00000000000", tx_ref: "VA-" + user._id, firstname: user.name.split(" ")[0], lastname: user.name.split(" ").slice(1).join(" ") || user.name, narration: "TechMart Pay — " + user.name },
        { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } }
      );
      return { accountNumber: data.data.account_number, bankName: data.data.bank_name, providerRef: data.data.order_ref };
    }
  },
};

const ACTIVE_PROVIDER = process.env.VA_PROVIDER || "paystack";
const payProvider = providers[ACTIVE_PROVIDER] || providers.paystack;

function getLagosDate() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
}
function resetDailyUsageIfNeeded(user) {
  const today = getLagosDate();
  if (!user.dailyUsage) user.dailyUsage = {};
  if (user.dailyUsage.date !== today) {
    user.dailyUsage = { date: today, deposited: 0, withdrawn: 0, transferred: 0 };
  }
}
function checkLimit(user, type, amount) {
  resetDailyUsageIfNeeded(user);
  const limits = user.limits || {};
  const usage  = user.dailyUsage || {};
  const limitMap = { deposit: ["dailyDeposit","deposited"], withdrawal: ["dailyWithdrawal","withdrawn"], transfer: ["dailyTransfer","transferred"] };
  const [limitKey, usageKey] = limitMap[type] || [];
  if (!limitKey) return { ok: true };
  const limit = limits[limitKey] ?? (type === "deposit" ? 50000 : 20000);
  const used  = usage[usageKey] ?? 0;
  if (Number(amount) > (limits.singleTx ?? 100000)) return { ok: false, error: `Single transaction limit is ₦${(limits.singleTx||100000).toLocaleString()}` };
  if (used + Number(amount) > limit) return { ok: false, error: `Daily ${type} limit of ₦${limit.toLocaleString()} reached` };
  return { ok: true };
}
function recordUsage(user, type, amount) {
  resetDailyUsageIfNeeded(user);
  const usageMap = { deposit: "deposited", withdrawal: "withdrawn", transfer: "transferred" };
  const key = usageMap[type];
  if (key) user.dailyUsage[key] = (user.dailyUsage[key] || 0) + Number(amount);
}
function appendAudit(user, action, req, meta = {}) {
  if (!user.auditLog) user.auditLog = [];
  user.auditLog.push({ action, ip: req?.ip || "system", userAgent: req?.headers?.["user-agent"] || "", meta, createdAt: new Date() });
  if (user.auditLog.length > 200) user.auditLog = user.auditLog.slice(-200);
}
function getKycTier(user) {
  if (user.kyc?.ninVerified || user.ninVerified) return 3;
  if (user.kyc?.bvnVerified || user.bvnVerified) return 2;
  if (user.phone) return 1;
  return 0;
}
function upgradeKycLimits(user) {
  const tier = getKycTier(user);
  if (!user.limits) user.limits = {};
  if (tier >= 2) { user.limits.dailyDeposit = 500000; user.limits.dailyWithdrawal = 200000; user.limits.dailyTransfer = 200000; user.limits.singleTx = 1000000; }
  if (tier >= 3) { user.limits.dailyDeposit = 5000000; user.limits.dailyWithdrawal = 1000000; user.limits.dailyTransfer = 2000000; user.limits.singleTx = 5000000; }
}

// Skip JSON parsing for the Paystack webhook path — it needs the raw,
// unparsed body to verify the HMAC signature. Runs before rate limiters
// so req.body is available to the auth rate limiter's keyGenerator on
// every other route.
app.use((req, res, next) => {
  if (req.originalUrl === "/api/paystack/webhook") return next();
  express.json({ limit: "10mb" })(req, res, next);
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: "Too many requests, try again later." }
});

app.use(limiter);

// Request timeout middleware (30 seconds)
app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    res.status(408).json({ error: "Request timeout. Please try again." });
  });
  next();
});

const { ipKeyGenerator } = require("express-rate-limit");
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many attempts, please try again in 15 minutes." },
  keyGenerator: (req) => {
    // Key on submitted email (when present), so repeated guesses against the
    // same account are tracked together even if requests land on different
    // processes/instances behind the proxy. Falls back to a safe IP key
    // (IPv6-aware) when no email is present on the request.
    const email = (req.body && req.body.email) ? String(req.body.email).toLowerCase().trim() : "";
    return email ? `email:${email}` : ipKeyGenerator(req);
  }
});
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signup", authLimiter);
app.use("/api/auth/forgot-password", authLimiter);

// Dedicated protection for 6-digit password reset codes.
// Reset codes have only 900,000 possible values, so brute-force attempts
// must be restricted independently from the general API limiter.
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many password reset attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req)
});

app.use("/api/auth/reset-password", passwordResetLimiter);
app.use("/api/seller/reset-password", passwordResetLimiter);
app.use("/api/seller/forgot-password", authLimiter);

// Wallet PIN security
const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Too many PIN attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    if (req.user?.id) return `user:${req.user.id}`;
    return ipKeyGenerator(req);
  }
});

const pinResetRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { error: "Too many PIN reset requests. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    if (req.user?.id) return `user:${req.user.id}`;
    return ipKeyGenerator(req);
  }
});

/* Authentication OTP security */
const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { error: "Too many OTP requests. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = req.body?.email
      ? String(req.body.email).toLowerCase().trim()
      : "";
    const ip = ipKeyGenerator(req);
    return email ? `otp-send:${ip}:${email}` : `otp-send:${ip}`;
  }
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many OTP verification attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = req.body?.email
      ? String(req.body.email).toLowerCase().trim()
      : "";
    const ip = ipKeyGenerator(req);
    return email ? `otp-verify:${ip}:${email}` : `otp-verify:${ip}`;
  }
});

app.use("/api/auth/send-otp", otpSendLimiter);
app.use("/api/auth/verify-otp", otpVerifyLimiter);

/* ===========================
   🌐 CORS CONFIG
=========================== */
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5174",
  "https://techmart-store-ppri.onrender.com",
  "https://techmart-frontend.onrender.com"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("CORS blocked: " + origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors());

/* ===========================
   📦 BODY PARSER
=========================== */



/* ===========================
   🔗 TECHMART NETWORK ENGINE
=========================== */

function generateGiftCardCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const seg = () => Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `TECH-${seg()}-${seg()}-${seg()}`;
}

function generateLinkId() {
  return Array.from({length: 12}, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
}

function calculateNetworkTier(score) {
  if (score >= 10000) return "Elite";
  if (score >= 5000) return "Premium";
  if (score >= 2000) return "Plus";
  return "Member";
}

function getNetworkBenefits(tier) {
  switch (tier) {
    case "Elite":
      return {
        cashbackMultiplier: 1.5,
        loyaltyMultiplier: 2,
        exclusiveDeals: true,
        prioritySupport: true
      };

    case "Premium":
      return {
        cashbackMultiplier: 1.3,
        loyaltyMultiplier: 1.5,
        exclusiveDeals: true,
        prioritySupport: true
      };

    case "Plus":
      return {
        cashbackMultiplier: 1.15,
        loyaltyMultiplier: 1.25,
        exclusiveDeals: true,
        prioritySupport: false
      };

    default:
      return {
        cashbackMultiplier: 1,
        loyaltyMultiplier: 1,
        exclusiveDeals: false,
        prioritySupport: false
      };
  }
}

async function updateNetworkScore(userId, points, activity = {}) {
  const user = await User.findById(userId);

  if (!user) {
    throw new Error("User not found");
  }

  const safePoints = Math.max(0, Number(points) || 0);

  user.networkScore = Math.max(
    0,
    (user.networkScore || 0) + safePoints
  );

  const oldTier = user.networkTier || "Member";
  const newTier = calculateNetworkTier(user.networkScore);

  user.networkTier = newTier;
  user.networkBenefits = getNetworkBenefits(newTier);
  user.networkLastActivity = new Date();

  if (activity.lifetimeSpend) {
    user.networkLifetimeSpend =
      (user.networkLifetimeSpend || 0) +
      Number(activity.lifetimeSpend || 0);
  }

  if (activity.loyaltyEarned) {
    user.networkLoyaltyEarned =
      (user.networkLoyaltyEarned || 0) +
      Number(activity.loyaltyEarned || 0);
  }

  if (activity.savingsBalance !== undefined) {
    user.networkSavingsBalance =
      Number(activity.savingsBalance || 0);
  }

  if (activity.bnplCompleted) {
    user.networkBnplCompleted =
      (user.networkBnplCompleted || 0) +
      Number(activity.bnplCompleted || 0);
  }

  if (activity.referralCount) {
    user.networkReferralCount =
      (user.networkReferralCount || 0) +
      Number(activity.referralCount || 0);
  }

  await user.save();

  if (safePoints > 0) {
    await NetworkActivity.create({
      userId: user._id,
      type: activity.type || "bonus",
      points: safePoints,
      amount: Number(activity.amount || 0),
      description:
        activity.description ||
        `TechMart Network activity +${safePoints} XP`,
      reference: activity.reference || ""
    });
  }

  if (oldTier !== newTier) {
    await NetworkActivity.create({
      userId: user._id,
      type: "tier_upgrade",
      points: 0,
      description: `TechMart Network tier changed from ${oldTier} to ${newTier}`
    });

    console.log(
      `🔗 Network tier changed: ${user.email} ${oldTier} → ${newTier}`
    );
  }

  return user;
}

/* ===========================
   🤖 AI ROUTES
=========================== */

/* ===========================
   🧠 DATABASE
=========================== */
mongoose
  .connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
    maxPoolSize: 10,
  })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

// Reconnect on disconnect
mongoose.connection.on("disconnected", () => {
  console.warn("⚠️ MongoDB disconnected. Attempting reconnect...");
});

/* ===========================
   👤 MODELS
=========================== */
const User = mongoose.model(
  "User",
  new mongoose.Schema({
    name: String,
    email: { type: String, unique: true, lowercase: true, trim: true },
    password: String,
    phone: { type: String, default: "" },
    role: { type: String, default: "customer" },
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: String, default: null },
    emailVerified: { type: Boolean, default: false },
    emailVerificationToken: { type: String, default: null },
    emailVerificationExpires: { type: Date, default: null },
    emailVerificationSentAt: { type: Date, default: null },
    referralCount: { type: Number, default: 0 },
    referralCredits: { type: Number, default: 0 },
    resetPasswordToken: { type: String, default: null },
    resetPasswordExpires: { type: Date, default: null },
    avgResponseTime: { type: Number, default: null },
    lastMessageAt: { type: Date, default: null },
    lastResponseAt: { type: Date, default: null },
        walletBalance: { type: Number, default: 0 },
    walletTransactions: [{
      type: { type: String, enum: ["credit", "debit"] },
      amount: Number,
      description: String,
      reference: String,
      channel: { type: String, default: "internal" },
      status: { type: String, enum: ["pending","completed","failed","reversed"], default: "completed" },
      meta: { type: Object, default: {} },
      createdAt: { type: Date, default: Date.now }
    }],
    virtualAccount: {
      enabled: { type: Boolean, default: false },
      accountNumber: { type: String, default: null },
      accountName: { type: String, default: null },
      bankName: { type: String, default: null },
      bankCode: { type: String, default: null },
      providerRef: { type: String, default: null },
      provider: { type: String, default: null },
      issuedAt: { type: Date, default: null },
    },
    kyc: {
      tier: { type: Number, default: 0 },
      status: { type: String, enum: ["pending","approved","rejected","under_review"], default: "pending" },
      bvnVerified: { type: Boolean, default: false },
      ninVerified: { type: Boolean, default: false },
      docUploaded: { type: Boolean, default: false },
      reviewedAt: { type: Date, default: null },
      reviewNote: { type: String, default: null },
    },
    limits: {
      dailyDeposit: { type: Number, default: 50000 },
      dailyWithdrawal: { type: Number, default: 20000 },
      dailyTransfer: { type: Number, default: 20000 },
      singleTx: { type: Number, default: 100000 },
    },
    dailyUsage: {
      date: { type: String, default: null },
      deposited: { type: Number, default: 0 },
      withdrawn: { type: Number, default: 0 },
      transferred: { type: Number, default: 0 },
    },
    auditLog: [{
      action: String,
      ip: String,
      userAgent: String,
      meta: Object,
      createdAt: { type: Date, default: Date.now }
    }],
    virtualAccountNumber: { type: String, default: null },
    virtualAccountBank: { type: String, default: null },
    paystackCustomerCode: { type: String, default: null },
    walletPin: { type: String, default: null },
    walletPinSet: { type: Boolean, default: false },
    walletPinResetOtp: { type: String, default: null },
    walletPinResetExpires: { type: Date, default: null },
    otpCode: { type: String, default: null },
    otpExpires: { type: Date, default: null },
    twoFactorEnabled: { type: Boolean, default: false },
    deviceTokens: { type: [String], default: [] },
    aiPreferences: { type: Object, default: {} },
    savedCart: { type: Array, default: [] },
    cartUpdatedAt: { type: Date, default: null },
    cartReminderSent: { type: Boolean, default: false },
    fraudScore: { type: Number, default: 0 },
    isFlagged: { type: Boolean, default: false },
    fraudFlags: [{
      reason: String,
      severity: { type: String, enum: ["low", "medium", "high"] },
      details: String,
      createdAt: { type: Date, default: Date.now }
    }],
    loginAttempts: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
    lastLoginIP: { type: String, default: null },
    monthlyBudget: { type: Number, default: 0 },
    aiPro: { type: Boolean, default: false },
    aiProExpiry: { type: Date, default: null },
    aiDailyUsage: { type: Number, default: 0 },
    aiUsageDate: { type: String, default: null },
    phoneCheckDailyUsage: { type: Number, default: 0 },
    phoneCheckUsageDate: { type: String, default: null },
    loyaltyPoints: { type: Number, default: 0 },

    // ===========================
    // 🔗 TECHMART NETWORK
    // ===========================
    networkTier: {
      type: String,
      enum: ["Member", "Plus", "Premium", "Elite"],
      default: "Member"
    },
    networkScore: {
      type: Number,
      default: 0
    },
    networkJoinedAt: {
      type: Date,
      default: Date.now
    },
    networkReferralCount: {
      type: Number,
      default: 0
    },
    networkLifetimeSpend: {
      type: Number,
      default: 0
    },
    networkLoyaltyEarned: {
      type: Number,
      default: 0
    },
    networkSavingsBalance: {
      type: Number,
      default: 0
    },
    networkBnplCompleted: {
      type: Number,
      default: 0
    },
    networkLastActivity: {
      type: Date,
      default: null
    },
    networkBenefits: {
      cashbackMultiplier: {
        type: Number,
        default: 1
      },
      loyaltyMultiplier: {
        type: Number,
        default: 1
      },
      exclusiveDeals: {
        type: Boolean,
        default: false
      },
      prioritySupport: {
        type: Boolean,
        default: false
      }
    },
    totalPointsEarned: { type: Number, default: 0 },
    budgetAlertSent: { type: Boolean, default: false },
    bvnVerified: { type: Boolean, default: false },
    ninVerified: { type: Boolean, default: false },
    bvnLastAttempt: { type: Date, default: null },
    dailyFundingTotal: { type: Number, default: 0 },
    dailyFundingDate: { type: String, default: null },
    dailyTransferTotal: { type: Number, default: 0 },
    dailyTransferDate: { type: String, default: null },
    createdAt: { type: Date, default: Date.now }
  })
);
// ===========================
 // TECHMART PAY WALLET FUNDING
 // ===========================
const walletFundingSchema = new mongoose.Schema({
  reference: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  provider: {
    type: String,
    enum: ["paystack"],
    default: "paystack",
    required: true
  },
  currency: {
    type: String,
    enum: ["NGN"],
    default: "NGN",
    required: true
  },
  amountKobo: {
    type: Number,
    required: true,
    min: 1,
    validate: {
      validator: Number.isSafeInteger,
      message: "Funding amount must be a safe integer in kobo"
    }
  },
  status: {
    type: String,
    enum: ["pending", "credited", "failed"],
    default: "pending",
    required: true
  },
  paystackTransactionId: {
    type: String,
    default: null
  },
  expiresAt: {
    type: Date,
    default: null
  },
  paidAt: {
    type: Date,
    default: null
  },
  creditedAt: {
    type: Date,
    default: null
  },
  failureReason: {
    type: String,
    default: null
  }
}, { timestamps: true });

walletFundingSchema.index({ userId: 1, createdAt: -1 });

const WalletFunding = mongoose.model("WalletFunding", walletFundingSchema);

// 🧠 Behavioral Intelligence Schema
const BehaviorEvent = mongoose.model("BehaviorEvent", new mongoose.Schema({
  userId: { type: String, default: null },
  sessionId: { type: String, default: null },
  type: { type: String, enum: ["view", "search", "click", "add_to_cart", "abandon", "purchase", "wishlist"], required: true },
  productId: { type: String, default: null },
  productName: { type: String, default: null },
  category: { type: String, default: null },
  searchQuery: { type: String, default: null },
  price: { type: Number, default: null },
  metadata: { type: Object, default: {} },
  city: { type: String, default: "Lagos" },
  createdAt: { type: Date, default: Date.now }
}));

// 💳 BNPL Schema
const BNPLPlan = mongoose.model("BNPLPlan", new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Order",
    required: true
  },
  totalAmount: { type: Number, required: true },
  installments: { type: Number, enum: [2, 3], required: true },
  installmentAmount: { type: Number, required: true },
  paidInstallments: { type: Number, default: 1 },
  status: {
    type: String,
    enum: ["active", "completed", "defaulted"],
    default: "active"
  },
  payments: [{
    amount: Number,
    dueDate: Date,
    paidAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["paid", "pending", "overdue"],
      default: "pending"
    }
  }],
  createdAt: { type: Date, default: Date.now }
}));

// 🏦 Savings Vault Schema
// ===========================

// 🔗 TECHMART NETWORK ACTIVITY
// ===========================
const NetworkActivity = mongoose.model(
  "NetworkActivity",
  new mongoose.Schema({
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    type: {
      type: String,
      enum: [
        "purchase",
        "loyalty",
        "referral",
        "wallet",
        "savings",
        "bnpl",
        "bonus",
        "tier_upgrade"
      ],
      required: true
    },
    points: {
      type: Number,
      default: 0
    },
    amount: {
      type: Number,
      default: 0
    },
    description: {
      type: String,
      default: ""
    },
    reference: {
      type: String,
      default: ""
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  })
);

const SavingsVault = mongoose.model("SavingsVault", new mongoose.Schema({
  userId: { type: String, required: true },
  amount: { type: Number, required: true },
  lockDays: { type: Number, enum: [7, 30, 90], required: true },
  interestRate: { type: Number, default: 5 },
  expectedInterest: { type: Number, required: true },
  maturityDate: { type: Date, required: true },
  status: { type: String, enum: ["active", "matured", "withdrawn"], default: "active" },
  interestCredited: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}));

// 🎁 Gift Card Schema
const GiftCard = mongoose.model("GiftCard", new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  purchasedBy: { type: String, required: true },
  redeemedBy: { type: String, default: null },
  status: { type: String, enum: ["active", "redeemed", "expired"], default: "active" },
  expiresAt: { type: Date, required: true },
  redeemedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
}));

// 🔗 Payment Link Schema
const PaymentLink = mongoose.model("PaymentLink", new mongoose.Schema({
  linkId: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  userName: { type: String, required: true },
  userEmail: { type: String, required: true },
  amount: { type: Number, required: true },
  description: { type: String, default: "" },
  paidCount: { type: Number, default: 0 },
  totalCollected: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
}));

// 📢 Sponsored Listing Schema
const SponsoredListing = mongoose.model("SponsoredListing", new mongoose.Schema({
  sellerId: { type: String, required: true },
  productId: { type: String, required: true },
  productName: { type: String, required: true },
  amount: { type: Number, default: 2000 },
  status: { type: String, enum: ["active", "expired"], default: "active" },
  expiresAt: { type: Date, required: true },
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}));

// 🔄 Webhook Event Log (prevents duplicate processing)
const WebhookEvent = mongoose.model("WebhookEvent", new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  event: { type: String, required: true },
  status: { type: String, enum: ["processed", "failed", "ignored"], default: "processed" },
  metadata: { type: Object, default: {} },
  processedAt: { type: Date, default: Date.now }
}));

// 📊 TechMart System Monitor
const SystemMonitor = mongoose.model("SystemMonitor", new mongoose.Schema({
  service: { type: String, required: true, unique: true, index: true },
  status: {
    type: String,
    enum: ["healthy", "degraded", "down"],
    default: "healthy"
  },
  lastCheckedAt: { type: Date, default: Date.now },
  lastSuccessAt: { type: Date, default: null },
  lastFailureAt: { type: Date, default: null },
  lastError: { type: String, default: "" },
  responseTimeMs: { type: Number, default: null },
  metadata: { type: Object, default: {} }
}));

async function recordSystemStatus(service, status, details = {}) {
  try {
    const update = {
      service,
      status,
      lastCheckedAt: new Date(),
    };

    if (status === "healthy") {
      update.lastSuccessAt = new Date();
      update.lastError = "";
    } else {
      update.lastFailureAt = new Date();
      update.lastError = details.error || "";
    }

    if (details.responseTimeMs !== undefined) {
      update.responseTimeMs = details.responseTimeMs;
    }

    if (details.metadata !== undefined) {
      update.metadata = details.metadata;
    }

    await SystemMonitor.findOneAndUpdate(
      { service },
      { $set: update },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error(`System monitor write failed for ${service}:`, err.message);
  }
}

// 🚨 Product Report Schema
const ProductReport = mongoose.model("ProductReport", new mongoose.Schema({
  productId: { type: String, required: true },
  productName: { type: String, required: true },
  reportedBy: { type: String, required: true },
  reporterEmail: { type: String, required: true },
  reason: { type: String, enum: ["fake", "counterfeit", "wrong_description", "inappropriate", "scam", "other"], required: true },
  details: { type: String, default: "" },
  status: { type: String, enum: ["pending", "reviewed", "resolved"], default: "pending" },
  createdAt: { type: Date, default: Date.now }
}));

const Product = mongoose.model(
  "Product",
  new mongoose.Schema({
    name: String,
    price: Number,
    images: [String],
    description: String,
    stock: Number,
    vendorId: String,
    vendorName: String,
    category: String,
    techmartVerified: { type: Boolean, default: false },
    techmartVerifiedAt: { type: Date, default: null },
    verificationChecks: {
      sellerKyc: { type: Boolean, default: false },
      imei: { type: Boolean, default: false },
      aiDeviceCheck: { type: Boolean, default: false },
      fraudCheck: { type: Boolean, default: false }
    },
    condition: { type: String, default: "New" },
    storage: { type: String, default: "" },
    ram: { type: String, default: "" },
    battery: { type: String, default: "" },
    grade: { type: String, default: "" },
    workingStatus: { type: String, default: "" },
    variants: [{
      name: String,
      color: { type: String, default: "" },
      size: { type: String, default: "" },
      storage: { type: String, default: "" },
      ram: { type: String, default: "" },
      battery: { type: String, default: "" },
      grade: { type: String, default: "" },
      workingStatus: { type: String, default: "" },
      condition: { type: String, default: "New" },
      price: {
        type: Number,
        default: 0
      },
      stock: { type: Number, default: 0 }
    }],
    priceHistory: [{
      price: Number,
      recordedAt: { type: Date, default: Date.now }
    }],
    rating: { type: Number, default: 0 },
    reviews: [
      {
        user: String,
        email: String,
        comment: String,
        stars: Number,
        verified: { type: Boolean, default: false },
        approved: { type: Boolean, default: false },
        flagged: { type: Boolean, default: false },
        sentiment: { type: String, default: "neutral" },
        createdAt: { type: Date, default: Date.now }
      }
    ],
    createdAt: { type: Date, default: Date.now }
  })
);

// ============================================================
// 🔎 SEO — robots.txt + dynamic sitemap.xml
// ============================================================

app.get("/robots.txt", (req, res) => {
  const frontendUrl = (
    process.env.FRONTEND_URL ||
    "https://techmart-frontend.onrender.com"
  ).replace(/\/$/, "");

  res.type("text/plain").send(
`User-agent: *
Allow: /

Sitemap: ${frontendUrl}/sitemap.xml`
  );
});

app.get("/sitemap.xml", async (req, res) => {
  try {
    const frontendUrl = (
      process.env.FRONTEND_URL ||
      "https://techmart-frontend.onrender.com"
    ).replace(/\/$/, "");

    const products = await Product.find(
      {},
      {
        _id: 1,
        createdAt: 1
      }
    ).lean();

    const urls = [];

    // Homepage
    urls.push(`
  <url>
    <loc>${frontendUrl}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`);

    // Product pages
    for (const product of products) {
      if (!product._id) continue;

      const lastmod = product.createdAt
        ? `<lastmod>${new Date(product.createdAt).toISOString()}</lastmod>`
        : "";

      urls.push(`
  <url>
    <loc>${frontendUrl}/product/${product._id}</loc>
    ${lastmod}
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`);
    }

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("")}
</urlset>`;

    res
      .status(200)
      .type("application/xml")
      .send(sitemap);

  } catch (error) {
    console.error("❌ Sitemap generation failed:", error);

    const frontendUrl = (
      process.env.FRONTEND_URL ||
      "https://techmart-frontend.onrender.com"
    ).replace(/\/$/, "");

    res
      .status(500)
      .type("application/xml")
      .send(
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${frontendUrl}/</loc>
  </url>
</urlset>`
      );
  }
});


const Order = mongoose.model(
  "Order",
  new mongoose.Schema({
    email: String,
    items: Array,
    amount: Number,
    status: { type: String, default: "Pending" },
    reference: String,
    trackingNumber: String,
    deliveryAddress: { type: String, default: "" },
    phone: { type: String, default: "" },
    deliveryFee: { type: Number, default: 0 },
    deliveryZone: { type: String, default: "" },
    paymentMethod: { type: String, default: "Paystack" },
    depositPaid: { type: Number, default: 0 },
    depositReference: { type: String, default: "" },
    podPaymentReference: { type: String, default: "" },

// Order confirmation email tracking
confirmationEmailSent: { type: Boolean, default: false },
confirmationEmailSentAt: { type: Date, default: null },
confirmationEmailError: { type: String, default: "" },
    originalAmount: Number,
    couponCode: String,
    escrow: { type: Boolean, default: false },
    escrowStatus: { type: String, enum: ["holding", "released", "refunded", "none"], default: "none" },
    escrowReleasedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: "" },
    buyerConfirmed: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
  })
);

// Return Model
const ReturnSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
  buyerEmail: { type: String, required: true },
  buyerName: { type: String },
  reason: { type: String, required: true },
  description: { type: String },
  status: { type: String, enum: ["pending", "approved", "rejected", "completed"], default: "pending" },
  refundAmount: { type: Number, default: 0 },
  adminNote: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
});
const Return = mongoose.model("Return", ReturnSchema);

// Coupon Model
const CouponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  type: { type: String, enum: ["percent", "fixed"], default: "percent" },
  value: { type: Number, required: true },
  minOrder: { type: Number, default: 0 },
  expiresAt: { type: Date, default: null },
  active: { type: Boolean, default: true }
}, { timestamps: true });
const Coupon = mongoose.model("Coupon", CouponSchema);

/* ===========================
   🎁 REFERRAL CODE GENERATOR
=========================== */
function generateReferralCode(name) {
  const clean = name.replace(/\s+/g, "").toUpperCase().slice(0, 5);
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${clean}${random}`;
}
/* ===========================
   🔐 AUTH MIDDLEWARE
=========================== */
async function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  if (await tokenBlacklist.has(token)) return res.status(401).json({ error: "Token has been invalidated. Please log in again." });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

async function adminOnly(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  if (await tokenBlacklist.has(token)) return res.status(401).json({ error: "Token has been invalidated" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== "admin") return res.status(403).json({ error: "Admin only" });
    // Verify role in DB to prevent stale JWT attacks
    const user = await User.findById(decoded.id).select("role").lean();
    if (!user || user.role !== "admin") return res.status(403).json({ error: "Admin access revoked" });
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ===========================
   🏠 ROOT
=========================== */
app.get("/", (req, res) => {
  res.json({ status: "TechMart Enterprise API 🚀" });
});

/* ===========================
   🔐 AUTH ROUTES
=========================== */

/* SIGNUP */
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, password } = req.body;
    const email = req.body.email ? String(req.body.email).toLowerCase().trim() : req.body.email;
    if (!name || !email || !password) return res.status(400).json({ error: "Name, email, and password are required" });
    const { referralCode } = req.body;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: "Invalid email address" });
    if (!isStrongPassword(password)) {
      return res.status(400).json({
        error:"Password must be 8+ characters with uppercase, lowercase, number and special character."
      });
    }
    if (name.trim().length < 2) return res.status(400).json({ error: "Name must be at least 2 characters" });
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: "User already exists" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const newReferralCode = crypto.randomBytes(4).toString("hex").toUpperCase();
    const user = await User.create({ name, email, password: hashedPassword, phone: req.body.phone || "", referralCode: newReferralCode });
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // 🔐 CREATE + SEND VERIFICATION EMAIL FIRST
    const verifyToken = crypto.randomBytes(32).toString("hex");
    await User.findByIdAndUpdate(user._id, {
      emailVerificationToken: verifyToken,
      emailVerificationExpires: new Date(Date.now() + 24*60*60*1000),
      emailVerificationSentAt: new Date()
    });

    let verificationEmailSent = false;
    try {
      const { sendEmailVerification } = require("./utils/email");
      await sendEmailVerification(user, verifyToken);
      verificationEmailSent = true;
    } catch (e) {
      // The send failed, so do not start the resend cooldown.
      await User.findByIdAndUpdate(user._id, { emailVerificationSentAt: null }).catch(() => {});
      console.error("Verify email failed:", {
        message: e.message,
        status: e.status || e.statusCode || null,
        code: e.code || null
      });
    }

    // 📧 SEND WELCOME EMAIL
    try {
      // Process referral if code provided
      if (referralCode) {
        const referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
        if (referrer && referrer._id.toString() !== user._id.toString()) {
          await User.findByIdAndUpdate(user._id, { referredBy: referralCode.toUpperCase() });
          await User.findByIdAndUpdate(referrer._id, {
            $inc: { referralCount: 1, referralCredits: 500, walletBalance: 500 },
            $push: { walletTransactions: { type: "credit", amount: 500, description: `Referral bonus — ${name} signed up`, createdAt: new Date() } }
          });
        }
      }
      await sendWelcomeEmail(user);
    } catch (e) {
      console.log("Welcome email failed:", e.message);
    }
    res.status(201).json({
      success: true,
      requireVerification: true,
      emailSent: verificationEmailSent,
      message: verificationEmailSent
        ? "Account created! Please check your email to verify your account."
        : "Account created, but the verification email could not be sent. Please try resending it."
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Signup failed" });
  }
});


/* VERIFY EMAIL */
const VERIFY_TOKEN_RE = /^[a-f0-9]{64}$/i;
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const RESEND_REUSE_MIN_LEFT_MS = 60 * 60 * 1000;

app.get("/api/auth/verify-email", async (req, res) => {
  try {
    const token = req.query.token;
    // Only a plain 64-character hex string is accepted. Objects such as ?token[$ne]=x never reach the database.
    if (typeof token !== "string" || !VERIFY_TOKEN_RE.test(token)) {
      return res.status(400).json({ error: "This verification link is not valid. Please request a new one.", code: "TOKEN_INVALID" });
    }
    const user = await User.findOne({ emailVerificationToken: token });
    if (!user) {
      console.warn("Email verification: token not found");
      return res.status(400).json({ error: "This link is no longer valid. If you already verified your email, please log in. Otherwise, request a new link.", code: "TOKEN_UNKNOWN" });
    }
    if (user.emailVerified) {
      return res.json({ success: true, alreadyVerified: true });
    }
    if (!user.emailVerificationExpires || new Date(user.emailVerificationExpires).getTime() <= Date.now()) {
      console.warn("Email verification: token expired");
      return res.status(400).json({ error: "This link has expired. Please request a new one.", code: "TOKEN_EXPIRED" });
    }
    // Only one request can flip the flag, so only one request receives a login token.
    const updated = await User.findOneAndUpdate({ _id: user._id, emailVerified: { $ne: true } }, { emailVerified: true }, { new: true });
    if (!updated) return res.json({ success: true, alreadyVerified: true });
    const jwtToken = jwt.sign({ id: user._id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ success: true, token: jwtToken, user: { id: user._id, name: user.name, email: user.email, role: user.role, referralCode: user.referralCode, walletBalance: user.walletBalance || 0, walletPinSet: user.walletPinSet || false, twoFactorEnabled: user.twoFactorEnabled || false } });
  } catch (err) {
    console.error("Email verification failed:", {
      message: err.message,
      status: err.status || err.statusCode || null,
      code: err.code || null
    });
    res.status(500).json({ error: "Verification failed" });
  }
});

app.post("/api/auth/resend-verification", async (req, res) => {
  try {
    const rawEmail = req.body && req.body.email;
    if (typeof rawEmail !== "string" || !rawEmail.trim()) return res.status(400).json({ error: "Email required" });
    const email = rawEmail.toLowerCase().trim();
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "Account not found" });
    if (user.emailVerified) return res.status(400).json({ error: "Email already verified" });

    const now = Date.now();
    const expiresAt = user.emailVerificationExpires ? new Date(user.emailVerificationExpires).getTime() : 0;
    // Keep the existing token while it has more than an hour left, so earlier emails keep working.
    const keepToken = Boolean(user.emailVerificationToken) && expiresAt - now > RESEND_REUSE_MIN_LEFT_MS;
    const verifyToken = keepToken ? user.emailVerificationToken : crypto.randomBytes(32).toString("hex");
    const update = { emailVerificationSentAt: new Date(now) };
    if (!keepToken) {
      update.emailVerificationToken = verifyToken;
      update.emailVerificationExpires = new Date(now + VERIFY_TOKEN_TTL_MS);
    }
    // Atomic cooldown: only one request per minute can claim a send for this account.
    const claimed = await User.findOneAndUpdate(
      { _id: user._id, emailVerified: { $ne: true }, $or: [{ emailVerificationSentAt: null }, { emailVerificationSentAt: { $lte: new Date(now - RESEND_COOLDOWN_MS) } }] },
      { $set: update },
      { new: true }
    );
    if (!claimed) {
      return res.status(429).json({ error: "A verification email was just sent. Please wait a minute, then check your inbox and spam folder before asking for another.", code: "RESEND_COOLDOWN" });
    }
    const { sendEmailVerification } = require("./utils/email");
    try {
      await sendEmailVerification(user, verifyToken);
    } catch (sendErr) {
      // The send failed, so do not start the cooldown: put the previous send time back so the person can retry.
      await User.findOneAndUpdate({ _id: user._id }, { $set: { emailVerificationSentAt: user.emailVerificationSentAt || null } }).catch(() => {});
      throw sendErr;
    }
    res.json({ success: true, message: "Verification email resent!" });
  } catch (err) {
    console.error("Resend verification email failed:", {
      message: err.message,
      status: err.status || err.statusCode || null,
      code: err.code || null
    });
    res.status(500).json({ error: "We couldn't send the verification email. Please try again later." });
  }
});

/* LOGIN */
app.post("/api/auth/login", async (req, res) => {
  try {
    const { password } = req.body;
    const email = req.body.email ? String(req.body.email).toLowerCase().trim() : req.body.email;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "User not found" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Wrong password" });
    analyzeFraud(user, "login", { email: user.email, accountAge: Math.floor((Date.now() - new Date(user.createdAt)) / 86400000) + " days" }).catch(() => {});
    const { deviceToken } = req.body;
    const isKnownDevice = deviceToken && user.deviceTokens && user.deviceTokens.includes(deviceToken);
    // Skip OTP only if device is known
    if (isKnownDevice) {
      const token = jwt.sign(
        { id: user._id, email: user.email, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );
      return res.json({ success: true, token, requireOtp: false, user: { id: user._id, name: user.name, email: user.email, role: user.role, walletBalance: user.walletBalance, walletPinSet: user.walletPinSet, twoFactorEnabled: user.twoFactorEnabled } });
    }
    // Unknown device — require OTP regardless of 2FA setting
    res.json({ success: true, requireOtp: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

/* FORGOT PASSWORD */
app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const email = req.body.email ? String(req.body.email).toLowerCase().trim() : req.body.email;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const user = await User.findOne({ email });
    if (!user) {
      // Prevent user enumeration by acting successful
      return res.json({ success: true, message: "If that email exists in our system, a recovery token has been generated." });
    }

    // Generate a cryptographically secure 6-digit recovery code.
    // The code is valid for 15 minutes and is never logged.
    const resetToken = randomInt(100000, 1000000).toString();
    const resetTokenHash = await bcrypt.hash(resetToken, 10);

    user.resetPasswordToken = resetTokenHash;
    user.resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();

    // 📧 SEND RESET EMAIL
    try {
      if (typeof sendPasswordResetEmail === "function") {
        await sendPasswordResetEmail(user.email, resetToken);
      }
    } catch (e) {
      // If your mailing configuration errors out on Render, log it here but DO NOT crash the request
      console.error("⚠️ Reset email dispatch failed:", e.message);
    }

    // Always send a success JSON response back to the browser frontend
    return res.json({ success: true, message: "If that email exists in our system, a recovery token has been generated." });

  } catch (err) {
    console.error("❌ CRITICAL FORGOT PASSWORD ERROR:", err);
    return res.status(500).json({ error: "Forgot password routine failed" });
  }
});

/* RESET PASSWORD */
app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;
    const normalizedEmail = email ? String(email).toLowerCase().trim() : "";

    if (!normalizedEmail || !token || !newPassword) {
      return res.status(400).json({
        error: "Email, token and new password are required"
      });
    }

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        error:"Password must be 8+ characters with uppercase, lowercase, number and special character."
      });
    }

    const user = await User.findOne({
      email: normalizedEmail,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user || !user.resetPasswordToken) {
      return res.status(400).json({ error: "Invalid or expired recovery token" });
    }

    const tokenValid = await bcrypt.compare(
      String(token).trim(),
      user.resetPasswordToken
    );

    if (!tokenValid) {
      return res.status(400).json({ error: "Invalid or expired recovery token" });
    }

    // Update and hash password securely
    user.password = await bcrypt.hash(newPassword, 10);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    return res.json({ success: true, message: "Your TechMart account password has been updated successfully!" });
  } catch (err) {
    console.error("❌ CRITICAL RESET PASSWORD ERROR:", err);
    return res.status(500).json({ error: "Reset password routine failed" });
  }
});
/* ===========================
   🚪 LOGOUT
=========================== */
app.post("/api/auth/logout", auth, async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (token) {
    await tokenBlacklist.add(token);
  }
  res.json({ success: true, message: "Logged out successfully" });
});

/* ===========================
   �� HEALTH
=========================== */
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "TechMart API", timestamp: new Date().toISOString() });
});

/* ===========================
   👤 USER PROFILE
=========================== */
const SYSTEM_MONITOR_STALE_WINDOWS = {
  "abandoned-cart-recovery": 30 * 60 * 1000,
  "bnpl-auto-deduction": 26 * 60 * 60 * 1000,
  "auto-wallet-reconciliation": 26 * 60 * 60 * 1000,
  "sponsored-listing-expiry": 26 * 60 * 60 * 1000,
  "ai-pro-expiry": 26 * 60 * 60 * 1000,
  "gift-card-expiry": 26 * 60 * 60 * 1000,
  "savings-vault-maturity": 26 * 60 * 60 * 1000,
  "auto-seller-payout": 8 * 24 * 60 * 60 * 1000,
  "ai-seller-coach": 8 * 24 * 60 * 60 * 1000
};

app.get("/api/admin/system-monitor", adminOnly, async (req, res) => {
  try {
    const services = await SystemMonitor.find({})
      .sort({ service: 1 })
      .lean();

    const now = Date.now();

    const evaluatedServices = services.map(service => {
      const staleWindow = SYSTEM_MONITOR_STALE_WINDOWS[service.service];

      if (
        staleWindow &&
        service.status === "healthy" &&
        service.lastSuccessAt &&
        now - new Date(service.lastSuccessAt).getTime() > staleWindow
      ) {
        return {
          ...service,
          status: "degraded",
          lastError: "Service missed its expected execution window."
        };
      }

      return service;
    });

    res.json({
      success: true,
      services: evaluatedServices
    });
  } catch (err) {
    console.error("System monitor fetch failed:", err.message);
    res.status(500).json({ error: "Failed to fetch system monitor" });
  }
});

app.get("/api/users/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password -walletPin -otpCode -resetPasswordToken -fraudFlags -loginAttempts -lastLoginIP");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

/* ===========================
   🛍 PRODUCTS
=========================== */
app.get("/api/products", async (req, res) => {
  try {
    const { search, category, minPrice, maxPrice } = req.query;
    const filter = {};
    if (search) filter.name = { $regex: search, $options: "i" };
    if (category) filter.category = { $regex: category, $options: "i" };
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }
    const products = await Product.find(filter).sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

app.post("/api/products", adminOnly, async (req, res) => {
  try {
    const product = await Product.create(req.body);
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create product" });
  }
});

app.put("/api/products/:id", adminOnly, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    let variants = product.variants;

    try {
      if (req.body.variants) {
        const parsed = JSON.parse(req.body.variants);
        if (Array.isArray(parsed)) {
          variants = parsed;
        }
      }
    } catch {
      console.warn("⚠️ Invalid variants JSON");
    }

    // Track price history if price changed
    if (req.body.price && Number(req.body.price) !== product.price) {
      product.priceHistory = product.priceHistory || [];
      product.priceHistory.push({ price: product.price, recordedAt: new Date() });
      await product.save();
    }
    const updates = {
      name: req.body.name ?? product.name,
      description: req.body.description ?? product.description,
      category: req.body.category ?? product.category,
      condition: req.body.condition ?? product.condition,
      price:
        req.body.price !== undefined
          ? Number(req.body.price)
          : product.price,
      stock:
        req.body.stock !== undefined
          ? Number(req.body.stock)
          : product.stock,
      variants
    };

    const updated = await Product.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true }
    );

    res.json(updated);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update product" });
  }
});

app.delete("/api/products/:id", adminOnly, async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete product" });
  }
});


/* ===========================
   🔗 TECHMART NETWORK API
=========================== */

// Get current Network status
app.get("/api/network/status", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      "name email networkTier networkScore networkJoinedAt networkReferralCount networkLifetimeSpend networkLoyaltyEarned networkSavingsBalance networkBnplCompleted networkLastActivity networkBenefits"
    );

    if (!user) {
      return res.status(404).json({
        error: "User not found"
      });
    }

    const thresholds = {
      Member: 0,
      Plus: 2000,
      Premium: 5000,
      Elite: 10000
    };

    const tiers = ["Member", "Plus", "Premium", "Elite"];
    const currentIndex = tiers.indexOf(user.networkTier || "Member");
    const nextTier = tiers[currentIndex + 1] || null;
    const nextThreshold = nextTier ? thresholds[nextTier] : null;

    const progress = nextThreshold
      ? Math.min(
          100,
          Math.round(
            ((user.networkScore - thresholds[user.networkTier]) /
              (nextThreshold - thresholds[user.networkTier])) *
              100
          )
        )
      : 100;

    res.json({
      success: true,
      network: {
        tier: user.networkTier || "Member",
        score: user.networkScore || 0,
        joinedAt: user.networkJoinedAt,
        nextTier,
        nextThreshold,
        progress,
        referrals: user.networkReferralCount || 0,
        lifetimeSpend: user.networkLifetimeSpend || 0,
        loyaltyEarned: user.networkLoyaltyEarned || 0,
        savingsBalance: user.networkSavingsBalance || 0,
        bnplCompleted: user.networkBnplCompleted || 0,
        lastActivity: user.networkLastActivity,
        benefits: user.networkBenefits || getNetworkBenefits(user.networkTier)
      }
    });
  } catch (err) {
    console.error("Network status error:", err);
    res.status(500).json({
      error: "Failed to load Network status"
    });
  }
});


// Network activity history
app.get("/api/network/activity", auth, async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(Number(req.query.limit) || 20, 1),
      100
    );

    const activities = await NetworkActivity.find({
      userId: req.user.id
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({
      success: true,
      activities
    });
  } catch (err) {
    console.error("Network activity error:", err);
    res.status(500).json({
      error: "Failed to load Network activity"
    });
  }
});


// Network benefits
app.get("/api/network/benefits", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      "networkTier networkBenefits"
    );

    if (!user) {
      return res.status(404).json({
        error: "User not found"
      });
    }

    res.json({
      success: true,
      tier: user.networkTier || "Member",
      benefits:
        user.networkBenefits ||
        getNetworkBenefits(user.networkTier || "Member")
    });
  } catch (err) {
    console.error("Network benefits error:", err);
    res.status(500).json({
      error: "Failed to load Network benefits"
    });
  }
});


// Network leaderboard / public-safe stats
app.get("/api/network/tiers", auth, async (req, res) => {
  res.json({
    success: true,
    tiers: [
      {
        name: "Member",
        minimumScore: 0,
        benefits: getNetworkBenefits("Member")
      },
      {
        name: "Plus",
        minimumScore: 2000,
        benefits: getNetworkBenefits("Plus")
      },
      {
        name: "Premium",
        minimumScore: 5000,
        benefits: getNetworkBenefits("Premium")
      },
      {
        name: "Elite",
        minimumScore: 10000,
        benefits: getNetworkBenefits("Elite")
      }
    ]
  });
});

/* ===========================
   📦 ORDERS
=========================== */
app.post("/api/orders", auth, async (req, res) => {
  try {
    const { items, amount, deliveryAddress, phone, paymentMethod, escrow } = req.body;
    // Validate items
    if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Order must contain at least one item" });
    if (!deliveryAddress?.trim()) return res.status(400).json({ error: "Delivery address is required" });
    if (!phone?.trim()) return res.status(400).json({ error: "Phone number is required" });
    // Validate stock for each item
    const validatedItems = [];
    for (const item of items) {
      if (!item.productId) return res.status(400).json({ error: "Invalid item — missing productId" });
      const qty = Number(item.quantity) || 1;
      if (qty < 1) return res.status(400).json({ error: "Quantity must be at least 1" });
      if (qty > 100) return res.status(400).json({ error: `Quantity cannot exceed 100 per item` });
      const product = await Product.findById(item.productId).select("name price stock vendorId");
      if (!product) return res.status(404).json({ error: `Product not found: ${item.productId}` });
      if (product.stock < qty) return res.status(400).json({ error: `Sorry, only ${product.stock} unit(s) of "${product.name}" available` });
      validatedItems.push({ ...item, name: product.name, price: product.price, quantity: qty, vendorId: product.vendorId });
    }
    const order = await Order.create({
      email: req.user.email,
      items: validatedItems,
      amount,
      reference: "TX-" + Date.now(),
      deliveryAddress: sanitize(deliveryAddress),
      phone: sanitize(phone),
      paymentMethod: paymentMethod || "Paystack",
      escrow: escrow || false,
      escrowStatus: escrow ? "holding" : "none"
    });
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Order failed" });
  }
});

// AI quick-buy is disabled. Orders must go through normal checkout.
app.post("/api/orders/buy-now", auth, async (req, res) => {
  return res.status(410).json({
    success: false,
    error: "AI cannot place orders. Please use checkout to enter your delivery address and complete payment."
  });
});
app.get("/api/orders/me", auth, async (req, res) => {
  try {
    const orders = await Order.find({ email: req.user.email });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/* =========================================================================
   💳 PAYSTACK (INTEGRATED WITH ATOMIC STOCK HANDLING & IDEMPOTENT WEBHOOK)
========================================================================= */

/* 1. INITIALIZE TRANSACTION & LOCK STOCK */


// Seller Model
const SellerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  phone: { type: String, default: "" },
  storeName: { type: String, required: true },
  storeDescription: { type: String, default: "" },
  storeBanner: { type: String, default: "" },
  storeLogo: { type: String, default: "" },
  storeColor: { type: String, default: "#f97316" },
  // Seller classification and registered-business details
  sellerType: {
    type: String,
    enum: ["individual", "business"],
    default: "individual"
  },
  businessLegalName: { type: String, default: "" },
  cacRegistrationNumber: { type: String, default: "" },

  // Seller bank details (also used by existing payout workflows)
  bankCode: { type: String, default: "" },
  bankName: { type: String, default: "" },
  accountNumber: { type: String, default: "" },
  accountName: { type: String, default: "" },

  // Independent verification layers
  verification: {
    cac: {
      status: {
        type: String,
        enum: ["not_submitted", "pending", "under_review", "verified", "failed", "rejected", "not_applicable"],
        default: "not_submitted"
      },
      verifiedAt: { type: Date, default: null },
      reviewerNote: { type: String, default: "" }
    },
    bank: {
      status: {
        type: String,
        enum: ["not_submitted", "pending", "under_review", "verified", "failed", "rejected"],
        default: "not_submitted"
      },
      verifiedAccountName: { type: String, default: "" },
      providerReference: { type: String, default: "" },
      verifiedAt: { type: Date, default: null }
    },
    ninFaceMatch: {
      status: {
        type: String,
        enum: ["not_submitted", "pending", "under_review", "verified", "failed", "rejected"],
        default: "not_submitted"
      },
      faceMatchStatus: {
        type: String,
        enum: ["not_checked", "matched", "not_matched", "inconclusive"],
        default: "not_checked"
      },
      providerReference: { type: String, default: "" },
      verifiedAt: { type: Date, default: null }
    },
    guarantors: {
      status: {
        type: String,
        enum: ["not_submitted", "pending", "under_review", "verified", "failed", "rejected"],
        default: "not_submitted"
      },
      references: [{
        name: { type: String, default: "" },
        phone: { type: String, default: "" },
        relationship: { type: String, default: "" },
        consent: { type: Boolean, default: false },
        status: {
          type: String,
          enum: ["pending", "contacted", "verified", "rejected"],
          default: "pending"
        }
      }],
      verifiedAt: { type: Date, default: null }
    },
    liveAddress: {
      status: {
        type: String,
        enum: ["not_submitted", "pending", "under_review", "verified", "failed", "rejected"],
        default: "not_submitted"
      },
      address: { type: String, default: "" },
      proofReference: { type: String, default: "" },
      verifiedAt: { type: Date, default: null }
    },
    shop: {
      status: {
        type: String,
        enum: ["not_submitted", "pending", "under_review", "verified", "failed", "rejected"],
        default: "not_submitted"
      },
      photoReferences: [{ type: String }],
      verifiedAt: { type: Date, default: null },
      reviewerNote: { type: String, default: "" }
    }
  },

  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
  verified: { type: Boolean, default: false },
  techmartVerifiedAt: { type: Date, default: null },
  verificationLevel: {
    type: String,
    enum: ["none", "seller", "trusted"],
    default: "none"
  },
  verificationChecks: {
    kyc: { type: Boolean, default: false },
    fraudCheck: { type: Boolean, default: false }
  },
  commission: { type: Number, default: 10 },
  totalSales: { type: Number, default: 0 },
  walletBalance: { type: Number, default: 0 },
  walletTransactions: [{
    type: { type: String, enum: ["credit", "debit"] },
    amount: Number,
    description: String,
    reference: String,
    createdAt: { type: Date, default: Date.now }
  }],
  resetPasswordToken: { type: String, default: null },
  resetPasswordExpires: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now }
});
const Seller = mongoose.model("Seller", SellerSchema);

// Flash Sale Model
const FlashSaleSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  productName: { type: String, required: true },
  originalPrice: { type: Number, required: true },
  salePrice: { type: Number, required: true },
  startTime: { type: Date, required: true },
  endTime: { type: Date, required: true },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});
const FlashSale = mongoose.model("FlashSale", FlashSaleSchema);


// Payout Request Model
const PayoutSchema = new mongoose.Schema({
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "Seller", required: true },
  sellerName: String,
  sellerEmail: String,
  storeName: String,
  amount: { type: Number, required: true },
  bankCode: String,
  bankName: String,
  accountNumber: String,
  accountName: String,
  reference: String,
  payoutType: { type: String, enum: ["manual", "withdrawal", "auto_weekly"], default: "manual" },
  fundsReserved: { type: Boolean, default: false },
  transferStatus: { type: String, enum: ["pending", "processing", "success", "failed", "reversed"], default: "pending" },
  transferCode: String,
  transferId: String,
  processedAt: Date,
  status: { type: String, enum: ["pending", "approved", "paid", "rejected"], default: "pending" },
  note: String,
  createdAt: { type: Date, default: Date.now }
});
const Payout = mongoose.model("Payout", PayoutSchema);

// Dispute Model
const DisputeSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
  customerId: String,
  customerEmail: String,
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "Seller" },
  sellerName: String,
  subject: String,
  description: String,
  status: { type: String, enum: ["open", "seller_responded", "resolved", "closed"], default: "open" },
  messages: [{
    sender: String,
    senderType: { type: String, enum: ["customer", "seller", "admin"] },
    message: String,
    createdAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});
const Dispute = mongoose.model("Dispute", DisputeSchema);

// Seller Message Model
const SellerMessageSchema = new mongoose.Schema({
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "Seller" },
  customerEmail: String,
  customerName: String,
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
  productName: String,
  messages: [{
    sender: String,
    senderType: { type: String, enum: ["customer", "seller"] },
    message: String,
    read: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});
const SellerMessage = mongoose.model("SellerMessage", SellerMessageSchema);

/* ===========================
   COUPON ENDPOINTS
=========================== */
// Validate coupon
app.post("/api/coupons/validate", async (req, res) => {
  try {
    const { code, orderTotal } = req.body;
    const coupon = await Coupon.findOne({ code: code.toUpperCase(), active: true });
    if (!coupon) return res.status(404).json({ error: "Invalid or expired coupon code" });
    if (coupon.expiresAt && new Date() > coupon.expiresAt) {
      return res.status(400).json({ error: "This coupon has expired" });
    }
    if (orderTotal < coupon.minOrder) {
      return res.status(400).json({ error: `Minimum order of ₦${coupon.minOrder.toLocaleString()} required` });
    }
    const discount = coupon.type === "percent"
      ? Math.round((coupon.value / 100) * orderTotal)
      : Math.min(coupon.value, orderTotal);
    res.json({ success: true, code: coupon.code, type: coupon.type, value: coupon.value, discount });
  } catch (err) {
    res.status(500).json({ error: "Failed to validate coupon" });
  }
});

// Create coupon (admin only)
app.post("/api/admin/coupons", adminOnly, async (req, res) => {
  try {
    const { code, type, value, minOrder, expiresAt } = req.body;
    const coupon = await Coupon.create({ code, type, value, minOrder, expiresAt: expiresAt || null });
    res.status(201).json({ success: true, data: coupon });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: "Coupon code already exists" });
    res.status(500).json({ error: "Failed to create coupon" });
  }
});

// Get all coupons (admin only)
app.get("/api/admin/coupons", adminOnly, async (req, res) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 });
    res.json(coupons);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch coupons" });
  }
});

// Delete coupon (admin only)
app.delete("/api/admin/coupons/:id", adminOnly, async (req, res) => {
  try {
    await Coupon.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete coupon" });
  }
});


const { upload: adminUploader, cloudinary: cloudinaryCloud } = require("./utils/uploader");


// Wallet & Cashback Config
const CASHBACK_PERCENT = 2; // 2% cashback on every order





// One-time: clean up product categories
app.post("/api/admin/fix-categories", adminOnly, async (req, res) => {
  try {
    const products = await Product.find();
    let updated = 0;
    for (const p of products) {
      const name = p.name?.toLowerCase() || "";
      const cat = p.category?.trim().toLowerCase() || "";
      let newCategory = p.category?.trim() || "Electronics";

      // Assign proper categories based on product name
      if (name.includes("iphone") || name.includes("xiaomi") || name.includes("redmi") || name.includes("samsung") && name.includes("phone")) {
        newCategory = "Phones";
      } else if (name.includes("macbook") || name.includes("laptop") || name.includes("elitebook") || name.includes("latitude") || name.includes("thinkpad")) {
        newCategory = "Laptops";
      } else if (name.includes("mac mini") || name.includes("imac") || name.includes("desktop") || name.includes("monitor")) {
        newCategory = "Computers";
      } else if (name.includes("airpod") || name.includes("headphone") || name.includes("earphone") || name.includes("speaker") || name.includes("zealot") || name.includes("tws")) {
        newCategory = "Audio";
      } else if (name.includes("watch")) {
        newCategory = "Wearables";
      } else if (name.includes("keyboard") || name.includes("mouse") || name.includes("case") || name.includes("charger") || name.includes("cable") || name.includes("type-c") || name.includes("sticker")) {
        newCategory = "Accessories";
      } else if (name.includes("printer") || name.includes("deskjet")) {
        newCategory = "Printers";
      } else if (name.includes("power bank") || name.includes("powerbank")) {
        newCategory = "Accessories";
      } else if (name.includes("gaming")) {
        newCategory = "Gaming";
      } else if (cat === "electronic" || cat === "electronic " || cat === "electronics") {
        newCategory = "Electronics";
      }

      if (newCategory !== p.category) {
        await Product.findByIdAndUpdate(p._id, { category: newCategory });
        updated++;
      }
    }
    res.json({ success: true, updated, total: products.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



/* ===========================
   🛡️ AI FRAUD DETECTION
=========================== */
async function analyzeFraud(user, action, details) {
  try {
    const recentTxns = (user.walletTransactions || []).slice(-20);
    const totalDebits = recentTxns.filter(t => t.type === "debit").reduce((s, t) => s + t.amount, 0);
    const txnCount = recentTxns.length;
    const accountAgeDays = Math.floor((Date.now() - new Date(user.createdAt)) / (1000 * 60 * 60 * 24));

    const prompt = `You are a fraud detection AI for TechMart, a Nigerian e-commerce platform.
Analyze this user activity and return a JSON object with:
- score: number 0-100 (0=safe, 100=definitely fraud)
- severity: "low" | "medium" | "high" | "none"
- reason: short string explaining the risk
- flag: boolean (true if score >= 60)

User profile:
- Account age: ${accountAgeDays} days
- Total wallet debits (last 20 txns): N${totalDebits}
- Transaction count (last 20): ${txnCount}
- Already flagged: ${user.isFlagged}
- Current fraud score: ${user.fraudScore}

Current action: ${action}
Action details: ${JSON.stringify(details)}

Common fraud patterns to detect:
- New account (< 3 days) making large transactions
- More than 5 airtime purchases within 1 hour
- Transfer amount > 50000 in a single transaction
- Rapid repeated transfers to same recipient
- Multiple failed login attempts then sudden activity

Respond ONLY with valid JSON, no markdown.`;

    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      temperature: 0.1
    });

    const raw = completion.choices[0].message.content.trim();
    const result = JSON.parse(raw.replace(/```json|```/g, "").trim());

    if (result.flag && result.severity !== "none") {
      await User.findByIdAndUpdate(user._id, {
        $inc: { fraudScore: result.score },
        $set: { isFlagged: true },
        $push: {
          fraudFlags: {
            reason: result.reason,
            severity: result.severity,
            details: JSON.stringify(details),
            createdAt: new Date()
          }
        }
      });
      console.log("FRAUD DETECTED: " + user.email + " - " + result.reason + " (score: " + result.score + ")");
    }

    return result;
  } catch (err) {
    console.error("Fraud detection error:", err.message);
    return { score: 0, flag: false, severity: "none", reason: "analysis failed" };
  }
}

/* ===========================
   TECHMART PAY
=========================== */

// 1. Create/Get Virtual Account for wallet funding
app.post("/api/pay/virtual-account", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    // Check if user already has a virtual account
    if (user.virtualAccountNumber) {
      return res.json({ success: true, account: { accountNumber: user.virtualAccountNumber, bankName: user.virtualAccountBank, accountName: user.name } });
    }

    // Create Paystack customer first
    const customerRes = await axios.post(
      "https://api.paystack.co/customer",
      { email: user.email, first_name: user.name.split(" ")[0], last_name: user.name.split(" ")[1] || user.name },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const customerCode = customerRes.data.data.customer_code;

    // Create dedicated virtual account
    const vaRes = await axios.post(
      "https://api.paystack.co/dedicated_account",
      { customer: customerCode, preferred_bank: "wema-bank" },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    const va = vaRes.data.data;
    await User.findByIdAndUpdate(req.user.id, {
      virtualAccountNumber: va.account_number,
      virtualAccountBank: va.bank?.name || "Wema Bank",
      paystackCustomerCode: customerCode
    });

    res.json({ success: true, account: { accountNumber: va.account_number, bankName: va.bank?.name || "Wema Bank", accountName: user.name } });
  } catch (err) {
    console.error("Virtual account error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create virtual account" });
  }
});


// 1b. Fund Wallet via Paystack Payment Link
app.post("/api/pay/fund-wallet", auth, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || Number(amount) < 100) return res.status(400).json({ error: "Minimum deposit is N100" });

    const user = await User.findById(req.user.id);
    const limitCheck = checkDailyLimit(user, "funding", amount);
    if (!limitCheck.ok) return res.status(400).json({ error: limitCheck.error });
    const reference = "WAL-" + Date.now();

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: user.email,
        amount: Number(amount) * 100, // kobo
        reference,
        metadata: {
          userId: user._id.toString(),
          email: user.email,
          name: user.name,
          purpose: "wallet_funding",
          custom_fields: [
            { display_name: "Purpose", variable_name: "purpose", value: "TechMart Wallet Funding" }
          ]
        },
        callback_url: `${process.env.FRONTEND_URL || "https://techmart-frontend.onrender.com"}/pay?funded=true`
      },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    res.json({
      success: true,
      paymentUrl: response.data.data.authorization_url,
      reference,
      amount
    });
  } catch (err) {
    console.error("Wallet funding error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to initialize payment" });
  }
});

// 2. Wallet to Wallet Transfer
// Reusable wallet PIN verification helper
async function verifyWalletPin(user, pin) {
  if (!user.walletPinSet) return { ok: false, error: "Please set a wallet PIN before making transactions" };
  if (!pin) return { ok: false, error: "Wallet PIN is required" };
  const match = await bcrypt.compare(String(pin), user.walletPin || "");
  if (!match) return { ok: false, error: "Incorrect PIN" };
  return { ok: true };
}

app.post("/api/pay/send", auth, pinLimiter, async (req, res) => {
  try {
    const { recipientEmail, amount, note, pin } = req.body;
    if (!recipientEmail || !amount) return res.status(400).json({ error: "Recipient email and amount are required" });
    if (Number(amount) < 100) return res.status(400).json({ error: "Minimum transfer is N100" });
    const sender = await User.findById(req.user.id);
    const pinCheck = await verifyWalletPin(sender, pin);
    if (!pinCheck.ok) {
      return res.status(400).json({ error: pinCheck.error });
    }
    const recipient = await User.findOne({ email: recipientEmail });
    if (!recipient) return res.status(404).json({ error: "No TechMart user found with that email" });
    if (sender.email === recipientEmail) return res.status(400).json({ error: "You cannot send money to yourself" });
    if ((sender.walletBalance || 0) < Number(amount)) return res.status(400).json({ error: "Insufficient wallet balance" });
    const transferLimit = checkDailyLimit(sender, "transfer", amount);
    if (!transferLimit.ok) return res.status(400).json({ error: transferLimit.error });

    const reference = "TXF-" + Date.now();
    sender.dailyTransferTotal = transferLimit.total + Number(amount);
    sender.dailyTransferDate = transferLimit.today;

    // Debit sender
    sender.walletBalance = (sender.walletBalance || 0) - Number(amount);
    sender.walletTransactions.push({
      type: "debit",
      amount: Number(amount),
      description: `Transfer to ${recipient.name} (${recipientEmail})${note ? " — " + note : ""}`,
      reference
    });
    await sender.save();

    // Credit recipient
    recipient.walletBalance = (recipient.walletBalance || 0) + Number(amount);
    recipient.walletTransactions.push({
      type: "credit",
      amount: Number(amount),
      description: `Transfer from ${sender.name}${note ? " — " + note : ""}`,
      reference
    });
    await recipient.save();

    analyzeFraud(sender, "wallet_transfer", { recipientEmail, amount, reference }).catch(() => {});
    res.json({ success: true, reference, message: `N${Number(amount).toLocaleString()} sent to ${recipient.name}` });
  } catch (err) {
    console.error("Transfer error:", err.message);
    res.status(500).json({ error: "Transfer failed" });
  }
});


// Idempotency records are committed atomically with wallet split transactions.
const walletSplitRequestSchema = new mongoose.Schema({
  senderId: { type: String, required: true },
  idempotencyKey: { type: String, required: true },
  fingerprint: { type: String, required: true },
  result: { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now }
});
walletSplitRequestSchema.index(
  { senderId: 1, idempotencyKey: 1 },
  { unique: true }
);
const WalletSplitRequest = mongoose.models.WalletSplitRequest ||
  mongoose.model("WalletSplitRequest", walletSplitRequestSchema);

// Atomic wallet split: all recipient credits and sender debit commit together.
app.post("/api/pay/split", auth, pinLimiter, async (req, res) => {
  let session;
  let idempotencyKey;
  let requestFingerprint;

  try {
    const { amount, recipients, pin } = req.body || {};
    const total = Number(amount);

    if (!Number.isSafeInteger(total) || total <= 0) {
      return res.status(400).json({ error: "Enter a valid whole-naira split amount" });
    }

    if (!Array.isArray(recipients) || recipients.length < 2 || recipients.length > 10) {
      return res.status(400).json({ error: "A split must have between 2 and 10 recipients" });
    }

    const emails = recipients.map(value =>
      typeof value === "string" ? value.trim().toLowerCase() : ""
    );

    if (emails.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return res.status(400).json({ error: "One or more recipient email addresses are invalid" });
    }

    if (new Set(emails).size !== emails.length) {
      return res.status(400).json({ error: "Each recipient must be unique" });
    }

    if (total < emails.length * 100) {
      return res.status(400).json({
        error: `The total must be at least ₦${(emails.length * 100).toLocaleString()} for these recipients`
      });
    }

    idempotencyKey = String(req.get("Idempotency-Key") || "").trim();
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      return res.status(400).json({
        error: "A valid Idempotency-Key is required. Please retry from the chatbot."
      });
    }

    requestFingerprint = crypto.createHash("sha256")
      .update(JSON.stringify({ total, emails }))
      .digest("hex");

    await WalletSplitRequest.init();

    const previousRequest = await WalletSplitRequest.findOne({
      senderId: String(req.user.id),
      idempotencyKey
    }).lean();

    if (previousRequest) {
      if (previousRequest.fingerprint !== requestFingerprint) {
        return res.status(409).json({
          error: "This request key was already used for a different split. Start a new split."
        });
      }
      return res.json(previousRequest.result);
    }

    session = await mongoose.startSession();
    let result;

    await session.withTransaction(async () => {
      const sender = await User.findById(req.user.id).session(session);
      if (!sender) {
        const error = new Error("User account not found");
        error.statusCode = 404;
        throw error;
      }

      const pinCheck = await verifyWalletPin(sender, pin);
      if (!pinCheck.ok) {
        const error = new Error(pinCheck.error);
        error.statusCode = 400;
        throw error;
      }

      const senderEmail = String(sender.email || "").trim().toLowerCase();
      if (emails.includes(senderEmail)) {
        const error = new Error("You cannot include your own email in a wallet split");
        error.statusCode = 400;
        throw error;
      }

      const recipientUsers = await User.find({ email: { $in: emails } }).session(session);
      const recipientByEmail = new Map(
        recipientUsers.map(user => [String(user.email || "").trim().toLowerCase(), user])
      );

      const missing = emails.filter(email => !recipientByEmail.has(email));
      if (missing.length) {
        const error = new Error(`No TechMart account found for: ${missing.join(", ")}`);
        error.statusCode = 404;
        throw error;
      }

      if ((sender.walletBalance || 0) < total) {
        const error = new Error("Insufficient wallet balance for the full split");
        error.statusCode = 400;
        throw error;
      }

      const limit = checkDailyLimit(sender, "transfer", total);
      if (!limit.ok) {
        const error = new Error(limit.error);
        error.statusCode = 400;
        throw error;
      }

      const reference =
        `SPLIT-${Date.now()}-${require("crypto").randomBytes(4).toString("hex")}`;
      const baseShare = Math.floor(total / emails.length);
      const remainder = total % emails.length;
      const shares = emails.map((_, index) => baseShare + (index < remainder ? 1 : 0));

      sender.walletBalance = (sender.walletBalance || 0) - total;
      sender.dailyTransferTotal = limit.total + total;
      sender.dailyTransferDate = limit.today;
      sender.walletTransactions.push({
        type: "debit",
        amount: total,
        description: `Wallet split to ${emails.length} recipients`,
        reference,
        meta: { kind: "wallet_split", recipients: emails }
      });

      await sender.save({ session });

      for (let index = 0; index < emails.length; index++) {
        const email = emails[index];
        const recipient = recipientByEmail.get(email);
        const share = shares[index];

        recipient.walletBalance = (recipient.walletBalance || 0) + share;
        recipient.walletTransactions.push({
          type: "credit",
          amount: share,
          description: `Wallet split received from ${sender.name || senderEmail}`,
          reference,
          meta: { kind: "wallet_split", senderId: String(sender._id), recipientIndex: index + 1 }
        });

        await recipient.save({ session });
      }

      result = {
        success: true,
        reference,
        total,
        recipients: emails.map((email, index) => ({ email, amount: shares[index] })),
        message: `₦${total.toLocaleString()} split successfully among ${emails.length} recipients`
      };

      await WalletSplitRequest.create([{
        senderId: String(req.user.id),
        idempotencyKey,
        fingerprint: requestFingerprint,
        result
      }], { session });
    });

    if (!result) {
      return res.status(500).json({ error: "The split could not be confirmed. Please check your wallet before retrying." });
    }

    res.json(result);
    // Fraud analytics run after the transaction commits; they cannot cause a partial split.
    User.findById(req.user.id)
      .then(sender => sender && analyzeFraud(sender, "wallet_split", {
        reference: result.reference,
        amount: result.total,
        recipients: result.recipients.map(item => item.email)
      }).catch(() => {}))
      .catch(() => {});
  } catch (err) {
    if (idempotencyKey && requestFingerprint) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const committed = await WalletSplitRequest.findOne({
            senderId: String(req.user.id),
            idempotencyKey
          }).lean();

          if (committed) {
            if (committed.fingerprint !== requestFingerprint) {
              return res.status(409).json({
                error: "This request key was already used for a different split."
              });
            }
            return res.json(committed.result);
          }
        } catch (lookupError) {
          console.error("Wallet split idempotency lookup failed:", lookupError.message);
          break;
        }

        if (attempt < 4) {
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
    }

    console.error("Wallet split error:", err.message);
    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "The split failed and was rolled back if the transaction had started"
    });
  } finally {
    if (session) await session.endSession().catch(() => {});
  }
});

// 3. Withdraw to Bank Account
// NIN Verification
app.post("/api/pay/verify-nin", auth, async (req, res) => {
  try {
    const { nin } = req.body;
    if (!nin || nin.length !== 11) return res.status(400).json({ error: "Enter a valid 11-digit NIN" });
    const user = await User.findById(req.user.id);
    if (user.ninVerified || user.bvnVerified) return res.status(400).json({ error: "Identity already verified" });

    const response = await axios.get(
      `https://api.paystack.co/bank/resolve_nin/${nin}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    const ninData = response.data.data;
    const userName = user.name.toLowerCase();
    const ninFirst = (ninData.first_name || "").toLowerCase();
    const ninLast = (ninData.last_name || "").toLowerCase();

    if (!userName.includes(ninFirst) && !userName.includes(ninLast)) {
      return res.status(400).json({ error: "NIN details do not match your account name" });
    }

    user.ninVerified = true;
    await user.save();

    res.json({ success: true, message: "NIN verified successfully! Your transaction limits have been upgraded." });
  } catch (err) {
    console.error("NIN verification error:", err.response?.data || err.message);
    res.status(500).json({ error: "NIN verification failed. Please try again." });
  }
});

// Daily limit checker helper
function checkDailyLimit(user, type, amount) {
  const today = new Date().toISOString().slice(0, 10);
  const isVerified = user.bvnVerified || user.ninVerified;
  const fundingLimit = isVerified ? 500000 : 50000;
  const transferLimit = isVerified ? 200000 : 20000;

  if (type === "funding") {
    const sameDay = user.dailyFundingDate === today;
    const total = sameDay ? (user.dailyFundingTotal || 0) : 0;
    if (total + Number(amount) > fundingLimit) {
      return { ok: false, error: `Daily funding limit is ₦${fundingLimit.toLocaleString()}. ${!isVerified ? "Verify your BVN to increase limits." : ""}` };
    }
    return { ok: true, total, today };
  }

  if (type === "transfer") {
    const sameDay = user.dailyTransferDate === today;
    const total = sameDay ? (user.dailyTransferTotal || 0) : 0;
    if (total + Number(amount) > transferLimit) {
      return { ok: false, error: `Daily transfer limit is ₦${transferLimit.toLocaleString()}. ${!isVerified ? "Verify your BVN to increase limits." : ""}` };
    }
    return { ok: true, total, today };
  }
}

// 🏦 Create Savings Vault
app.post("/api/pay/vault/lock", auth, pinLimiter, async (req, res) => {
  let session;

  try {
    const { amount, lockDays, pin } = req.body || {};
    const depositAmount = Number(amount);
    const days = Number(lockDays);

    if (!Number.isSafeInteger(depositAmount) || depositAmount < 1000) {
      return res.status(400).json({ error: "Minimum savings amount is ₦1,000" });
    }

    if (![7, 30, 90].includes(days)) {
      return res.status(400).json({ error: "Choose 7, 30, or 90 days" });
    }

    session = await mongoose.startSession();
    let vault;
    let reference;

    await session.withTransaction(async () => {
      const user = await User.findById(req.user.id).session(session);

      if (!user) {
        const error = new Error("User account not found");
        error.statusCode = 404;
        throw error;
      }

      const pinCheck = await verifyWalletPin(user, pin);
      if (!pinCheck.ok) {
        const error = new Error(pinCheck.error);
        error.statusCode = 400;
        throw error;
      }

      if ((user.walletBalance || 0) < depositAmount) {
        const error = new Error("Insufficient wallet balance");
        error.statusCode = 400;
        throw error;
      }

      const monthlyRate = 0.05;
      const dailyRate = monthlyRate / 30;
      const expectedInterest = Math.floor(depositAmount * dailyRate * days);
      const maturityDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

      reference = "VAULT-" + Date.now() + "-" +
        require("crypto").randomBytes(4).toString("hex");

      user.walletBalance = (user.walletBalance || 0) - depositAmount;
      user.walletTransactions.push({
        type: "debit",
        amount: depositAmount,
        description: `Locked ₦${depositAmount.toLocaleString()} in Savings Vault for ${days} days`,
        reference
      });

      await user.save({ session });

      const created = await SavingsVault.create([{
        userId: String(req.user.id),
        amount: depositAmount,
        lockDays: days,
        expectedInterest,
        maturityDate
      }], { session });

      vault = created[0];
    });

    if (!vault) {
      return res.status(500).json({
        error: "The savings deposit could not be confirmed. Please check your wallet before retrying."
      });
    }

    try {
      await updateNetworkScore(req.user.id, 50, {
        savingsBalance: depositAmount
      });
    } catch (scoreError) {
      console.error("Vault network score update failed:", scoreError.message);
    }

    res.json({
      success: true,
      vault,
      message: `₦${depositAmount.toLocaleString()} locked for ${days} days. You'll earn ₦${vault.expectedInterest.toLocaleString()} interest!`
    });
  } catch (err) {
    console.error("Savings Vault deposit error:", err.message);
    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to create savings vault. No partial wallet debit should remain."
    });
  } finally {
    if (session) await session.endSession().catch(() => {});
  }
});

// 🏦 Get My Vaults
app.get("/api/pay/vault", auth, async (req, res) => {
  try {
    const vaults = await SavingsVault.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(vaults);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch vaults" });
  }
});

// 🏦 Withdraw Matured Vault
app.post("/api/pay/vault/:vaultId/withdraw", auth, async (req, res) => {
  let session;

  try {
    session = await mongoose.startSession();

    let result;

    await session.withTransaction(async () => {
      const now = new Date();
      const userId = String(req.user.id);

      const vault = await SavingsVault.findById(req.params.vaultId).session(session);

      if (!vault) {
        const error = new Error("Vault not found");
        error.statusCode = 404;
        throw error;
      }

      if (String(vault.userId) !== userId) {
        const error = new Error("Not your vault");
        error.statusCode = 403;
        throw error;
      }

      if (vault.status !== "active") {
        const error = new Error("Vault has already been withdrawn or is no longer active");
        error.statusCode = 400;
        throw error;
      }

      if (now < new Date(vault.maturityDate)) {
        const daysLeft = Math.ceil(
          (new Date(vault.maturityDate) - now) / (1000 * 60 * 60 * 24)
        );
        const error = new Error(
          `Vault matures in ${daysLeft} day(s). Early withdrawal not allowed.`
        );
        error.statusCode = 400;
        throw error;
      }

      const amount = Number(vault.amount);
      const interest = Number(vault.expectedInterest);
      const total = amount + interest;

      if (
        !Number.isSafeInteger(amount) ||
        !Number.isSafeInteger(interest) ||
        !Number.isSafeInteger(total) ||
        amount <= 0 ||
        interest < 0
      ) {
        const error = new Error("Vault contains an invalid balance and requires review");
        error.statusCode = 400;
        throw error;
      }

      // Claim the matured Vault exactly once inside the transaction.
      const claimedVault = await SavingsVault.findOneAndUpdate(
        {
          _id: vault._id,
          userId,
          status: "active",
          maturityDate: { $lte: now }
        },
        {
          $set: {
            status: "withdrawn",
            interestCredited: true
          }
        },
        { new: true, session }
      );

      if (!claimedVault) {
        const error = new Error("This Vault has already been processed. Please refresh your Vault list.");
        error.statusCode = 409;
        throw error;
      }

      const user = await User.findById(userId).session(session);

      if (!user) {
        const error = new Error("User account not found");
        error.statusCode = 404;
        throw error;
      }

      const reference = "VAULT-OUT-" + Date.now() + "-" +
        require("crypto").randomBytes(4).toString("hex");

      user.walletBalance = (user.walletBalance || 0) + total;
      user.walletTransactions.push({
        type: "credit",
        amount: total,
        description: `Savings Vault matured — ₦${amount.toLocaleString()} + ₦${interest.toLocaleString()} interest`,
        reference
      });

      await user.save({ session });

      result = {
        amount,
        interest,
        total
      };
    });

    if (!result) {
      return res.status(500).json({
        error: "Withdrawal could not be confirmed. Please refresh your wallet and Vault list before retrying."
      });
    }

    return res.json({
      success: true,
      message: `₦${result.total.toLocaleString()} credited to your wallet (including ₦${result.interest.toLocaleString()} interest)!`
    });
  } catch (err) {
    console.error("Savings Vault withdrawal error:", err.message);

    return res.status(err.statusCode || 500).json({
      error: err.statusCode
        ? err.message
        : "Withdrawal could not be confirmed. Please check your wallet and Vault status before retrying."
    });
  } finally {
    if (session) await session.endSession().catch(() => {});
  }
});

// 🎯 Get Loyalty Points
app.get("/api/pay/loyalty", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("loyaltyPoints totalPointsEarned name");
    const pointsValue = Math.floor((user.loyaltyPoints || 0) / 100) * 500;
    res.json({
      points: user.loyaltyPoints || 0,
      totalEarned: user.totalPointsEarned || 0,
      walletValue: pointsValue,
      nextReward: 100 - ((user.loyaltyPoints || 0) % 100)
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch loyalty points" });
  }
});

// 🎯 Redeem Loyalty Points
app.post("/api/pay/loyalty/redeem", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if ((user.loyaltyPoints || 0) < 100) return res.status(400).json({ error: "You need at least 100 points to redeem (worth ₦500)" });

    const redeemable = Math.floor(user.loyaltyPoints / 100);
    const creditAmount = redeemable * 500;
    user.loyaltyPoints = user.loyaltyPoints % 100;
    user.walletBalance = (user.walletBalance || 0) + creditAmount;
    user.walletTransactions.push({
      type: "credit",
      amount: creditAmount,
      description: `Loyalty points redeemed — ${redeemable * 100} points = ₦${creditAmount.toLocaleString()}`,
      reference: "LOYALTY-" + Date.now()
    });
    await user.save();

    // Update network score for loyalty redemption
    try { await updateNetworkScore(req.user.id, 25, { loyaltyEarned: creditAmount }); } catch {}
    res.json({ success: true, message: `₦${creditAmount.toLocaleString()} credited to your wallet from loyalty points!`, remaining: user.loyaltyPoints });
  } catch (err) {
    res.status(500).json({ error: "Failed to redeem loyalty points" });
  }
});

// 💳 Spend Insights
app.get("/api/pay/insights", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("walletTransactions monthlyBudget name");
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

    const txs = user.walletTransactions || [];
    const debits = txs.filter(t => t.type === "debit");

    // This month spending
    const thisMonthTxs = debits.filter(t => new Date(t.createdAt) >= startOfMonth);
    const thisMonthTotal = thisMonthTxs.reduce((s, t) => s + t.amount, 0);

    // Last month spending
    const lastMonthTxs = debits.filter(t => new Date(t.createdAt) >= startOfLastMonth && new Date(t.createdAt) <= endOfLastMonth);
    const lastMonthTotal = lastMonthTxs.reduce((s, t) => s + t.amount, 0);

    // Category breakdown from descriptions
    const categories = {};
    thisMonthTxs.forEach(t => {
      const desc = (t.description || "").toLowerCase();
      let cat = "Other";
      if (desc.includes("order") || desc.includes("escrow")) cat = "Shopping";
      else if (desc.includes("airtime")) cat = "Airtime";
      else if (desc.includes("data")) cat = "Data";
      else if (desc.includes("electricity")) cat = "Electricity";
      else if (desc.includes("cable") || desc.includes("tv")) cat = "Cable TV";
      else if (desc.includes("transfer")) cat = "Transfers";
      else if (desc.includes("withdrawal")) cat = "Withdrawal";
      categories[cat] = (categories[cat] || 0) + t.amount;
    });

    // Monthly trend (last 6 months)
    const monthlyTrend = [];
    for (let i = 5; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const total = debits.filter(t => new Date(t.createdAt) >= start && new Date(t.createdAt) <= end).reduce((s, t) => s + t.amount, 0);
      monthlyTrend.push({ month: start.toLocaleString("en-NG", { month: "short", year: "numeric" }), total });
    }

    // Budget progress
    const budget = user.monthlyBudget || 0;
    const budgetProgress = budget > 0 ? Math.min((thisMonthTotal / budget) * 100, 100) : 0;
    const budgetAlert = budget > 0 && thisMonthTotal >= budget * 0.8;

    res.json({
      thisMonth: thisMonthTotal,
      lastMonth: lastMonthTotal,
      change: lastMonthTotal > 0 ? Math.round(((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100) : 0,
      categories,
      monthlyTrend,
      budget,
      budgetProgress: Math.round(budgetProgress),
      budgetAlert,
      topCategory: Object.entries(categories).sort((a, b) => b[1] - a[1])[0]?.[0] || "None"
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch insights" });
  }
});

// 💳 Set Monthly Budget
app.post("/api/pay/budget", auth, async (req, res) => {
  try {
    const { budget } = req.body;
    if (!budget || Number(budget) < 0) return res.status(400).json({ error: "Invalid budget amount" });
    await User.findByIdAndUpdate(req.user.id, { monthlyBudget: Number(budget), budgetAlertSent: false });
    res.json({ success: true, message: `Monthly budget set to ₦${Number(budget).toLocaleString()}` });
  } catch (err) {
    res.status(500).json({ error: "Failed to set budget" });
  }
});

// 📈 Price History
app.get("/api/products/:id/price-history", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).select("name price priceHistory");
    if (!product) return res.status(404).json({ error: "Product not found" });
    const history = [...(product.priceHistory || []), { price: product.price, recordedAt: new Date() }];
    res.json({ name: product.name, currentPrice: product.price, history });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch price history" });
  }
});

// 💳 Check BNPL Eligibility
app.get("/api/bnpl/eligibility", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("email name");
    const completedOrders = await Order.countDocuments({ email: user.email, status: "Delivered" });
    const activePlans = await BNPLPlan.countDocuments({ userId: req.user.id, status: "active" });
    const eligible = completedOrders >= 3;
    res.json({
      eligible,
      completedOrders,
      activePlans,
      reason: !eligible ? `You need ${3 - completedOrders} more completed order(s) to unlock Buy Now Pay Later` : null
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to check eligibility" });
  }
});

// 💳 Get My BNPL Plans
app.get("/api/bnpl/plans", auth, async (req, res) => {
  try {
    const plans = await BNPLPlan.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(plans);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch BNPL plans" });
  }
});

// 🤖 AI Pro — Check Status
app.get("/api/ai/pro/status", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("aiPro aiProExpiry aiDailyUsage aiUsageDate name");
    const today = new Date().toISOString().slice(0, 10);
    const isProActive = user.aiPro && user.aiProExpiry && new Date(user.aiProExpiry) > new Date();
    const dailyUsage = user.aiUsageDate === today ? (user.aiDailyUsage || 0) : 0;
    const limit = isProActive ? 999 : AI_FREE_DAILY_LIMIT;
    res.json({ isPro: isProActive, expiresAt: user.aiProExpiry, dailyUsage, limit, remaining: Math.max(0, limit - dailyUsage) });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch AI status" });
  }
});

// 🤖 AI Pro — Upgrade (₦2,000/month from wallet)
app.post("/api/ai/pro/upgrade", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if ((user.walletBalance || 0) < 2000) return res.status(400).json({ error: "Insufficient wallet balance. AI Pro costs ₦2,000/month." });

    user.walletBalance -= 2000;
    user.walletTransactions.push({
      type: "debit", amount: 2000,
      description: "TechMart AI Pro subscription — 1 month",
      reference: "AIPRO-" + Date.now()
    });

    const now = new Date();
    const currentExpiry = user.aiProExpiry && new Date(user.aiProExpiry) > now ? new Date(user.aiProExpiry) : now;
    user.aiPro = true;
    user.aiProExpiry = new Date(currentExpiry.getTime() + 30 * 24 * 60 * 60 * 1000);
    await user.save();

    res.json({ success: true, expiresAt: user.aiProExpiry, message: `🤖 AI Pro activated until ${user.aiProExpiry.toLocaleDateString("en-NG")}!` });
  } catch (err) {
    res.status(500).json({ error: "Failed to upgrade to AI Pro" });
  }
});

// 🤖 Track AI Usage
// Free AI messages per day (AI Pro is unlimited)
const AI_FREE_DAILY_LIMIT = 15;
const { scrubOrderClaims } = require("./utils/orderClaims");

app.post("/api/ai/track-usage", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("aiPro aiProExpiry aiDailyUsage aiUsageDate");
    const today = new Date().toISOString().slice(0, 10);
    const isProActive = user.aiPro && user.aiProExpiry && new Date(user.aiProExpiry) > new Date();
    const dailyUsage = user.aiUsageDate === today ? (user.aiDailyUsage || 0) : 0;
    const limit = isProActive ? 999 : AI_FREE_DAILY_LIMIT;

    if (dailyUsage >= limit) return res.status(429).json({ error: isProActive ? "Daily limit reached" : "Daily limit reached. Upgrade to AI Pro for unlimited messages!", limitReached: true, isPro: isProActive });

    await User.findByIdAndUpdate(req.user.id, {
      aiDailyUsage: user.aiUsageDate === today ? (user.aiDailyUsage || 0) + 1 : 1,
      aiUsageDate: today
    });

    res.json({ success: true, usage: dailyUsage + 1, limit, remaining: limit - dailyUsage - 1 });
  } catch (err) {
    res.status(500).json({ error: "Failed to track usage" });
  }
});

// 📢 Sponsored Listings — Create
app.post("/api/sponsored/create", sellerAuth, async (req, res) => {
  try {
    const { productId } = req.body;
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ error: "Product not found" });
    if (product.vendorId !== req.seller.id) return res.status(403).json({ error: "Not your product" });

    const seller = await Seller.findById(req.seller.id);
    if ((seller.walletBalance || 0) < 2000) return res.status(400).json({ error: "Insufficient seller wallet balance. Sponsoring costs ₦2,000/week." });

    // Check if already sponsored
    const existing = await SponsoredListing.findOne({ productId, status: "active" });
    if (existing) return res.status(400).json({ error: "This product is already sponsored" });

    seller.walletBalance -= 2000;
    seller.walletTransactions = seller.walletTransactions || [];
    seller.walletTransactions.push({
      type: "debit", amount: 2000,
      description: `Sponsored listing — ${product.name}`,
      reference: "SPON-" + Date.now()
    });
    await seller.save();

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const listing = await SponsoredListing.create({ sellerId: req.seller.id, productId, productName: product.name, expiresAt });

    res.json({ success: true, listing, message: `✅ ${product.name} is now sponsored for 7 days!` });
  } catch (err) {
    res.status(500).json({ error: "Failed to create sponsored listing" });
  }
});

// 📢 Get Active Sponsored Products (for AI search)
app.get("/api/sponsored/active", async (req, res) => {
  try {
    const sponsored = await SponsoredListing.find({ status: "active", expiresAt: { $gt: new Date() } }).select("productId impressions clicks");
    const productIds = sponsored.map(s => s.productId);
    const products = await Product.find({ _id: { $in: productIds } });
    res.json(products.map(p => ({ ...p.toObject(), isSponsored: true })));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sponsored listings" });
  }
});

// 📢 My Sponsored Listings (seller)
app.get("/api/sponsored/mine", sellerAuth, async (req, res) => {
  try {
    const listings = await SponsoredListing.find({ sellerId: req.seller.id }).sort({ createdAt: -1 });
    res.json(listings);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sponsored listings" });
  }
});

// 🚨 Report a Product
app.post("/api/products/:id/report", auth, async (req, res) => {
  try {
    const { reason, details } = req.body;
    if (!reason) return res.status(400).json({ error: "Please select a reason" });
    const product = await Product.findById(req.params.id).select("name");
    if (!product) return res.status(404).json({ error: "Product not found" });
    const user = await User.findById(req.user.id).select("email");

    await ProductReport.create({
      productId: req.params.id,
      productName: product.name,
      reportedBy: req.user.id,
      reporterEmail: user.email,
      reason, details: details || ""
    });

    res.json({ success: true, message: "Report submitted. Our team will review it within 24 hours." });
  } catch (err) {
    res.status(500).json({ error: "Failed to submit report" });
  }
});

// 🚨 Get Product Reports (Admin)
app.get("/api/admin/reports", adminOnly, async (req, res) => {
  try {
    const reports = await ProductReport.find().sort({ createdAt: -1 }).limit(100);
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch reports" });
  }
});

// 🚨 Update Report Status (Admin)
app.put("/api/admin/reports/:id", adminOnly, async (req, res) => {
  try {
    const report = await ProductReport.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ error: "Failed to update report" });
  }
});

// ⏱ Get Seller Response Time
app.get("/api/seller/:sellerId/response-time", async (req, res) => {
  try {
    const seller = await Seller.findById(req.params.sellerId).select("name avgResponseTime verified");
    if (!seller) return res.status(404).json({ error: "Seller not found" });

    let responseLabel = "New seller";
    const hrs = Number(seller.avgResponseTime);

    if (Number.isFinite(hrs) && hrs >= 0) {
      if (hrs < 1) {
        responseLabel = "Usually replies in < 1 hour";
      } else if (hrs < 24) {
        responseLabel = `Usually replies in ${Math.round(hrs)} hours`;
      } else {
        responseLabel = `Usually replies in ${Math.round(hrs / 24)} day(s)`;
      }
    }

    res.json({
      sellerId: req.params.sellerId,
      name: seller.name,
      avgResponseTime: Number.isFinite(hrs) ? hrs : null,
      responseLabel,
      verified: seller.verified
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch response time" });
  }
});

// ⏱ Update Seller Response Time (called when seller replies to message)
async function updateSellerResponseTime(sellerId) {
  try {
    const seller = await Seller.findById(sellerId);
    if (!seller || !seller.lastMessageAt) return;
    const now = new Date();
    const responseHours = (now - new Date(seller.lastMessageAt)) / (1000 * 60 * 60);
    const current = seller.avgResponseTime;
    seller.avgResponseTime = current ? (current * 0.7 + responseHours * 0.3) : responseHours;
    seller.lastResponseAt = now;
    await seller.save();
  } catch (e) {
    console.error("Response time update error:", e.message);
  }
}

// 🎁 Purchase Gift Card
app.post("/api/giftcard/purchase", auth, async (req, res) => {
  return res.status(503).json({
    success: false,
    error: "Gift Card purchases are temporarily unavailable. Your wallet has not been charged."
  });
});

// 🎁 Redeem Gift Card
app.post("/api/giftcard/redeem", auth, async (req, res) => {
  return res.status(503).json({
    success: false,
    error: "Gift Card redemption is temporarily unavailable. No wallet credit was made."
  });
});

// 🎁 My Gift Cards
app.get("/api/giftcard/mine", auth, async (req, res) => {
  try {
    const cards = await GiftCard.find({ purchasedBy: req.user.id }).sort({ createdAt: -1 });
    res.json(cards);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch gift cards" });
  }
});

// 🔗 Create Payment Link
app.post("/api/paylink/create", auth, async (req, res) => {
  try {
    const { amount, description } = req.body;
    if (!amount || Number(amount) < 100) return res.status(400).json({ error: "Minimum payment link amount is ₦100" });

    const user = await User.findById(req.user.id);
    let linkId;
    let exists = true;
    while (exists) {
      linkId = generateLinkId();
      exists = await PaymentLink.findOne({ linkId });
    }

    const link = await PaymentLink.create({
      linkId, userId: req.user.id, userName: user.name, userEmail: user.email,
      amount: Number(amount), description: description || ""
    });

    const url = `${process.env.FRONTEND_URL || "https://techmart-frontend.onrender.com"}/pay/link/${linkId}`;
    res.json({ success: true, linkId, url, amount: Number(amount), message: "Payment link created! Share it to receive money." });
  } catch (err) {
    res.status(500).json({ error: "Failed to create payment link" });
  }
});

// 🔗 Get Payment Link Details (public)
app.get("/api/paylink/:linkId", async (req, res) => {
  try {
    const link = await PaymentLink.findOne({ linkId: req.params.linkId, active: true });
    if (!link) return res.status(404).json({ error: "Payment link not found or inactive" });
    res.json({ name: link.userName, amount: link.amount, description: link.description, linkId: link.linkId });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch payment link" });
  }
});

// 🔗 Pay via Payment Link (wallet)
app.post("/api/paylink/:linkId/pay", auth, async (req, res) => {
  try {
    const link = await PaymentLink.findOne({ linkId: req.params.linkId, active: true });
    if (!link) return res.status(404).json({ error: "Payment link not found" });

    const payer = await User.findById(req.user.id);
    if (payer.email === link.userEmail) return res.status(400).json({ error: "You cannot pay your own payment link" });
    if ((payer.walletBalance || 0) < link.amount) return res.status(400).json({ error: "Insufficient wallet balance" });

    // Deduct from payer
    payer.walletBalance -= link.amount;
    payer.walletTransactions.push({
      type: "debit", amount: link.amount,
      description: `Payment to ${link.userName} via payment link`,
      reference: "PL-" + Date.now()
    });
    await payer.save();

    // Credit to link owner
    const owner = await User.findById(link.userId);
    if (owner) {
      owner.walletBalance = (owner.walletBalance || 0) + link.amount;
      owner.walletTransactions.push({
        type: "credit", amount: link.amount,
        description: `Payment received from ${payer.name} via payment link`,
        reference: "PL-IN-" + Date.now()
      });
      await owner.save();
    }

    link.paidCount += 1;
    link.totalCollected += link.amount;
    await link.save();

    res.json({ success: true, message: `₦${link.amount.toLocaleString()} sent to ${link.userName}!` });
  } catch (err) {
    res.status(500).json({ error: "Failed to process payment" });
  }
});

// 🔗 My Payment Links
app.get("/api/paylink/mine/all", auth, async (req, res) => {
  try {
    const links = await PaymentLink.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(links);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch payment links" });
  }
});

// 🔥 Daily Deal — one random product with 20% discount per day
app.get("/api/daily-deal", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    // Use date as seed to pick consistent product for the day
    const products = await Product.find({ stock: { $gt: 0 } }).select("name price images category rating stock");
    if (!products.length) return res.json(null);

    // Seed based on date so same product shows all day
    const seed = today.split("-").reduce((a, b) => a + Number(b), 0);
    const index = seed % products.length;
    const product = products[index];

    const discount = 20; // 20% off
    const dealPrice = Math.round(product.price * (1 - discount / 100));
    const expiresAt = new Date();
    expiresAt.setHours(23, 59, 59, 999);

    res.json({ product, discount, dealPrice, originalPrice: product.price, expiresAt, today });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch daily deal" });
  }
});

// 🔍 SEO — Product meta tags for WhatsApp/Twitter sharing
app.get("/api/seo/product/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).select("name description price images category rating");
    if (!product) return res.status(404).json({ error: "Product not found" });

    const image = product.images?.[0] || "https://techmart-frontend.onrender.com/techmart.png";
    const title = `${product.name} — ₦${product.price?.toLocaleString()} | TechMart`;
    const description = product.description
      ? product.description.slice(0, 160)
      : `Buy ${product.name} on TechMart for ₦${product.price?.toLocaleString()}. Secure payment, buyer protection & fast delivery.`;
    const url = `${process.env.FRONTEND_URL || "https://techmart-frontend.onrender.com"}/product/${product._id}`;

    // Return HTML with proper OG tags for crawlers
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <meta name="description" content="${description}" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${image}" />
  <meta property="og:image:width" content="800" />
  <meta property="og:image:height" content="800" />
  <meta property="og:url" content="${url}" />
  <meta property="og:type" content="product" />
  <meta property="og:site_name" content="TechMart" />
  <meta property="product:price:amount" content="${product.price}" />
  <meta property="product:price:currency" content="NGN" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${image}" />
  <script>window.location.href = "${url}";</script>
</head>
<body>
  <p>Redirecting to <a href="${url}">${title}</a>...</p>
</body>
</html>`);
  } catch (err) {
    res.status(500).send("Error generating SEO page");
  }
});

// 🔍 SEO — Homepage meta
app.get("/api/seo/home", async (req, res) => {
  try {
    const productCount = await Product.countDocuments();
    const frontendUrl = process.env.FRONTEND_URL || "https://techmart-frontend.onrender.com";
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>TechMart — Nigeria's Trusted Tech Marketplace</title>
  <meta name="description" content="Shop ${productCount}+ phones, laptops, accessories on TechMart. Secure payments, buyer protection, TechMart Pay & fast delivery across Nigeria." />
  <meta property="og:title" content="TechMart — Nigeria's Trusted Tech Marketplace" />
  <meta property="og:description" content="Shop ${productCount}+ tech products. Secure escrow payments, 7-day returns, buyer protection." />
  <meta property="og:image" content="${frontendUrl}/techmart.png" />
  <meta property="og:url" content="${frontendUrl}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <script>window.location.href = "${frontendUrl}";</script>
</head>
<body><p>Redirecting to <a href="${frontendUrl}">TechMart</a>...</p></body>
</html>`);
  } catch (err) {
    res.status(500).send("Error");
  }
});

// 🎯 Referral Dashboard
app.get("/api/referral/stats", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("name referralCode referralCount referralCredits walletBalance");
    const frontendUrl = process.env.FRONTEND_URL || "https://techmart-frontend.onrender.com";
    const referralLink = `${frontendUrl}/signup?ref=${user.referralCode}`;

    // Get referred users
    const referredUsers = await User.find({ referredBy: user.referralCode }).select("name createdAt").sort({ createdAt: -1 }).limit(20);

    res.json({
      referralCode: user.referralCode,
      referralLink,
      referralCount: user.referralCount || 0,
      referralCredits: user.referralCredits || 0,
      totalEarned: (user.referralCount || 0) * 500,
      referredUsers: referredUsers.map(u => ({ name: u.name, joinedAt: u.createdAt }))
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch referral stats" });
  }
});

// Public Pay Profile
app.get("/api/pay/profile/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select("name email bvnVerified ninVerified createdAt");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({
      name: user.name,
      email: user.email,
      bvnVerified: user.bvnVerified || false,
      ninVerified: user.ninVerified || false,
      memberSince: user.createdAt
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// 🧠 Track Behavior Event
app.post("/api/behavior/track", async (req, res) => {
  try {
    const { type, productId, productName, category, searchQuery, price, metadata, sessionId, city } = req.body;
    if (!type) return res.status(400).json({ error: "Event type required" });

    // Get userId from token if available
    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userId = decoded.id;
      } catch {}
    }

    await BehaviorEvent.create({
      userId,
      sessionId,
      type,
      productId,
      productName,
      category,
      searchQuery,
      price,
      metadata,
      city: city || "Lagos"
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to track event" });
  }
});

// 🧠 Get Demand Heatmap (trending products)
// Public trending endpoint for homepage
app.get("/api/behavior/heatmap/public", async (req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const trending = await BehaviorEvent.aggregate([
      { $match: { createdAt: { $gte: since }, productId: { $ne: null }, type: { $in: ["view", "add_to_cart", "purchase"] } } },
      { $group: {
        _id: "$productId",
        productName: { $first: "$productName" },
        score: { $sum: { $switch: { branches: [
          { case: { $eq: ["$type", "purchase"] }, then: 10 },
          { case: { $eq: ["$type", "add_to_cart"] }, then: 3 },
          { case: { $eq: ["$type", "view"] }, then: 1 }
        ], default: 0 } } }
      }},
      { $sort: { score: -1 } },
      { $limit: 10 }
    ]);
    res.json({ trending });
  } catch (err) {
    res.status(500).json({ trending: [] });
  }
});

app.get("/api/behavior/heatmap", adminOnly, async (req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7 days

    const trending = await BehaviorEvent.aggregate([
      { $match: { createdAt: { $gte: since }, productId: { $ne: null }, type: { $in: ["view", "add_to_cart", "purchase"] } } },
      { $group: {
        _id: "$productId",
        productName: { $first: "$productName" },
        category: { $first: "$category" },
        views: { $sum: { $cond: [{ $eq: ["$type", "view"] }, 1, 0] } },
        addToCarts: { $sum: { $cond: [{ $eq: ["$type", "add_to_cart"] }, 1, 0] } },
        purchases: { $sum: { $cond: [{ $eq: ["$type", "purchase"] }, 1, 0] } },
        score: { $sum: { $switch: { branches: [
          { case: { $eq: ["$type", "purchase"] }, then: 10 },
          { case: { $eq: ["$type", "add_to_cart"] }, then: 3 },
          { case: { $eq: ["$type", "view"] }, then: 1 }
        ], default: 0 } } }
      }},
      { $sort: { score: -1 } },
      { $limit: 20 }
    ]);

    const searches = await BehaviorEvent.aggregate([
      { $match: { createdAt: { $gte: since }, type: "search", searchQuery: { $ne: null } } },
      { $group: { _id: "$searchQuery", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    res.json({ trending, searches, since });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch heatmap" });
  }
});

// 🧠 Buyer Score
app.get("/api/behavior/buyer-score/:userId", adminOnly, async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).select("name email walletTransactions fraudScore isFlagged createdAt");
    if (!user) return res.status(404).json({ error: "User not found" });

    const orders = await Order.find({ email: user.email });
    const totalOrders = orders.length;
    const completedOrders = orders.filter(o => o.status === "Delivered").length;
    const cancelledOrders = orders.filter(o => o.status === "Cancelled").length;
    const disputes = await mongoose.connection.db.collection("disputes").countDocuments({ buyerEmail: user.email });

    const completionRate = totalOrders > 0 ? (completedOrders / totalOrders) * 100 : 0;
    const cancellationRate = totalOrders > 0 ? (cancelledOrders / totalOrders) * 100 : 0;
    const accountAge = Math.floor((Date.now() - new Date(user.createdAt)) / (1000 * 60 * 60 * 24));

    // Score calculation (0-100)
    let score = 50; // base
    score += Math.min(completionRate * 0.3, 30); // up to 30 pts for completion
    score -= Math.min(cancellationRate * 0.2, 20); // up to -20 for cancellations
    score -= Math.min(disputes * 5, 20); // up to -20 for disputes
    score += Math.min(accountAge / 30, 10); // up to 10 for account age
    score -= (user.fraudScore || 0) * 2; // fraud penalty
    score = Math.max(0, Math.min(100, Math.round(score)));

    const grade = score >= 80 ? "Excellent" : score >= 60 ? "Good" : score >= 40 ? "Fair" : "Poor";

    res.json({
      userId,
      name: user.name,
      email: user.email,
      score,
      grade,
      metrics: { totalOrders, completedOrders, cancelledOrders, completionRate: Math.round(completionRate), disputes, accountAgeDays: accountAge }
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to calculate buyer score" });
  }
});

// 🧠 Seller Performance Index
app.get("/api/behavior/seller-index/:sellerId", adminOnly, async (req, res) => {
  try {
    const { sellerId } = req.params;
    const seller = await Seller.findById(sellerId).select("name email createdAt verified");
    if (!seller) return res.status(404).json({ error: "Seller not found" });

    const orders = await Order.find({ "items.vendorId": sellerId });
    const totalOrders = orders.length;
    const fulfilledOrders = orders.filter(o => ["Shipped", "Delivered"].includes(o.status)).length;
    const cancelledOrders = orders.filter(o => o.status === "Cancelled").length;
    const disputes = await mongoose.connection.db.collection("disputes").countDocuments({ sellerId });

    const fulfillmentRate = totalOrders > 0 ? (fulfilledOrders / totalOrders) * 100 : 0;
    const disputeRate = totalOrders > 0 ? (disputes / totalOrders) * 100 : 0;

    let score = 50;
    score += Math.min(fulfillmentRate * 0.4, 40);
    score -= Math.min(disputeRate * 2, 30);
    score -= Math.min(cancelledOrders * 2, 20);
    score += seller.verified ? 10 : 0;
    score = Math.max(0, Math.min(100, Math.round(score)));

    const grade = score >= 80 ? "Top Seller" : score >= 60 ? "Good" : score >= 40 ? "Average" : "Needs Improvement";

    res.json({
      sellerId,
      name: seller.name,
      score,
      grade,
      metrics: { totalOrders, fulfilledOrders, cancelledOrders, fulfillmentRate: Math.round(fulfillmentRate), disputes, disputeRate: Math.round(disputeRate) }
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to calculate seller index" });
  }
});

// BVN Verification
app.post("/api/pay/verify-bvn", auth, async (req, res) => {
  try {
    const { bvn } = req.body;
    if (!bvn || bvn.length !== 11) return res.status(400).json({ error: "Enter a valid 11-digit BVN" });
    const user = await User.findById(req.user.id);
    if (user.bvnVerified) return res.status(400).json({ error: "BVN already verified" });

    // Paystack BVN verification
    const response = await axios.get(
      `https://api.paystack.co/bank/resolve_bvn/${bvn}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    const bvnData = response.data.data;
    // Match first name or last name against user name
    const userName = user.name.toLowerCase();
    const bvnFirst = (bvnData.first_name || "").toLowerCase();
    const bvnLast = (bvnData.last_name || "").toLowerCase();

    if (!userName.includes(bvnFirst) && !userName.includes(bvnLast)) {
      user.bvnLastAttempt = new Date();
      await user.save();
      return res.status(400).json({ error: "BVN details do not match your account name" });
    }

    user.bvnVerified = true;
    user.bvnLastAttempt = new Date();
    await user.save();

    res.json({ success: true, message: "BVN verified successfully! Your transaction limits have been upgraded." });
  } catch (err) {
    console.error("BVN verification error:", err.response?.data || err.message);
    res.status(500).json({ error: "BVN verification failed. Please try again." });
  }
});

app.post("/api/pay/withdraw", auth, pinLimiter, async (req, res) => {
  try {
    const { amount, bankCode, accountNumber, accountName, pin } = req.body;
    if (!amount || !bankCode || !accountNumber || !accountName) return res.status(400).json({ error: "All fields are required" });
    if (Number(amount) < 500) return res.status(400).json({ error: "Minimum withdrawal is N500" });

    const user = await User.findById(req.user.id);
    const pinCheck = await verifyWalletPin(user, pin);
    if (!pinCheck.ok) return res.status(400).json({ error: pinCheck.error });

    if ((user.walletBalance || 0) < Number(amount)) return res.status(400).json({ error: "Insufficient wallet balance" });

    const reference = "WTH-FLW-" + Date.now();
    const flwRes = await axios.post(
      "https://api.flutterwave.com/v3/transfers",
      { account_bank: bankCode, account_number: accountNumber, amount: Number(amount), currency: "NGN", reference, narration: `TechMart Pay — ${user.name}`, debit_currency: "NGN" },
      { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } }
    );
    if (flwRes.data.status !== "success") return res.status(400).json({ error: flwRes.data.message || "Transfer failed" });
    user.walletBalance = (user.walletBalance || 0) - Number(amount);
    user.walletTransactions.push({ type:"debit", amount:Number(amount), description:`Bank transfer to ${accountName} (${accountNumber})`, reference, channel:"withdrawal", status:"completed", meta:{ provider:"flutterwave", bankCode, accountNumber, accountName } });
    await user.save();
    res.json({ success:true, reference, message:`₦${Number(amount).toLocaleString()} is on its way to ${accountName}. Arrives in 1–2 minutes.` });
  } catch (err) {
    console.error("Withdrawal error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || "Withdrawal failed. Please try again." });
  }
});

// 4. Get Nigerian Banks List
app.get("/api/pay/banks", async (req, res) => {
  try {
    if (process.env.FLUTTERWAVE_SECRET_KEY) {
      const response = await axios.get("https://api.flutterwave.com/v3/banks/NG", { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } });
      return res.json((response.data.data || []).map(b => ({ name: b.name, code: b.code })));
    }
    const response = await axios.get("https://api.paystack.co/bank?currency=NGN&use_cursor=false", { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
    res.json(response.data.data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch banks" });
  }
});

// 5. Verify Bank Account
app.post("/api/pay/verify-account", auth, async (req, res) => {
  try {
    const { accountNumber, bankCode } = req.body;
    if (process.env.FLUTTERWAVE_SECRET_KEY) {
      const response = await axios.post("https://api.flutterwave.com/v3/accounts/resolve", { account_number: accountNumber, account_bank: bankCode }, { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } });
      return res.json({ success: true, accountName: response.data.data.account_name });
    }
    const response = await axios.get(`https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
    res.json({ success: true, accountName: response.data.data.account_name });
  } catch (err) {
    res.status(500).json({ error: "Could not verify account. Check the number and bank." });
  }
});

// 6. Bill Payments (Airtime via Paystack)
app.post("/api/pay/airtime", auth, pinLimiter, async (req, res) => {
  try {
    const { phone, amount, network, pin } = req.body;
    if (!phone || !amount || !network) return res.status(400).json({ error: "Phone, amount and network are required" });
    if (Number(amount) < 50) return res.status(400).json({ error: "Minimum airtime is N50" });
    const user = await User.findById(req.user.id);
    const pinCheck = await verifyWalletPin(user, pin);
    if (!pinCheck.ok) return res.status(400).json({ error: pinCheck.error });
    if ((user.walletBalance || 0) < Number(amount)) return res.status(400).json({ error: "Insufficient wallet balance" });

    // Network to Paystack provider code mapping
    const providerMap = { MTN: "MTN", Airtel: "AIR", Glo: "GLO", "9mobile": "ETISALAT" };
    const provider = providerMap[network];
    if (!provider) return res.status(400).json({ error: "Invalid network" });

    const reference = "AIR-" + Date.now();

    // Debit wallet first
    user.walletBalance = (user.walletBalance || 0) - Number(amount);
    user.walletTransactions.push({
      type: "debit",
      amount: Number(amount),
      description: `${network} airtime for ${phone}`,
      reference,
      status: "pending"
    });
    await user.save();

    // Clubkonnect not yet active — refund and block
    user.walletBalance = (user.walletBalance || 0) + Number(amount);
    user.walletTransactions.push({ type: "credit", amount: Number(amount), description: "Refund: airtime service coming soon", reference: reference + "-REFUND" });
    await user.save();
    return res.status(503).json({ error: "Airtime service is coming soon. Your wallet has not been charged." });
  } catch (err) {
    console.error("Airtime error:", err.response?.data || err.message);
    res.status(500).json({ error: "Airtime purchase failed" });
  }
});


// 8. Get Data Bundle Plans
app.get("/api/pay/data-plans/:network", auth, async (req, res) => {
  try {
    const { network } = req.params;
    const staticPlans = {
      MTN: [
        { id: "MTN-100MB-1D", name: "100MB - 1 Day", price: 100 },
        { id: "MTN-200MB-3D", name: "200MB - 3 Days", price: 200 },
        { id: "MTN-500MB-7D", name: "500MB - 7 Days", price: 300 },
        { id: "MTN-1GB-1M", name: "1GB - 30 Days", price: 300 },
        { id: "MTN-2GB-1M", name: "2GB - 30 Days", price: 500 },
        { id: "MTN-5GB-1M", name: "5GB - 30 Days", price: 1500 },
        { id: "MTN-10GB-1M", name: "10GB - 30 Days", price: 3000 },
        { id: "MTN-20GB-1M", name: "20GB - 30 Days", price: 5000 },
        { id: "MTN-50GB-1M", name: "50GB - 30 Days", price: 10000 },
      ],
      Airtel: [
        { id: "AIR-100MB-1D", name: "100MB - 1 Day", price: 100 },
        { id: "AIR-200MB-3D", name: "200MB - 3 Days", price: 200 },
        { id: "AIR-1GB-1M", name: "1GB - 30 Days", price: 300 },
        { id: "AIR-2GB-1M", name: "2GB - 30 Days", price: 500 },
        { id: "AIR-5GB-1M", name: "5GB - 30 Days", price: 1500 },
        { id: "AIR-10GB-1M", name: "10GB - 30 Days", price: 3000 },
        { id: "AIR-20GB-1M", name: "20GB - 30 Days", price: 5000 },
      ],
      Glo: [
        { id: "GLO-100MB-1D", name: "100MB - 1 Day", price: 50 },
        { id: "GLO-200MB-5D", name: "200MB - 5 Days", price: 100 },
        { id: "GLO-1GB-1M", name: "1GB - 30 Days", price: 300 },
        { id: "GLO-2GB-1M", name: "2GB - 30 Days", price: 500 },
        { id: "GLO-5GB-1M", name: "5GB - 30 Days", price: 1500 },
        { id: "GLO-10GB-1M", name: "10GB - 30 Days", price: 2500 },
        { id: "GLO-50GB-1M", name: "50GB - 30 Days", price: 8000 },
      ],
      "9mobile": [
        { id: "9MB-150MB-1D", name: "150MB - 1 Day", price: 100 },
        { id: "9MB-1GB-1M", name: "1GB - 30 Days", price: 300 },
        { id: "9MB-2GB-1M", name: "2GB - 30 Days", price: 500 },
        { id: "9MB-5GB-1M", name: "5GB - 30 Days", price: 1500 },
        { id: "9MB-10GB-1M", name: "10GB - 30 Days", price: 3000 },
      ]
    };
    const plans = staticPlans[network] || [];
    if (plans.length === 0) return res.status(400).json({ error: "Invalid network" });
    res.json({ success: true, plans });
  } catch (err) {
    console.error("Data plans error:", err.message);
    res.status(500).json({ error: "Failed to fetch data plans" });
  }
});
// 9. Purchase Data Bundle
app.post("/api/pay/data", auth, pinLimiter, async (req, res) => {
  try {
    const { phone, network, planId, amount, planName, pin } = req.body;
    if (!phone || !network || !planId || !amount) return res.status(400).json({ error: "Phone, network, plan and amount are required" });
    const user = await User.findById(req.user.id);
    const pinCheck = await verifyWalletPin(user, pin);
    if (!pinCheck.ok) return res.status(400).json({ error: pinCheck.error });
    if ((user.walletBalance || 0) < Number(amount)) return res.status(400).json({ error: "Insufficient wallet balance" });

    const networkMap = { MTN: "MTN", Airtel: "AIRTEL", Glo: "GLO", "9mobile": "9MOBILE" };
    const networkCode = networkMap[network];
    if (!networkCode) return res.status(400).json({ error: "Invalid network" });

    const reference = "DATA-" + Date.now();

    // Debit wallet first
    user.walletBalance = (user.walletBalance || 0) - Number(amount);
    user.walletTransactions.push({
      type: "debit",
      amount: Number(amount),
      description: `${network} ${planName || planId} data for ${phone}`,
      reference,
      status: "pending"
    });
    await user.save();

    // Clubkonnect not yet active — refund and block
    user.walletBalance = (user.walletBalance || 0) + Number(amount);
    user.walletTransactions.push({ type: "credit", amount: Number(amount), description: "Refund: data service coming soon", reference: reference + "-REFUND" });
    await user.save();
    return res.status(503).json({ error: "Data bundle service is coming soon. Your wallet has not been charged." });
  } catch (err) {
    console.error("Data bundle error:", err.response?.data || err.message);
    res.status(500).json({ error: "Data purchase failed" });
  }
});


// 10. Verify Electricity Meter
app.post("/api/pay/electricity/verify", auth, async (req, res) => {
  try {
    const { meterNumber, disco, meterType } = req.body;
    if (!meterNumber || !disco || !meterType) return res.status(400).json({ error: "Meter number, disco and meter type are required" });

    const response = await axios.get(
      `https://www.nellobytesystems.com/APIVerifyElectricityV1.asp?UserID=${process.env.CLUBKONNECT_USER_ID}&APIKey=${process.env.CLUBKONNECT_API_KEY}&ElectricDisco=${disco}&MeterType=${meterType}&MeterNumber=${meterNumber}`
    );
    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error("Meter verify error:", err.message);
    res.status(500).json({ error: "Failed to verify meter" });
  }
});

// 11. Pay Electricity Bill
app.post("/api/pay/electricity", auth, pinLimiter, async (req, res) => {
  try {
    const { meterNumber, disco, meterType, amount, customerName, pin } = req.body;
    if (!meterNumber || !disco || !meterType || !amount) return res.status(400).json({ error: "All fields are required" });
    if (Number(amount) < 500) return res.status(400).json({ error: "Minimum electricity payment is N500" });
    const user = await User.findById(req.user.id);
    const pinCheck = await verifyWalletPin(user, pin);
    if (!pinCheck.ok) return res.status(400).json({ error: pinCheck.error });
    if ((user.walletBalance || 0) < Number(amount)) return res.status(400).json({ error: "Insufficient wallet balance" });

    const reference = "ELEC-" + Date.now();

    // Debit wallet first
    user.walletBalance = (user.walletBalance || 0) - Number(amount);
    user.walletTransactions.push({
      type: "debit",
      amount: Number(amount),
      description: `${disco} electricity for meter ${meterNumber}`,
      reference,
      status: "pending"
    });
    await user.save();

    // Clubkonnect not yet active — refund and block
    user.walletBalance = (user.walletBalance || 0) + Number(amount);
    user.walletTransactions.push({ type: "credit", amount: Number(amount), description: "Refund: electricity service coming soon", reference: reference + "-REFUND" });
    await user.save();
    return res.status(503).json({ error: "Electricity payment service is coming soon. Your wallet has not been charged." });
  } catch (err) {
    console.error("Electricity error:", err.response?.data || err.message);
    res.status(500).json({ error: "Electricity payment failed" });
  }
});


// 12. Verify Cable TV Smartcard
app.post("/api/pay/cabletv/verify", auth, async (req, res) => {
  try {
    const { smartcardNumber, provider } = req.body;
    if (!smartcardNumber || !provider) return res.status(400).json({ error: "Smartcard number and provider are required" });

    const response = await axios.get(
      `https://www.nellobytesystems.com/APIVerifyCableTVV1.asp?UserID=${process.env.CLUBKONNECT_USER_ID}&APIKey=${process.env.CLUBKONNECT_API_KEY}&CableTV=${provider}&SmartCardNo=${smartcardNumber}`
    );
    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error("Smartcard verify error:", err.message);
    res.status(500).json({ error: "Failed to verify smartcard" });
  }
});

// 13. Get Cable TV Packages
app.get("/api/pay/cabletv/plans/:provider", auth, async (req, res) => {
  try {
    const { provider } = req.params;

    const staticPlans = {
      DSTV: [
        { id: "DSTV-PADI", name: "DStv Padi", price: 2950 },
        { id: "DSTV-YANGA", name: "DStv Yanga", price: 4100 },
        { id: "DSTV-CONFAM", name: "DStv Confam", price: 6200 },
        { id: "DSTV-COMPACT", name: "DStv Compact", price: 9000 },
        { id: "DSTV-COMPACT-PLUS", name: "DStv Compact Plus", price: 14250 },
        { id: "DSTV-PREMIUM", name: "DStv Premium", price: 24500 },
      ],
      GOTV: [
        { id: "GOTV-SUPA-PLUS", name: "GOtv Supa+", price: 6400 },
        { id: "GOTV-SUPA", name: "GOtv Supa", price: 5500 },
        { id: "GOTV-MAX", name: "GOtv Max", price: 4850 },
        { id: "GOTV-JOLLI", name: "GOtv Jolli", price: 3800 },
        { id: "GOTV-JINJA", name: "GOtv Jinja", price: 2800 },
        { id: "GOTV-SMALLIE", name: "GOtv Smallie", price: 1575 },
      ],
      STARTIMES: [
        { id: "ST-NOVA", name: "Startimes Nova", price: 1300 },
        { id: "ST-BASIC", name: "Startimes Basic", price: 2200 },
        { id: "ST-SMART", name: "Startimes Smart", price: 3100 },
        { id: "ST-CLASSIC", name: "Startimes Classic", price: 2500 },
        { id: "ST-SUPER", name: "Startimes Super", price: 4900 },
      ]
    };

    const plans = staticPlans[provider.toUpperCase()] || [];
    if (plans.length === 0) return res.status(400).json({ error: "Invalid provider" });

    res.json({ success: true, plans });
  } catch (err) {
    console.error("Cable TV plans error:", err.message);
    res.status(500).json({ error: "Failed to fetch cable TV plans" });
  }
});

// 14. Pay Cable TV Subscription
app.post("/api/pay/cabletv", auth, pinLimiter, async (req, res) => {
  // Provider integration is not active. Never debit a wallet or report
  // a successful subscription until the provider confirms payment.
  return res.status(503).json({
    success: false,
    error: "Cable TV payments are temporarily unavailable. Your wallet has not been charged."
  });
});


// Set Wallet PIN
app.post("/api/pay/pin/set", auth, pinLimiter, async (req, res) => {
  try {
    const { pin } = req.body;
    if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: "PIN must be exactly 4 digits" });
    }
    const hashed = await bcrypt.hash(pin, 10);
    await User.findByIdAndUpdate(req.user.id, { walletPin: hashed, walletPinSet: true });
    res.json({ success: true, message: "Wallet PIN set successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to set PIN" });
  }
});

// Verify Wallet PIN
app.post("/api/pay/pin/verify", auth, pinLimiter, async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ error: "PIN is required" });
    const user = await User.findById(req.user.id);
    if (!user.walletPinSet) return res.status(400).json({ error: "No PIN set. Please set a wallet PIN first." });
    const match = await bcrypt.compare(pin, user.walletPin);
    if (!match) return res.status(401).json({ error: "Incorrect PIN" });
    res.json({ success: true, message: "PIN verified" });
  } catch (err) {
    res.status(500).json({ error: "PIN verification failed" });
  }
});


// Forgot Wallet PIN - Send OTP
app.post("/api/pay/pin/forgot", auth, pinResetRequestLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    const otp = randomInt(100000, 1000000).toString();
    user.walletPinResetOtp = await bcrypt.hash(otp, 10);
    user.walletPinResetExpires = new Date(Date.now() + 10 * 60 * 1000);

    await user.save();

    const {
      sendWalletPinResetOTP
    } = await import("./services/notificationService.js");

    const smsResult = await sendWalletPinResetOTP(
      user.phone,
      user.name,
      otp
    );

    let emailSent = false;

    if (!smsResult.success) {
      console.warn("⚠️ SMS delivery failed:", smsResult.error);

      try {
        await sendOTPEmail(user.email, user.name, otp);
        emailSent = true;
        console.log("📧 Wallet PIN OTP sent via email fallback.");
      } catch (emailErr) {
        console.error("❌ Email fallback failed:", emailErr.message);
      }
    }

    res.json({
      success: true,
      smsSent: smsResult.success,
      emailSent,
      message: smsResult.success
        ? "Wallet PIN reset OTP sent via SMS."
        : emailSent
          ? "SMS is temporarily unavailable. The OTP has been sent to your email."
          : "OTP generated successfully, but delivery failed. Please contact support."
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to send reset OTP"
    });
  }
});


// Reset Wallet PIN
app.post("/api/pay/pin/reset", auth, pinLimiter, async (req, res) => {
  try {

    const { otp, newPin } = req.body;

    if (!otp || !newPin)
      return res.status(400).json({
        error: "OTP and new PIN are required"
      });

    if (typeof newPin !== "string" || !/^\d{4}$/.test(newPin))
      return res.status(400).json({
        error: "PIN must be exactly 4 digits"
      });

    const user = await User.findById(req.user.id);

    if (
      !user.walletPinResetOtp ||
      !user.walletPinResetExpires ||
      user.walletPinResetExpires < new Date() ||
      !(await bcrypt.compare(String(otp), user.walletPinResetOtp))
    ) {
      return res.status(400).json({
        error: "Invalid or expired OTP"
      });
    }

    user.walletPin = await bcrypt.hash(newPin, 10);
    user.walletPinSet = true;
    user.walletPinResetOtp = null;
    user.walletPinResetExpires = null;

    await user.save();

    res.json({
      success: true,
      message: "Wallet PIN reset successfully."
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to reset Wallet PIN"
    });
  }
});


// Change Wallet PIN
app.post("/api/pay/pin/change", auth, pinLimiter, async (req, res) => {
  try {
    const { oldPin, newPin, confirmPin } = req.body;

    if (!oldPin || !newPin || !confirmPin) {
      return res.status(400).json({
        error: "Old PIN, new PIN and confirmation are required"
      });
    }

    if (typeof newPin !== "string" || !/^\d{4}$/.test(newPin)) {
      return res.status(400).json({
        error: "New PIN must be exactly 4 digits"
      });
    }

    if (newPin !== confirmPin) {
      return res.status(400).json({
        error: "PIN confirmation does not match"
      });
    }

    const user = await User.findById(req.user.id);

    const pinCheck = await verifyWalletPin(user, oldPin);

    if (!pinCheck.ok) {
      return res.status(400).json({
        error: pinCheck.error
      });
    }

    const samePin = await bcrypt.compare(String(newPin), user.walletPin || "");

    if (samePin) {
      return res.status(400).json({
        error: "New PIN must be different from the current PIN"
      });
    }

    user.walletPin = await bcrypt.hash(String(newPin), 10);
    await user.save();

    try { await sendPinChangedEmail(user); } catch (e) { console.error("PIN email error:", e.message); }

    res.json({
      success: true,
      message: "Wallet PIN changed successfully"
    });

  } catch (err) {
    console.error("PIN change error:", err);
    res.status(500).json({
      error: "Failed to change PIN"
    });
  }
});

// 15. Get Betting Platforms
app.get("/api/pay/betting/platforms", auth, async (req, res) => {
  try {
    const platforms = [
      { id: "bet9ja", name: "Bet9ja", icon: "🎯", minDeposit: 100 },
      { id: "sportybet", name: "SportyBet", icon: "⚽", minDeposit: 100 },
      { id: "1xbet", name: "1xBet", icon: "🏆", minDeposit: 100 }
    ];
    res.json({ success: true, platforms });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch platforms" });
  }
});

// 16. Fund Betting Wallet
app.post("/api/pay/betting", auth, pinLimiter, async (req, res) => {
  try {
    const { platform, bettingId, amount, pin } = req.body;
    if (!platform || !bettingId || !amount) return res.status(400).json({ error: "Platform, betting ID and amount are required" });
    if (Number(amount) < 100) return res.status(400).json({ error: "Minimum betting deposit is N100" });
    const validPlatforms = ["bet9ja", "sportybet", "1xbet"];
    if (!validPlatforms.includes(platform.toLowerCase())) return res.status(400).json({ error: "Invalid betting platform" });

    const user = await User.findById(req.user.id);

    const pinCheck = await verifyWalletPin(user, pin);
    if (!pinCheck.ok) {
      return res.status(400).json({ error: pinCheck.error });
    }

    if ((user.walletBalance || 0) < Number(amount)) {
      return res.status(400).json({ error: "Insufficient wallet balance" });
    }

    const reference = "BET-" + Date.now();
    const platformNames = { bet9ja: "Bet9ja", sportybet: "SportyBet", "1xbet": "1xBet" };

    // Debit wallet first
    user.walletBalance = (user.walletBalance || 0) - Number(amount);
    user.walletTransactions.push({
      type: "debit",
      amount: Number(amount),
      description: `${platformNames[platform.toLowerCase()]} wallet funding for ID ${bettingId}`,
      reference,
      status: "pending"
    });
    await user.save();

    // Clubkonnect not yet active — refund and block
    user.walletBalance = (user.walletBalance || 0) + Number(amount);
    user.walletTransactions.push({ type: "credit", amount: Number(amount), description: "Refund: betting service coming soon", reference: reference + "-REFUND" });
    await user.save();
    return res.status(503).json({ error: "Betting wallet funding is coming soon. Your wallet has not been charged." });
  } catch (err) {
    console.error("Betting error:", err.response?.data || err.message);
    res.status(500).json({ error: "Betting wallet funding failed" });
  }
});

// 7. TechMart Pay Dashboard Data
app.get("/api/pay/dashboard", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("name email walletBalance walletTransactions virtualAccountNumber virtualAccountBank walletPinSet bvnVerified ninVerified");

    // Recent transactions (last 10)
    const recent = [...(user.walletTransactions || [])].reverse().slice(0, 10);

    // Stats
    const totalIn = (user.walletTransactions || []).filter(t => t.type === "credit").reduce((sum, t) => sum + t.amount, 0);
    const totalOut = (user.walletTransactions || []).filter(t => t.type === "debit").reduce((sum, t) => sum + t.amount, 0);

    res.json({
      walletPinSet: user.walletPinSet,
      balance: user.walletBalance || 0,
      virtualAccount: user.virtualAccountNumber ? {
        accountNumber: user.virtualAccountNumber,
        bankName: user.virtualAccountBank || "Wema Bank",
        accountName: user.name
      } : null,
      recentTransactions: recent,
      stats: { totalIn, totalOut, transactionCount: (user.walletTransactions || []).length },
      bvnVerified: user.bvnVerified || false,
      ninVerified: user.ninVerified || false
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch dashboard" });
  }
});

/* ===========================
   MARKETPLACE ENDPOINTS
=========================== */

// --- SELLER ANALYTICS ---
// 📊 Enhanced Seller Analytics
app.get("/api/seller/analytics/enhanced", sellerAuth, async (req, res) => {
  try {
    const products = await Product.find({ vendorId: req.seller.id });
    const productIds = products.map(p => p._id.toString());
    const allOrders = await Order.find({ "items.vendorId": req.seller.id });
    const paidOrders = allOrders.filter(o => ["Paid", "Shipped", "Delivered"].includes(o.status));

    // Revenue calculations
    const totalRevenue = paidOrders.reduce((sum, o) => {
      return sum + o.items.filter(i => i.vendorId === req.seller.id).reduce((s, i) => s + (i.price * (i.quantity || 1)), 0);
    }, 0);

    // Weekly revenue (last 7 weeks)
    const weeklyRevenue = [];
    for (let i = 6; i >= 0; i--) {
      const start = new Date(Date.now() - (i + 1) * 7 * 24 * 60 * 60 * 1000);
      const end = new Date(Date.now() - i * 7 * 24 * 60 * 60 * 1000);
      const weekOrders = paidOrders.filter(o => new Date(o.createdAt) >= start && new Date(o.createdAt) < end);
      const weekRev = weekOrders.reduce((sum, o) => sum + o.items.filter(i => i.vendorId === req.seller.id).reduce((s, i) => s + (i.price * (i.quantity || 1)), 0), 0);
      weeklyRevenue.push({ week: `W${7 - i}`, revenue: weekRev, orders: weekOrders.length });
    }

    // Peak order hours
    const hourCounts = Array(24).fill(0);
    paidOrders.forEach(o => { hourCounts[new Date(o.createdAt).getHours()]++; });
    const peakHours = hourCounts.map((count, hour) => ({ hour: `${hour}:00`, orders: count }));
    const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

    // Buyer repeat rate
    const buyerEmails = paidOrders.map(o => o.email);
    const uniqueBuyers = new Set(buyerEmails).size;
    const repeatBuyers = buyerEmails.filter((e, i) => buyerEmails.indexOf(e) !== i).length;
    const repeatRate = uniqueBuyers > 0 ? Math.round((repeatBuyers / uniqueBuyers) * 100) : 0;

    // Average order value
    const avgOrderValue = paidOrders.length > 0 ? Math.round(totalRevenue / paidOrders.length) : 0;

    // Revenue forecast (linear trend of last 4 weeks)
    const last4Weeks = weeklyRevenue.slice(-4).map(w => w.revenue);
    const avgWeekly = last4Weeks.reduce((s, v) => s + v, 0) / 4;
    const trend = last4Weeks.length > 1 ? (last4Weeks[last4Weeks.length - 1] - last4Weeks[0]) / last4Weeks.length : 0;
    const forecastNextWeek = Math.max(0, Math.round(avgWeekly + trend));

    // Top products with views from behavior data
    const productSales = {};
    paidOrders.forEach(o => {
      o.items.filter(i => i.vendorId === req.seller.id).forEach(i => {
        const id = i.productId || i._id;
        if (!productSales[id]) productSales[id] = { name: i.name, units: 0, revenue: 0 };
        productSales[id].units += (i.quantity || 1);
        productSales[id].revenue += (i.price * (i.quantity || 1));
      });
    });
    const topProducts = Object.values(productSales).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    // Low stock alerts
    const lowStock = products.filter(p => (p.stock || 0) <= 5).map(p => ({ name: p.name, stock: p.stock, id: p._id }));

    // Pending escrow
    const escrowOrders = allOrders.filter(o => o.escrowStatus === "holding" && o.items.some(i => i.vendorId === req.seller.id));
    const pendingEscrow = escrowOrders.reduce((sum, o) => sum + (o.amount || 0), 0);

    // Conversion funnel from behavior data
    const productViews = await BehaviorEvent.countDocuments({ productId: { $in: productIds }, type: "view" });
    const productCarts = await BehaviorEvent.countDocuments({ productId: { $in: productIds }, type: "add_to_cart" });
    const productPurchases = paidOrders.length;

    res.json({
      totalRevenue, avgOrderValue, totalOrders: paidOrders.length,
      uniqueBuyers, repeatRate, forecastNextWeek,
      weeklyRevenue, peakHours, peakHour,
      topProducts, lowStock, pendingEscrow,
      funnel: { views: productViews, carts: productCarts, purchases: productPurchases },
      sellerWallet: (await Seller.findById(req.seller.id).select("walletBalance"))?.walletBalance || 0
    });
  } catch (err) {
    console.error("Enhanced analytics error:", err.message);
    res.status(500).json({ error: "Failed to fetch enhanced analytics" });
  }
});

app.get("/api/seller/analytics", sellerAuth, async (req, res) => {
  try {
    const products = await Product.find({ vendorId: req.seller.id });
    const productIds = products.map(p => p._id.toString());
    const orders = await Order.find({ status: { $in: ["Paid", "Shipped", "Delivered"] } });
    const sellerOrders = orders.filter(o => o.items?.some(i => productIds.includes(i._id?.toString() || i.productId?.toString())));
    const seller = await Seller.findById(req.seller.id);
    const commission = seller.commission || 10;

    const revenue = sellerOrders.reduce((sum, o) => {
      const items = o.items.filter(i => productIds.includes(i._id?.toString() || i.productId?.toString()));
      return sum + items.reduce((s, i) => s + (i.price * (i.quantity || 1)), 0);
    }, 0);

    const commissionAmount = Math.round((commission / 100) * revenue);
    const netRevenue = revenue - commissionAmount;

    // Revenue by date (last 30 days)
    const revenueByDate = {};
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    sellerOrders.filter(o => new Date(o.createdAt) >= thirtyDaysAgo).forEach(o => {
      const date = new Date(o.createdAt).toLocaleDateString();
      const items = o.items.filter(i => productIds.includes(i._id?.toString() || i.productId?.toString()));
      const orderRevenue = items.reduce((s, i) => s + (i.price * (i.quantity || 1)), 0);
      revenueByDate[date] = (revenueByDate[date] || 0) + orderRevenue;
    });

    // Top products
    const productSales = {};
    sellerOrders.forEach(o => {
      o.items.filter(i => productIds.includes(i._id?.toString() || i.productId?.toString())).forEach(i => {
        const id = i._id?.toString() || i.productId?.toString();
        if (!productSales[id]) productSales[id] = { name: i.name, sales: 0, revenue: 0 };
        productSales[id].sales += (i.quantity || 1);
        productSales[id].revenue += (i.price * (i.quantity || 1));
      });
    });
    const topProducts = Object.values(productSales).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    // Performance metrics
    const totalReviews = products.reduce((sum, p) => sum + (p.reviews?.filter(r => r.approved)?.length || 0), 0);
    const avgRating = products.reduce((sum, p) => sum + (p.rating || 0), 0) / (products.length || 1);
    const disputes = await Dispute.countDocuments({ sellerId: req.seller.id });
    const resolvedDisputes = await Dispute.countDocuments({ sellerId: req.seller.id, status: "resolved" });

    res.json({
      revenue, commissionAmount, netRevenue, commission,
      totalOrders: sellerOrders.length,
      totalProducts: products.length,
      revenueByDate,
      topProducts,
      avgRating: avgRating.toFixed(1),
      totalReviews,
      disputes,
      resolvedDisputes,
      fulfillmentRate: sellerOrders.length > 0 ? Math.round((sellerOrders.filter(o => o.status === "Delivered").length / sellerOrders.length) * 100) : 0
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// --- COMMISSION MANAGEMENT (Admin) ---
app.put("/api/admin/sellers/:id/commission", adminOnly, async (req, res) => {
  try {
    const { commission } = req.body;
    const seller = await Seller.findByIdAndUpdate(req.params.id, { commission: Number(commission) }, { new: true }).select("-password");
    res.json({ success: true, data: seller });
  } catch (err) {
    res.status(500).json({ error: "Failed to update commission" });
  }
});

// --- SELLER VERIFICATION SUMMARY ---
function getSellerVerificationSummary(seller) {
  const v = seller.verification || {};

  const checks = {
    cac: seller.sellerType === "business"
      ? v.cac?.status === "verified"
      : true,
    bank: v.bank?.status === "verified",
    ninFaceMatch:
      v.ninFaceMatch?.status === "verified" &&
      v.ninFaceMatch?.faceMatchStatus === "matched",
    guarantors: v.guarantors?.status === "verified",
    liveAddress: v.liveAddress?.status === "verified",
    shop: v.shop?.status === "verified"
  };

  const incompleteChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);

  return {
    checks,
    incompleteChecks,
    eligible: seller.status === "approved" && incompleteChecks.length === 0
  };
}

// --- SELLER VERIFICATION REVIEW (Admin) ---
app.patch("/api/admin/sellers/:id/verification/:check", adminOnly, async (req, res) => {
  try {
    const allowedChecks = [
      "cac",
      "ninFaceMatch",
      "guarantors",
      "liveAddress",
      "shop"
    ];

    const { check } = req.params;
    const { status, reviewerNote, referenceUpdates } = req.body;

    if (!allowedChecks.includes(check)) {
      return res.status(400).json({ error: "Invalid verification check" });
    }

    const allowedStatuses = [
      "pending",
      "under_review",
      "verified",
      "failed",
      "rejected"
    ];

    if (status && !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid verification status" });
    }

    const seller = await Seller.findById(req.params.id);

    if (!seller) {
      return res.status(404).json({ error: "Seller not found" });
    }

    if (check === "cac" && seller.sellerType !== "business") {
      return res.status(400).json({
        error: "CAC verification does not apply to individual sellers"
      });
    }

    if (check === "cac" && status === "verified") {
      if (!seller.businessLegalName || !seller.cacRegistrationNumber) {
        return res.status(400).json({
          error: "Business legal name and CAC registration number are required"
        });
      }
    }

    if (check === "ninFaceMatch" && status === "verified") {
      return res.status(400).json({
        error: "NIN and face-match verification must be confirmed by an authorized identity-verification provider"
      });
    }

    if (check === "guarantors") {
      const references = seller.verification.guarantors.references || [];

      if (Array.isArray(referenceUpdates)) {
        for (const update of referenceUpdates) {
          const index = Number(update.index);
          const referenceStatus = update.status;

          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= references.length ||
            !["contacted", "verified", "rejected"].includes(referenceStatus)
          ) {
            return res.status(400).json({
              error: "Invalid guarantor reference update"
            });
          }

          if (referenceStatus === "verified" && !references[index].consent) {
            return res.status(400).json({
              error: "Guarantor consent is required before verification"
            });
          }

          references[index].status = referenceStatus;
        }
      }

      if (status === "verified") {
        const allReferencesVerified =
          references.length > 0 &&
          references.every(ref => ref.consent && ref.status === "verified");

        if (!allReferencesVerified) {
          return res.status(400).json({
            error: "Every guarantor must provide consent and pass verification"
          });
        }
      }
    }

    if (check === "liveAddress" && status === "verified") {
      if (!seller.verification.liveAddress.address ||
          !seller.verification.liveAddress.proofReference) {
        return res.status(400).json({
          error: "Address and proof reference are required before approval"
        });
      }
    }

    if (check === "shop" && status === "verified") {
      if (!seller.verification.shop.photoReferences?.length) {
        return res.status(400).json({
          error: "Shop photos are required before approval"
        });
      }
    }

    if (status) {
      seller.verification[check].status = status;
      seller.verification[check].verifiedAt =
        status === "verified" ? new Date() : null;
    }

    if (
      typeof reviewerNote === "string" &&
      ["cac", "shop"].includes(check)
    ) {
      seller.verification[check].reviewerNote = reviewerNote.trim();
    }

    const summary = getSellerVerificationSummary(seller);

    seller.verified = summary.eligible;
    seller.techmartVerifiedAt = summary.eligible
      ? (seller.techmartVerifiedAt || new Date())
      : null;
    seller.verificationLevel = summary.eligible ? "seller" : "none";

    await seller.save();

    const safeSeller = seller.toObject();
    delete safeSeller.password;
    delete safeSeller.passwordHash;
    delete safeSeller.resetPasswordToken;
    delete safeSeller.emailVerificationToken;

    res.json({
      success: true,
      data: safeSeller,
      verificationSummary: getSellerVerificationSummary(seller)
    });
  } catch (err) {
    console.error("Seller verification review failed:", err.message);
    res.status(500).json({ error: "Failed to review seller verification" });
  }
});

// Bank verification is exclusively handled by the Paystack account-resolution route.
// NIN/face-match verification cannot be manually approved by an administrator.

// --- LEGACY SELLER VERIFICATION ENDPOINT ---
app.put("/api/admin/sellers/:id/verify", adminOnly, async (req, res) => {
  try {
    if (req.body.verified !== false) {
      return res.status(400).json({
        error: "Direct verification is disabled. Complete the required verification checks first."
      });
    }

    const seller = await Seller.findById(req.params.id);

    if (!seller) {
      return res.status(404).json({ error: "Seller not found" });
    }

    seller.verified = false;
    seller.techmartVerifiedAt = null;
    seller.verificationLevel = "none";

    await seller.save();

    const safeSeller = seller.toObject();
    delete safeSeller.password;
    delete safeSeller.passwordHash;
    delete safeSeller.resetPasswordToken;
    delete safeSeller.emailVerificationToken;

    res.json({ success: true, data: safeSeller });
  } catch (err) {
    console.error("Seller verification update failed:", err.message);
    res.status(500).json({ error: "Failed to update verification" });
  }
});

// --- STOREFRONT CUSTOMIZATION ---
app.put("/api/seller/storefront", sellerAuth, async (req, res) => {
  try {
    const { storeDescription, storeBanner, storeLogo, storeColor } = req.body;
    const seller = await Seller.findByIdAndUpdate(
      req.seller.id,
      { storeDescription, storeBanner, storeLogo, storeColor },
      { new: true }
    ).select("-password");
    res.json({ success: true, data: seller });
  } catch (err) {
    res.status(500).json({ error: "Failed to update storefront" });
  }
});

// Get seller storefront (public)
app.get("/api/seller/store/:id", async (req, res) => {
  try {
    const seller = await Seller.findById(req.params.id).select("-password");
    if (!seller || seller.status !== "approved") return res.status(404).json({ error: "Store not found" });
    const products = await Product.find({ vendorId: req.params.id });
    res.json({ seller, products });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch store" });
  }
});

// --- PAYOUT REQUESTS ---

async function createSellerPayoutRequest(sellerId, amountInput) {
  const amount = Number(amountInput);

  if (!Number.isSafeInteger(amount) || amount < 1000) {
    const error = new Error("Enter a valid payout amount of at least N1,000");
    error.statusCode = 400;
    throw error;
  }

  const reference = `manual-${sellerId}-${crypto.randomBytes(12).toString("hex")}`;
  const session = await mongoose.startSession();
  let payout;

  try {
    await session.withTransaction(async () => {
      const seller = await Seller.findById(sellerId).session(session);

      if (!seller) {
        const error = new Error("Seller account not found");
        error.statusCode = 404;
        throw error;
      }

      if (seller.status !== "approved") {
        const error = new Error("Your seller account must be approved before requesting a payout");
        error.statusCode = 403;
        throw error;
      }

      const bank = seller.verification?.bank || {};
      const normalize = value => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const accountNameMatches =
        bank.verifiedAccountName &&
        normalize(seller.accountName) === normalize(bank.verifiedAccountName);

      if (
        bank.status !== "verified" ||
        !seller.bankCode ||
        !seller.bankName ||
        !/^\d{10}$/.test(String(seller.accountNumber || "")) ||
        !seller.accountName ||
        !accountNameMatches
      ) {
        const error = new Error("Save and verify your bank account before requesting a payout");
        error.statusCode = 403;
        throw error;
      }

      if (Number(seller.walletBalance || 0) < amount) {
        const error = new Error("Insufficient available seller wallet balance");
        error.statusCode = 400;
        throw error;
      }

      seller.walletBalance = Number(seller.walletBalance || 0) - amount;
      seller.walletTransactions = seller.walletTransactions || [];
      seller.walletTransactions.push({
        type: "debit",
        amount,
        description: `Payout funds reserved for ${seller.accountName}`,
        reference
      });
      await seller.save({ session });

      const created = await Payout.create([{
        sellerId: seller._id,
        sellerName: seller.name,
        sellerEmail: seller.email,
        storeName: seller.storeName,
        amount,
        bankCode: seller.bankCode,
        bankName: seller.bankName,
        accountNumber: seller.accountNumber,
        accountName: seller.accountName,
        reference,
        payoutType: "manual",
        transferStatus: "pending",
        status: "pending",
        fundsReserved: true,
        note: "Funds reserved; awaiting admin approval and Paystack transfer"
      }], { session });

      payout = created[0];
    });

    return payout;
  } finally {
    await session.endSession();
  }
}

app.post("/api/seller/payouts", sellerAuth, async (req, res) => {
  try {
    const payout = await createSellerPayoutRequest(req.seller.id, req.body.amount);
    res.status(201).json({
      success: true,
      data: payout,
      message: "Payout request submitted. Funds are reserved pending approval."
    });
  } catch (err) {
    console.error("Seller payout request error:", err.message);
    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to request payout"
    });
  }
});

app.get("/api/seller/payouts", sellerAuth, async (req, res) => {
  try {
    const payouts = await Payout.find({ sellerId: req.seller.id }).sort({ createdAt: -1 });
    res.json(payouts);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch payouts" });
  }
});

// Admin payout management
app.get("/api/admin/payouts", adminOnly, async (req, res) => {
  try {
    const payouts = await Payout.find().sort({ createdAt: -1 });
    res.json(payouts);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch payouts" });
  }
});

app.put("/api/admin/payouts/:id", adminOnly, async (req, res) => {
  const { status, note } = req.body || {};

  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({
      error: "Choose approved or rejected. Payouts cannot be marked paid manually."
    });
  }

  try {
    if (status === "rejected") {
      const session = await mongoose.startSession();
      let payout;

      try {
        await session.withTransaction(async () => {
          payout = await Payout.findById(req.params.id).session(session);

          if (!payout) {
            const error = new Error("Payout not found");
            error.statusCode = 404;
            throw error;
          }

          if (payout.status !== "pending") {
            const error = new Error("Only pending payouts can be rejected");
            error.statusCode = 409;
            throw error;
          }

          if (payout.fundsReserved === true) {
            const seller = await Seller.findById(payout.sellerId).session(session);

            if (!seller) {
              const error = new Error("Seller account not found; payout was not changed");
              error.statusCode = 404;
              throw error;
            }

            const refundReference = `REFUND-${payout.reference}`;
            const alreadyRefunded = (seller.walletTransactions || []).some(
              transaction => transaction.reference === refundReference
            );

            if (!alreadyRefunded) {
              seller.walletBalance = Number(seller.walletBalance || 0) + payout.amount;
              seller.walletTransactions = seller.walletTransactions || [];
              seller.walletTransactions.push({
                type: "credit",
                amount: payout.amount,
                description: `Rejected payout returned — ${payout.reference}`,
                reference: refundReference
              });
              await seller.save({ session });
            }

            payout.fundsReserved = false;
          }

          payout.status = "rejected";
          payout.transferStatus = "failed";
          payout.processedAt = new Date();
          payout.note = String(note || "Payout rejected by administrator").slice(0, 500);
          await payout.save({ session });
        });
      } finally {
        await session.endSession();
      }

      return res.json({ success: true, data: payout });
    }

    // Approval: reserve the payout state before contacting Paystack.
    const payout = await Payout.findOneAndUpdate(
      {
        _id: req.params.id,
        status: "pending",
        payoutType: "manual",
        fundsReserved: true
      },
      {
        $set: {
          status: "approved",
          transferStatus: "processing",
          note: "Approved; Paystack transfer is being initiated"
        }
      },
      { new: true }
    );

    if (!payout) {
      const existing = await Payout.findById(req.params.id);
      if (!existing) return res.status(404).json({ error: "Payout not found" });
      return res.status(409).json({
        error: "Payout is not an eligible pending reserved manual payout",
        data: existing
      });
    }

    const seller = await Seller.findById(payout.sellerId);
    const bank = seller?.verification?.bank || {};
    const normalize = value => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

    if (
      !seller ||
      seller.status !== "approved" ||
      bank.status !== "verified" ||
      !seller.bankCode ||
      seller.accountNumber !== payout.accountNumber ||
      seller.bankCode !== payout.bankCode ||
      normalize(seller.accountName) !== normalize(payout.accountName) ||
      normalize(bank.verifiedAccountName) !== normalize(payout.accountName)
    ) {
      await Payout.findByIdAndUpdate(payout._id, {
        status: "pending",
        transferStatus: "pending",
        note: "Approval stopped: seller approval or verified bank details need review"
      });
      return res.status(409).json({
        error: "Seller approval or verified bank details no longer match this payout"
      });
    }

    if (!process.env.PAYSTACK_SECRET_KEY) {
      await Payout.findByIdAndUpdate(payout._id, {
        status: "pending",
        transferStatus: "pending",
        note: "Paystack secret key is not configured"
      });
      return res.status(503).json({ error: "Paystack is not configured" });
    }

    try {
      const headers = {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      };

      const recipientRes = await axios.post(
        "https://api.paystack.co/transferrecipient",
        {
          type: "nuban",
          name: payout.accountName,
          account_number: payout.accountNumber,
          bank_code: payout.bankCode,
          currency: "NGN"
        },
        { headers, timeout: 20000 }
      );

      const recipientCode = recipientRes.data?.data?.recipient_code;
      if (!recipientCode) throw new Error("Paystack did not return a recipient code");

      const transferRes = await axios.post(
        "https://api.paystack.co/transfer",
        {
          source: "balance",
          amount: Math.round(payout.amount * 100),
          recipient: recipientCode,
          reason: `TechMart seller payout — ${payout.storeName || payout.sellerName}`,
          reference: payout.reference
        },
        { headers, timeout: 20000 }
      );

      const transfer = transferRes.data?.data;
      if (!transfer?.transfer_code) {
        throw new Error("Paystack did not confirm transfer submission");
      }

      const updated = await Payout.findByIdAndUpdate(
        payout._id,
        {
          $set: {
            status: "approved",
            transferStatus: "processing",
            transferCode: transfer.transfer_code,
            transferId: transfer.id ? String(transfer.id) : undefined,
            note: "Paystack transfer submitted; awaiting confirmed success or failure"
          }
        },
        { new: true }
      );

      return res.json({ success: true, data: updated });
    } catch (transferError) {
      console.error(
        "Paystack payout initiation error:",
        transferError.response?.data || transferError.message
      );

      const updated = await Payout.findByIdAndUpdate(
        payout._id,
        {
          $set: {
            status: "approved",
            transferStatus: "processing",
            note: "Transfer outcome requires Paystack verification. Do not submit another transfer."
          }
        },
        { new: true }
      );

      return res.status(202).json({
        success: true,
        message: "Payout approval recorded; transfer outcome requires reconciliation.",
        data: updated
      });
    }
  } catch (err) {
    console.error("Admin payout management error:", err.message);
    return res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to process payout"
    });
  }
});

// --- DISPUTES ---
app.post("/api/disputes", auth, async (req, res) => {
  try {
    const { orderId, subject, description, reason } = req.body;
    if (!orderId || !description) return res.status(400).json({ error: "Order ID and description are required" });
    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: "User account not found" });
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.email !== user.email) return res.status(403).json({ error: "Not your order" });
    // Derive sellerId/sellerName from the order itself, never trust client input
    const sellerId = order.items[0]?.vendorId || null;
    let sellerName = "Unknown Seller";
    if (sellerId) {
      const seller = await Seller.findById(sellerId).catch(() => null);
      if (seller) sellerName = seller.storeName || seller.name;
    }
    const dispute = await Dispute.create({
      orderId, sellerId, sellerName, subject: subject || reason || "Order dispute", description,
      customerEmail: user.email,
      customerId: req.user.id,
      messages: [{ sender: user.name, senderType: "customer", message: description }]
    });
    res.status(201).json({ success: true, data: dispute });
  } catch (err) {
    console.error("Dispute creation error:", err.message);
    res.status(500).json({ error: "Failed to create dispute" });
  }
});

app.get("/api/disputes/my", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const disputes = await Dispute.find({ customerEmail: user.email }).sort({ createdAt: -1 });
    res.json(disputes);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch disputes" });
  }
});

app.get("/api/seller/disputes", sellerAuth, async (req, res) => {
  try {
    const disputes = await Dispute.find({ sellerId: req.seller.id }).sort({ createdAt: -1 });
    res.json(disputes);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch disputes" });
  }
});

// Isolated dispute reply routes; dependencies use the existing production middleware and models.
app.use(require("./routes/disputeReplies")({
  auth, sellerAuth, adminOnly, User, Seller, Dispute
}));

app.get("/api/admin/disputes", adminOnly, async (req, res) => {
  try {
    const disputes = await Dispute.find().sort({ createdAt: -1 });
    res.json(disputes);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch disputes" });
  }
});

app.put("/api/admin/disputes/:id", adminOnly, async (req, res) => {
  try {
    const { status } = req.body;
    const dispute = await Dispute.findByIdAndUpdate(req.params.id, { status }, { new: true });
    res.json({ success: true, data: dispute });
  } catch (err) {
    res.status(500).json({ error: "Failed to update dispute" });
  }
});

// --- SELLER MESSAGING ---
app.post("/api/seller/messages", auth, async (req, res) => {
  req.body.message = sanitize(req.body.message || "");
  req.body.subject = sanitize(req.body.subject || "");
  try {
    const { sellerId, productId, productName, message } = req.body;
    const user = await User.findById(req.user.id);
    let thread = await SellerMessage.findOne({ sellerId, customerEmail: user.email, productId });
    if (!thread) {
      thread = await SellerMessage.create({
        sellerId, customerEmail: user.email, customerName: user.name,
        productId, productName,
        messages: [{ sender: user.name, senderType: "customer", message }]
      });
    } else {
      thread.messages.push({ sender: user.name, senderType: "customer", message });
      await thread.save();
    }
    res.json({ success: true, data: thread });
  } catch (err) {
    res.status(500).json({ error: "Failed to send message" });
  }
});

app.get("/api/seller/messages", sellerAuth, async (req, res) => {
  try {
    const threads = await SellerMessage.find({ sellerId: req.seller.id }).sort({ createdAt: -1 });
    res.json(threads);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

app.post("/api/seller/messages/:id/reply", sellerAuth, async (req, res) => {
  req.body.message = sanitize(req.body.message || "");
  try {
    const { message } = req.body;
    const seller = await Seller.findById(req.seller.id);
    const thread = await SellerMessage.findByIdAndUpdate(
      req.params.id,
      { $push: { messages: { sender: seller.storeName, senderType: "seller", message } } },
      { new: true }
    );
    res.json({ success: true, data: thread });
  } catch (err) {
    res.status(500).json({ error: "Failed to reply" });
  }
});

app.get("/api/seller/messages/customer", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const threads = await SellerMessage.find({ customerEmail: user.email }).sort({ createdAt: -1 });
    res.json(threads);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});


/* ===========================
   AI COMMERCE ENDPOINTS
=========================== */
// AI Chat Assistant
app.post("/api/ai/chat", async (req, res) => {
  try {
    const { message, history = [], userEmail = "Guest", userName = "Guest" } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });

    const liveProducts = await Product.find({ stock: { $gt: 0 } }).select("name price stock category description");
    const catalogContext = liveProducts.map(p =>
      `- ${p.name} (N${p.price.toLocaleString()}) | Category: ${p.category} | Stock: ${p.stock} left.`
    ).join("\n");

    const systemInstruction = {
      role: "system",
      content: `You are the AI Sales Assistant for TechMart, Nigeria's elite electronics store.
CURRENT USER: ${userName !== "Guest" ? userName : "a guest"}.
RULES:
1. Always quote prices in Naira (N symbol).
2. Only recommend products from the LIVE CATALOG below.
3. Keep answers concise and helpful.
LIVE CATALOG:
${catalogContext}`
    };

    const messagesPayload = [
      systemInstruction,
      ...history.map(msg => ({ role: msg.sender === "user" ? "user" : "assistant", content: msg.text })),
      { role: "user", content: message }
    ];

    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: messagesPayload,
      temperature: 0.7,
      max_tokens: 500
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error("AI chat error:", err.message);
    res.status(500).json({ error: "AI server error" });
  }
});

app.post("/api/ai/search", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "Query is required" });

    const products = await Product.find({ stock: { $gt: 0 } });

    // Step 1: Use AI to extract structured filters from the query
    const filterResponse = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "openai/gpt-oss-20b",
        messages: [
          {
            role: "system",
            content: `You are TechMart's search filter extractor for a Nigerian electronics marketplace.
Extract search filters from the user query and return ONLY a valid JSON object with these fields:
{
  "keywords": ["keyword1", "keyword2"],
  "maxPrice": null or number in Naira,
  "minPrice": null or number in Naira,
  "category": null or string,
  "brand": null or string,
  "condition": null or "New" or "Used" or "Refurbished",
  "sortBy": "relevance" or "price_asc" or "price_desc" or "newest"
}
Nigerian price formats: "200k" = 200000, "1.5m" = 1500000, "#200,000" = 200000, "N200000" = 200000.
Return ONLY the JSON object. No explanation.`
          },
          { role: "user", content: query }
        ],
        max_tokens: 200,
        temperature: 0.1
      },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" } }
    );

    let filters = {};
    try {
      const filterText = filterResponse.data.choices[0].message.content.trim();
      const match = filterText.match(/\{[\s\S]*\}/);
      if (match) filters = JSON.parse(match[0]);
    } catch {}

    // Step 2: Apply filters directly on MongoDB
    const dbQuery = { stock: { $gt: 0 } };
    if (filters.maxPrice) dbQuery.price = { ...( dbQuery.price || {}), $lte: filters.maxPrice };
    if (filters.minPrice) dbQuery.price = { ...(dbQuery.price || {}), $gte: filters.minPrice };
    if (filters.category) dbQuery.category = new RegExp(filters.category, "i");
    if (filters.condition) dbQuery.condition = new RegExp(filters.condition, "i");
    if (filters.brand) {
      dbQuery.$or = [
        { name: new RegExp(filters.brand, "i") },
        { brand: new RegExp(filters.brand, "i") },
        { description: new RegExp(filters.brand, "i") }
      ];
    }
    if (filters.keywords?.length) {
      const keywordRegex = filters.keywords.map(k => new RegExp(k, "i"));
      if (!dbQuery.$or) {
        dbQuery.$or = keywordRegex.flatMap(r => [{ name: r }, { description: r }, { category: r }]);
      }
    }

    let results = await Product.find(dbQuery).limit(30);

    // Step 3: If DB filters return nothing, fall back to AI ranking
    if (!results.length) {
      const productList = products.map(p =>
        `ID:${p._id}|NAME:${p.name}|PRICE:${p.price}|CAT:${p.category}|COND:${p.condition || "New"}|DESC:${p.description?.substring(0, 80)}`
      ).join("\n");

      const rankResponse = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "openai/gpt-oss-20b",
          messages: [
            {
              role: "system",
              content: `You are TechMart's AI search engine for a Nigerian electronics marketplace. Return IDs of the most relevant products as a JSON array: ["id1","id2"]. Max 10 results. No explanation.`
            },
            {
              role: "user",
              content: `Query: "${query}"\n\nProducts:\n${productList}`
            }
          ],
          max_tokens: 300,
          temperature: 0.1
        },
        { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" } }
      );

      const rankText = rankResponse.data.choices[0].message.content.trim();
      let ids = [];
      try { ids = JSON.parse(rankText); } catch { const m = rankText.match(/\[.*?\]/s); if (m) ids = JSON.parse(m[0]); }
      results = products.filter(p => ids.includes(p._id.toString()));
    }

    // Step 4: Sort results
    if (filters.sortBy === "price_asc") results.sort((a, b) => a.price - b.price);
    else if (filters.sortBy === "price_desc") results.sort((a, b) => b.price - a.price);
    else if (filters.sortBy === "newest") results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Step 5: Build facets for frontend filters
    const allMatched = results;
    const facets = {
      categories: [...new Set(allMatched.map(p => p.category).filter(Boolean))],
      brands: [...new Set(allMatched.map(p => p.brand || p.name?.split(" ")[0]).filter(Boolean))],
      conditions: [...new Set(allMatched.map(p => p.condition || "New").filter(Boolean))],
      priceRange: {
        min: allMatched.length ? Math.min(...allMatched.map(p => p.price)) : 0,
        max: allMatched.length ? Math.max(...allMatched.map(p => p.price)) : 0
      }
    };

    res.json({ success: true, query, results, total: results.length, filters, facets });
  } catch (err) {
    console.error("AI search error:", err.message);
    res.status(500).json({ error: "AI search failed" });
  }
});

// 2. AI PRODUCT RECOMMENDATIONS
app.post("/api/ai/recommendations", async (req, res) => {
  try {
    const { productId, cartItems, userId } = req.body;
    const products = await Product.find({ stock: { $gt: 0 } });

    let context = "";
    if (productId) {
      const current = products.find(p => p._id.toString() === productId);
      if (current) context += `Currently viewing: ${current.name} (${current.category}) at N${current.price}\n`;
    }
    if (cartItems?.length) {
      context += `In cart: ${cartItems.map(i => i.name).join(", ")}\n`;
    }

    const productList = products
      .filter(p => p._id.toString() !== productId)
      .map(p => `ID:${p._id} | ${p.name} | N${p.price} | ${p.category}`)
      .join("\n");

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "openai/gpt-oss-20b",
        messages: [
          {
            role: "system",
            content: `You are TechMart's recommendation engine. Based on customer context, recommend the 6 most relevant products. Return only a JSON array of IDs: ["id1","id2",...]. No explanation.`
          },
          {
            role: "user",
            content: `Context:\n${context}\nAvailable products:\n${productList}`
          }
        ],
        max_tokens: 200,
        temperature: 0.3
      },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" } }
    );

    const text = response.data.choices[0].message.content.trim();
    let ids = [];
    try { ids = JSON.parse(text); } catch { const m = text.match(/\[.*?\]/s); if (m) ids = JSON.parse(m[0]); }

    const results = products.filter(p => ids.includes(p._id.toString())).slice(0, 6);
    res.json({ success: true, results });
  } catch (err) {
    console.error("AI recommendations error:", err.message);
    res.status(500).json({ error: "Failed to get recommendations" });
  }
});

// 3. AI BUNDLE SUGGESTIONS
app.post("/api/ai/bundles", async (req, res) => {
  try {
    const { productId } = req.body;
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ error: "Product not found" });

    const otherProducts = await Product.find({ _id: { $ne: productId }, stock: { $gt: 0 } });
    const productList = otherProducts.map(p => `ID:${p._id} | ${p.name} | N${p.price} | ${p.category}`).join("\n");

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "openai/gpt-oss-20b",
        messages: [
          {
            role: "system",
            content: `You are TechMart's bundle suggestion engine. Suggest 3 complementary products that go well with the main product. Return only a JSON array of IDs: ["id1","id2","id3"]. No explanation.`
          },
          {
            role: "user",
            content: `Main product: ${product.name} (${product.category}) at N${product.price}\n\nAvailable products:\n${productList}`
          }
        ],
        max_tokens: 150,
        temperature: 0.3
      },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" } }
    );

    const text = response.data.choices[0].message.content.trim();
    let ids = [];
    try { ids = JSON.parse(text); } catch { const m = text.match(/\[.*?\]/s); if (m) ids = JSON.parse(m[0]); }

    const bundleProducts = await Product.find({ _id: { $in: ids }, stock: { $gt: 0 } });
    const bundleTotal = product.price + bundleProducts.reduce((sum, p) => sum + p.price, 0);
    const bundleDiscount = Math.round(bundleTotal * 0.05);

    res.json({ success: true, mainProduct: product, bundleProducts, bundleTotal, bundleDiscount, bundlePrice: bundleTotal - bundleDiscount });
  } catch (err) {
    console.error("AI bundle error:", err.message);
    res.status(500).json({ error: "Failed to get bundle suggestions" });
  }
});

// 4. AI PRODUCT DESCRIPTION GENERATOR
app.post("/api/ai/generate-description", async (req, res) => {
  try {
    const { productName, category, price, keyFeatures } = req.body;
    if (!productName) return res.status(400).json({ error: "Product name is required" });

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "openai/gpt-oss-20b",
        messages: [
          {
            role: "system",
            content: `You are TechMart's product description writer. Write compelling, SEO-friendly product descriptions for Nigerian electronics marketplace. Be concise (100-150 words), highlight key benefits, and use engaging language. Return only the description text, no extra formatting.`
          },
          {
            role: "user",
            content: `Product: ${productName}\nCategory: ${category || "Electronics"}\nPrice: N${price || ""}\nKey Features: ${keyFeatures || "Not specified"}\n\nWrite a compelling product description.`
          }
        ],
        max_tokens: 300,
        temperature: 0.7
      },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" } }
    );

    const description = response.data.choices[0].message.content.trim();
    res.json({ success: true, description });
  } catch (err) {
    console.error("AI description error:", err.message);
    res.status(500).json({ error: "Failed to generate description" });
  }
});

// 5. AI REVIEW SUMMARY
app.get("/api/ai/review-summary/:productId", async (req, res) => {
  try {
    const product = await Product.findById(req.params.productId);
    if (!product) return res.status(404).json({ error: "Product not found" });

    const approvedReviews = product.reviews?.filter(r => r.approved) || [];
    if (approvedReviews.length === 0) return res.json({ success: true, summary: null, reviewCount: 0 });

    const reviewText = approvedReviews.map(r => `${r.stars}/5 stars: ${r.comment}`).join("\n");

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "openai/gpt-oss-20b",
        messages: [
          {
            role: "system",
            content: `You are TechMart's review summarizer. Summarize customer reviews in 2-3 sentences. Mention what customers love and any concerns. Be balanced and factual. Return only the summary text.`
          },
          {
            role: "user",
            content: `Product: ${product.name}\nReviews:\n${reviewText}`
          }
        ],
        max_tokens: 200,
        temperature: 0.3
      },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" } }
    );

    const summary = response.data.choices[0].message.content.trim();
    res.json({ success: true, summary, reviewCount: approvedReviews.length, avgRating: product.rating });
  } catch (err) {
    console.error("AI review summary error:", err.message);
    res.status(500).json({ error: "Failed to generate review summary" });
  }
});

// 6. AI INVENTORY FORECASTING
app.get("/api/ai/inventory-forecast", adminOnly, async (req, res) => {
  try {
    const products = await Product.find();
    const orders = await Order.find({ status: { $in: ["Paid", "Delivered", "Shipped"] }, createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } });

    // Calculate sales velocity per product
    const salesMap = {};
    orders.forEach(o => {
      o.items?.forEach(item => {
        const id = item._id?.toString() || item.productId?.toString();
        if (id) salesMap[id] = (salesMap[id] || 0) + (item.quantity || 1);
      });
    });

    const forecasts = products.map(p => {
      const sold30Days = salesMap[p._id.toString()] || 0;
      const dailyVelocity = sold30Days / 30;
      const daysUntilStockout = dailyVelocity > 0 ? Math.floor(p.stock / dailyVelocity) : null;
      const reorderSuggestion = dailyVelocity > 0 ? Math.ceil(dailyVelocity * 30) : 0;

      return {
        productId: p._id,
        name: p.name,
        currentStock: p.stock,
        sold30Days,
        dailyVelocity: dailyVelocity.toFixed(2),
        daysUntilStockout,
        reorderSuggestion,
        status: daysUntilStockout === null ? "slow" : daysUntilStockout <= 7 ? "critical" : daysUntilStockout <= 14 ? "low" : "healthy"
      };
    }).sort((a, b) => (a.daysUntilStockout || 999) - (b.daysUntilStockout || 999));

    res.json({ success: true, forecasts, generatedAt: new Date() });
  } catch (err) {
    console.error("AI forecast error:", err.message);
    res.status(500).json({ error: "Failed to generate forecast" });
  }
});


/* ===========================
   FLASH SALE ENDPOINTS
=========================== */

// Get active flash sales (public)
app.get("/api/flash-sales", async (req, res) => {
  try {
    const now = new Date();
    const sales = await FlashSale.find({
      active: true,
      startTime: { $lte: now },
      endTime: { $gte: now }
    }).populate("productId");
    res.json(sales);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch flash sales" });
  }
});

// Create flash sale (admin)
app.post("/api/admin/flash-sales", adminOnly, async (req, res) => {
  try {
    const { productId, salePrice, startTime, endTime } = req.body;
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ error: "Product not found" });
    const sale = await FlashSale.create({
      productId,
      productName: product.name,
      originalPrice: product.price,
      salePrice: Number(salePrice),
      startTime: new Date(startTime),
      endTime: new Date(endTime),
    });
    res.status(201).json({ success: true, data: sale });
  } catch (err) {
    res.status(500).json({ error: "Failed to create flash sale" });
  }
});

// Get all flash sales (admin)
app.get("/api/admin/flash-sales", adminOnly, async (req, res) => {
  try {
    const sales = await FlashSale.find().sort({ createdAt: -1 });
    res.json(sales);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch flash sales" });
  }
});

// Delete flash sale (admin)
app.delete("/api/admin/flash-sales/:id", adminOnly, async (req, res) => {
  try {
    await FlashSale.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete flash sale" });
  }
});

/* ===========================
   DELIVERY FEE CALCULATOR
=========================== */
const DELIVERY_ZONES = [
  {
    zone: 1,
    name: "Ikeja & Surroundings",
    areas: ["ikeja", "ogba", "agege", "ojota", "alausa", "oregun", "opebi", "allen avenue", "maryland", "palmgrove", "onipanu", "gbagada", "magodo", "omole", "berger", "ojodu", "ketu", "mile 12", "oworo", "oworonshoki"],
    fee: 2500
  },
  {
    zone: 2,
    name: "Mainland",
    areas: ["yaba", "mushin", "oshodi", "surulere", "isolo", "ilasamaja", "itire", "bariga", "shomolu", "tinubu", "iganmu", "ebute metta", "otto", "ijora", "orile", "okota", "ago palace", "isolo"],
    fee: 3500
  },
  {
    zone: 3,
    name: "Lagos Island & VI",
    areas: ["victoria island", "ikoyi", "lagos island", "apapa", "obalende", "broad street", "marina", "bar beach", "eti osa", "itirin", "onikan", "idumota", "balogun", "carter"],
    fee: 4500
  },
  {
    zone: 4,
    name: "Lekki & Ajah",
    areas: ["lekki", "ajah", "sangotedo", "chevron", "vgc", "victoria garden", "abraham adesanya", "jakande", "igbo efon", "ibeju", "awoyaya", "lakowe", "bogije", "monastery", "orchid", "lafiaji"],
    fee: 5500
  },
  {
    zone: 5,
    name: "Outskirts",
    areas: ["ikorodu", "badagry", "epe", "mowe", "ibafo", "sagamu", "sango", "ota", "agbara", "arepo", "ojokoro", "ifako", "meiran", "abule egba", "alakuko"],
    fee: 7500
  },
];
const FREE_DELIVERY_THRESHOLD = 150000;
const DEFAULT_FEE = 12000; // Outside Lagos

const calculateDeliveryFee = (address) => {
  if (!address) return { fee: DEFAULT_FEE, zone: "Outside Lagos" };
  const lower = address.toLowerCase();

  // If address doesn't contain "lagos", charge outside Lagos fee
  if (!lower.includes("lagos")) {
    return { fee: DEFAULT_FEE, zone: "Outside Lagos", zoneNumber: 6 };
  }

  // Check zones by keyword
  for (const zone of DELIVERY_ZONES) {
    if (zone.areas.some(area => lower.includes(area))) {
      return { fee: zone.fee, zone: zone.name, zoneNumber: zone.zone };
    }
  }

  // Address contains Lagos but no specific zone match - charge Zone 2 (Mainland) as default
  return { fee: 3500, zone: "Lagos (Mainland)", zoneNumber: 2 };
};

app.post("/api/delivery-fee", async (req, res) => {
  try {
    const { address, orderTotal } = req.body;
    if (!address) return res.status(400).json({ error: "Address is required" });
    const result = calculateDeliveryFee(address);
    const isFreeDelivery = orderTotal >= FREE_DELIVERY_THRESHOLD;
    res.json({
      fee: isFreeDelivery ? 0 : result.fee,
      originalFee: result.fee,
      zone: result.zone,
      zoneNumber: result.zoneNumber,
      freeDelivery: isFreeDelivery,
      freeDeliveryThreshold: FREE_DELIVERY_THRESHOLD,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to calculate delivery fee" });
  }
});



/* ===========================
   POD ELIGIBILITY & DEPOSIT
=========================== */

// Check if customer is eligible for POD
app.get("/api/orders/pod-eligibility", auth, async (req, res) => {
  try {
    const completedOrders = await Order.countDocuments({
      email: req.user.email,
      status: { $in: ["Paid", "Delivered", "Shipped"] }
    });
    res.json({ eligible: completedOrders > 0, completedOrders });
  } catch (err) {
    res.status(500).json({ error: "Failed to check eligibility" });
  }
});

// Initialize Paystack payment for delivery deposit
app.post("/api/orders/pod-deposit", auth, async (req, res) => {
  try {
    const { deliveryFee, deliveryZone, cart, deliveryAddress, phone, couponCode, walletDebit } = req.body;
    const { email } = req.user;

    if (!deliveryFee || deliveryFee <= 0) {
      return res.status(400).json({ error: "Please enter your delivery address first to calculate delivery fee" });
    }

    // Check eligibility
    const completedOrders = await Order.countDocuments({
      email,
      status: { $in: ["Paid", "Delivered", "Shipped"] }
    });
    if (completedOrders === 0) {
      return res.status(403).json({ error: "Pay on Delivery is only available for returning customers" });
    }

    const reference = "POD-DEP-" + Date.now();

    // Store pending POD order data in a temp reference
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: deliveryFee * 100,
        reference,
        callback_url: `${process.env.FRONTEND_URL}/success?pod=true&reference=${reference}`,
        metadata: {
          isPodDeposit: true,
          cart: JSON.stringify(cart),
          deliveryAddress,
          phone,
          couponCode: couponCode || "",
          walletDebit: walletDebit || 0,
          deliveryFee,
          deliveryZone: deliveryZone || "",
        }
      },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    res.json({ url: response.data.data.authorization_url, reference });
  } catch (err) {
    console.error("POD deposit error:", err.message);
    res.status(500).json({ error: "Failed to initialize deposit payment" });
  }
});


// Send Paystack payment link for POD order (admin)
app.post("/api/admin/orders/:id/send-payment-link", adminOnly, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.status !== "Pay on Delivery") return res.status(400).json({ error: "Order is not a POD order" });

    const reference = "POD-PAY-" + Date.now();
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: order.email,
        amount: Math.round(order.amount * 100),
        reference,
        callback_url: `${process.env.FRONTEND_URL}/success?reference=${reference}`,
        metadata: { orderId: order._id.toString(), isPodPayment: true }
      },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    const paymentUrl = response.data.data.authorization_url;

    // Update order with payment reference
    await Order.findByIdAndUpdate(req.params.id, { podPaymentReference: reference });

    res.json({ success: true, paymentUrl, reference });
  } catch (err) {
    console.error("Send payment link error:", err.message);
    res.status(500).json({ error: "Failed to generate payment link" });
  }
});

/* ===========================
   PAY ON DELIVERY
=========================== */
app.post("/api/orders/pay-on-delivery", auth, async (req, res) => {
  try {
    const { cart, deliveryAddress, phone, couponCode, walletDebit, deliveryFee, deliveryZone } = req.body;
    const { email } = req.user;

    if (!cart || cart.length === 0) return res.status(400).json({ error: "Cart is empty" });
    if (!deliveryAddress) return res.status(400).json({ error: "Delivery address is required" });
    if (!phone) return res.status(400).json({ error: "Phone number is required" });

    let amount = cart.reduce((sum, item) => sum + (item.price * (item.quantity || 1)), 0);
    let appliedCoupon = null;

    if (couponCode) {
      const coupon = await Coupon.findOne({ code: couponCode.toUpperCase(), active: true });
      if (coupon && (!coupon.expiresAt || new Date() <= coupon.expiresAt) && amount >= coupon.minOrder) {
        const discount = coupon.type === "percent"
          ? Math.round((coupon.value / 100) * amount)
          : Math.min(coupon.value, amount);
        amount = amount - discount;
        appliedCoupon = couponCode.toUpperCase();
      }
    }

    let appliedWalletDebit = 0;
    if (walletDebit && walletDebit > 0) {
      const buyer = await User.findOne({ email });
      if (buyer && buyer.walletBalance >= walletDebit) {
        appliedWalletDebit = Math.min(walletDebit, amount);
        amount = Math.max(0, amount - appliedWalletDebit);
        await User.findOneAndUpdate({ email }, {
          $inc: { walletBalance: -appliedWalletDebit },
          $push: { walletTransactions: { type: "debit", amount: appliedWalletDebit, description: "Wallet payment for POD order", reference: "POD-" + Date.now() } }
        });
      }
    }

    const totalWithDelivery = amount + (deliveryFee || 0);
    const allocatedItems = [];
    for (const item of cart) {
      const updatedProduct = await Product.findOneAndUpdate(
        { _id: item._id || item.productId, stock: { $gte: item.quantity || 1 } },
        { $inc: { stock: -(item.quantity || 1) } },
        { new: true }
      );
      if (!updatedProduct) {
        for (const r of allocatedItems) {
          await Product.findByIdAndUpdate(r.productId, { $inc: { stock: r.quantity } });
        }
        return res.status(400).json({ error: `"${item.name}" is out of stock` });
      }
      allocatedItems.push({ productId: item._id || item.productId, quantity: item.quantity || 1 });
      if (updatedProduct.stock <= 5) sendLowStockAlert(updatedProduct).catch(() => {});
    }

    const reference = "POD-" + Date.now();
    const order = await Order.create({
      email, items: cart, amount: totalWithDelivery, originalAmount: totalWithDelivery,
      couponCode: appliedCoupon, walletDebit: appliedWalletDebit,
      deliveryFee: deliveryFee || 0, deliveryZone: deliveryZone || "",
      reference, status: "Pay on Delivery", deliveryAddress, phone,
      paymentMethod: "Pay on Delivery",
    });

    try { await sendOrderConfirmation(order); } catch (e) {}
    try { await sendAdminOrderNotification(order); } catch (e) {}

    try {
      const buyer = await User.findOne({ email });
      if (buyer) {
        const cashback = Math.round((CASHBACK_PERCENT / 100) * totalWithDelivery);
        if (cashback > 0) {
          buyer.walletBalance = (buyer.walletBalance || 0) + cashback;
          buyer.walletTransactions.push({ type: "credit", amount: cashback, description: `${CASHBACK_PERCENT}% cashback on POD order ${reference}`, reference });
          await buyer.save();
        }
      }
    } catch (e) {}

    res.status(201).json({ success: true, reference, message: "Order placed! Pay cash when your item arrives." });
  } catch (err) {
    res.status(500).json({ error: "Failed to place order" });
  }
});

/* ===========================
   WALLET ENDPOINTS
=========================== */

// Get wallet balance and transactions
app.get("/api/wallet", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("walletBalance walletTransactions name email");
    res.json({ balance: user.walletBalance || 0, transactions: user.walletTransactions || [] });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch wallet" });
  }
});

// Apply wallet balance at checkout (validate how much to use)
app.post("/api/wallet/apply", auth, async (req, res) => {
  try {
    const { amount } = req.body;
    const user = await User.findById(req.user.id);
    const available = user.walletBalance || 0;
    const toUse = Math.min(amount, available);
    res.json({ success: true, walletDebit: toUse, remaining: available - toUse });
  } catch (err) {
    res.status(500).json({ error: "Failed to apply wallet" });
  }
});

// Admin - get all wallets
app.get("/api/admin/wallets", adminOnly, async (req, res) => {
  try {
    const users = await User.find({ walletBalance: { $gt: 0 } }).select("name email walletBalance walletTransactions").sort({ walletBalance: -1 });
    const totalInCirculation = users.reduce((sum, u) => sum + (u.walletBalance || 0), 0);
    res.json({ users, totalInCirculation });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch wallets" });
  }
});

// Admin - manually credit/debit wallet
app.post("/api/admin/wallets/:userId", adminOnly, async (req, res) => {
  try {
    const { type, amount, description } = req.body;
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (type === "credit") {
      user.walletBalance = (user.walletBalance || 0) + Number(amount);
    } else {
      user.walletBalance = Math.max(0, (user.walletBalance || 0) - Number(amount));
    }
    user.walletTransactions.push({ type, amount: Number(amount), description: description || "Admin adjustment", reference: "ADMIN-" + Date.now() });
    await user.save();
    res.json({ success: true, newBalance: user.walletBalance });
  } catch (err) {
    res.status(500).json({ error: "Failed to update wallet" });
  }
});

/* ===========================
   SELLER ENDPOINTS
=========================== */

// Seller application
app.post("/api/seller/apply", async (req, res) => {
  try {
    const {
      name,
      password,
      phone,
      storeName,
      storeDescription,
      sellerType = "individual",
      businessLegalName,
      cacRegistrationNumber
    } = req.body;

    const email = req.body.email
      ? String(req.body.email).toLowerCase().trim()
      : "";

    if (!name || !email || !password || !storeName) {
      return res.status(400).json({
        error: "Name, email, password and store name are required"
      });
    }

    if (!["individual", "business"].includes(sellerType)) {
      return res.status(400).json({
        error: "Seller type must be individual or business"
      });
    }

    if (
      sellerType === "business" &&
      (!String(businessLegalName || "").trim() ||
       !String(cacRegistrationNumber || "").trim())
    ) {
      return res.status(400).json({
        error: "Registered businesses must provide their legal business name and CAC registration number"
      });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({
        error: "Password must be 8+ characters with uppercase, lowercase, number and special character."
      });
    }

    const existing = await Seller.findOne({ email });
    if (existing) {
      return res.status(400).json({
        error: "A seller account with this email already exists"
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const seller = await Seller.create({
      name: String(name).trim(),
      email,
      password: hashedPassword,
      phone: phone || "",
      storeName: String(storeName).trim(),
      storeDescription: storeDescription || "",
      sellerType,
      businessLegalName: sellerType === "business"
        ? String(businessLegalName).trim()
        : "",
      cacRegistrationNumber: sellerType === "business"
        ? String(cacRegistrationNumber).trim()
        : "",
      verification: {
        cac: {
          status: sellerType === "business"
            ? "pending"
            : "not_applicable"
        }
      }
    });

    res.status(201).json({
      success: true,
      message: "Application submitted! We will review and get back to you shortly.",
      sellerType: seller.sellerType,
      cacVerificationStatus: seller.verification.cac.status
    });
  } catch (err) {
    console.error("Seller application failed:", err.message);
    res.status(500).json({
      error: "Failed to submit application"
    });
  }
});

// Seller login
app.post("/api/seller/login", async (req, res) => {
  try {
    const { password } = req.body;
    const email = req.body.email ? String(req.body.email).toLowerCase().trim() : req.body.email;
    const seller = await Seller.findOne({ email });
    if (!seller) return res.status(400).json({ error: "Seller account not found" });
    const match = await bcrypt.compare(password, seller.password);
    if (!match) return res.status(400).json({ error: "Invalid password" });
    if (seller.status === "pending") return res.status(403).json({ error: "Your application is still under review" });
    if (seller.status === "rejected") return res.status(403).json({ error: "Your application was not approved" });
    const token = jwt.sign({ id: seller._id, role: "seller", storeName: seller.storeName }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ success: true, token, seller: { id: seller._id, name: seller.name, email: seller.email, storeName: seller.storeName, commission: seller.commission } });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

/* ===========================
   SELLER PASSWORD RESET
=========================== */

app.post("/api/seller/forgot-password", async (req,res)=>{
  try{

    const email = req.body.email
      ? String(req.body.email).toLowerCase().trim()
      : req.body.email;

    if(!email)
      return res.status(400).json({error:"Email is required"});

    const seller=await Seller.findOne({email});

    if(!seller){
      return res.json({
        success:true,
        message:"If that seller account exists, a reset code has been sent."
      });
    }

    // Generate a cryptographically secure 6-digit recovery code.
    // The code is valid for 15 minutes and is never logged.
    const token = randomInt(100000, 1000000).toString();
    const tokenHash = await bcrypt.hash(token, 10);

    seller.resetPasswordToken = tokenHash;
    seller.resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000);

    await seller.save();

    try{
      if(typeof sendPasswordResetEmail==="function"){
        await sendPasswordResetEmail(
          seller.email,
          token
        );
      }
    }catch(e){
      console.error(e.message);
    }

    res.json({
      success:true,
      message:"If that seller account exists, a reset code has been sent."
    });

  }catch(err){
    console.error(err);
    res.status(500).json({
      error:"Seller password reset failed"
    });
  }
});

app.post("/api/seller/reset-password", async (req,res)=>{

  try{

    const {email,token,newPassword}=req.body;
    const normalizedEmail = email
      ? String(email).toLowerCase().trim()
      : "";

    if(!normalizedEmail||!token||!newPassword){
      return res.status(400).json({
        error:"Email, token and password required"
      });
    }

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        error:"Password must be 8+ characters with uppercase, lowercase, number and special character."
      });
    }

    const seller=await Seller.findOne({
      email: normalizedEmail,
      resetPasswordExpires:{
        $gt:Date.now()
      }
    });

    if(!seller || !seller.resetPasswordToken){
      return res.status(400).json({
        error:"Invalid or expired reset code"
      });
    }

    const tokenValid = await bcrypt.compare(
      String(token).trim(),
      seller.resetPasswordToken
    );

    if(!tokenValid){
      return res.status(400).json({
        error:"Invalid or expired reset code"
      });
    }

    seller.password=await bcrypt.hash(newPassword,10);

    seller.resetPasswordToken=undefined;
    seller.resetPasswordExpires=undefined;

    await seller.save();

    res.json({
      success:true,
      message:"Seller password updated successfully."
    });

  }catch(err){

    console.error(err);

    res.status(500).json({
      error:"Password reset failed"
    });

  }

});



// Seller middleware
async function sellerAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });

  try {
    if (await tokenBlacklist.has(token)) {
      return res.status(401).json({ error: "Token has been invalidated. Please log in again." });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== "seller") return res.status(403).json({ error: "Seller access only" });
    req.seller = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};


// Seller bank details — provider verification is performed server-side
app.get("/api/seller/bank-details", sellerAuth, async (req, res) => {
  try {
    const seller = await Seller.findById(req.seller.id)
      .select("bankCode bankName accountNumber accountName verification.bank");

    if (!seller) {
      return res.status(404).json({ error: "Seller account not found" });
    }

    const accountNumber = String(seller.accountNumber || "");

    res.json({
      success: true,
      bank: seller.accountName ? {
        bankCode: seller.bankCode,
        bankName: seller.bankName,
        accountNumber: accountNumber.length === 10
          ? `******${accountNumber.slice(-4)}`
          : "",
        accountName: seller.accountName,
        verificationStatus: seller.verification?.bank?.status || "not_submitted"
      } : null
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load seller bank details" });
  }
});

app.post("/api/seller/bank-details", sellerAuth, async (req, res) => {
  try {
    const bankCode = String(req.body?.bankCode || "").trim();
    const bankName = String(req.body?.bankName || "").trim();
    const accountNumber = String(req.body?.accountNumber || "").trim();

    if (!bankCode || !bankName || !/^\d{10}$/.test(accountNumber)) {
      return res.status(400).json({
        error: "Select a bank and enter a valid 10-digit account number"
      });
    }

    const seller = await Seller.findById(req.seller.id);
    if (!seller) {
      return res.status(404).json({ error: "Seller account not found" });
    }

    let accountName = "";
    let providerReference = "";

    if (process.env.FLUTTERWAVE_SECRET_KEY) {
      const response = await axios.post(
        "https://api.flutterwave.com/v3/accounts/resolve",
        {
          account_number: accountNumber,
          account_bank: bankCode
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`
          }
        }
      );

      accountName = String(response.data?.data?.account_name || "").trim();
      providerReference = String(
        response.data?.data?.reference || response.data?.reference || ""
      );

      if (response.data?.status !== "success" || !accountName) {
        return res.status(422).json({ error: "Bank account verification failed" });
      }
    } else if (process.env.PAYSTACK_SECRET_KEY) {
      const response = await axios.get(
        "https://api.paystack.co/bank/resolve",
        {
          params: {
            account_number: accountNumber,
            bank_code: bankCode
          },
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
          }
        }
      );

      accountName = String(response.data?.data?.account_name || "").trim();
      providerReference = String(
        response.data?.data?.reference || response.data?.reference || ""
      );

      if (response.data?.status !== true || !accountName) {
        return res.status(422).json({ error: "Bank account verification failed" });
      }
    } else {
      return res.status(503).json({
        error: "Bank verification provider is not configured"
      });
    }

    seller.bankCode = bankCode;
    seller.bankName = bankName;
    seller.accountNumber = accountNumber;
    seller.accountName = accountName;

    seller.set("verification.bank.status", "verified");
    seller.set("verification.bank.verifiedAccountName", accountName);
    seller.set("verification.bank.providerReference", providerReference);
    seller.set("verification.bank.verifiedAt", new Date());

    await seller.save();

    res.json({
      success: true,
      message: "Bank account verified and saved successfully",
      bank: {
        bankCode,
        bankName,
        accountNumber: `******${accountNumber.slice(-4)}`,
        accountName,
        verificationStatus: "verified"
      }
    });
  } catch (err) {
    console.error(
      "Seller bank verification error:",
      err.response?.data?.message || err.message
    );
    res.status(502).json({
      error: "Could not verify bank account. Check the details and try again."
    });
  }
});

// Get seller dashboard stats
app.get("/api/seller/dashboard", sellerAuth, async (req, res) => {
  try {
    const seller = await Seller.findById(req.seller.id).select("-password");
    const products = await Product.find({ vendorId: req.seller.id });
    const orders = await Order.find({ "items.vendorId": req.seller.id, status: { $in: ["Paid", "Shipped", "Delivered"] } });
    const revenue = orders.reduce((sum, o) => {
      const sellerItems = o.items.filter(i => i.vendorId === req.seller.id.toString());
      return sum + sellerItems.reduce((s, i) => s + (i.price * (i.quantity || 1)), 0);
    }, 0);
    res.json({ seller, products, totalProducts: products.length, totalOrders: orders.length, revenue });
  } catch (err) {
    res.status(500).json({ error: "Failed to load dashboard" });
  }
});

// Seller add product
app.post("/api/seller/products", sellerAuth, adminUploader.array("images", 5), async (req, res) => {
  try {
    let imageUrls = [];

    if (req.body.images) {
      if (Array.isArray(req.body.images)) {
        imageUrls = req.body.images;
      } else {
        try {
          imageUrls = JSON.parse(req.body.images);
        } catch {
          imageUrls = [req.body.images];
        }
      }
    }

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        if (file.path && file.path.startsWith("http")) {
          imageUrls.push(file.path);
        } else {
          const result = await cloudinaryCloud.uploader.upload(file.path, {
            folder: "techmart_products",
            transformation: [
              { width: 800, height: 800, crop: "limit" },
              { quality: "auto" }
            ]
          });
          imageUrls.push(result.secure_url);
        }
      }
    }

    let variants = [];

    if (req.body.variants) {
      try {
        const parsedVariants =
          typeof req.body.variants === "string"
            ? JSON.parse(req.body.variants)
            : req.body.variants;

        if (!Array.isArray(parsedVariants)) {
          return res.status(400).json({
            success: false,
            error: "Variants must be an array"
          });
        }

        variants = parsedVariants.map((variant) => ({
          name: String(variant.name || ""),
          color: String(variant.color || ""),
          size: String(variant.size || ""),
          storage: String(variant.storage || ""),
          ram: String(variant.ram || ""),
          battery: String(variant.battery || ""),
          grade: String(variant.grade || ""),
          workingStatus: String(variant.workingStatus || ""),
          condition: String(variant.condition || "New"),
          price: Number(variant.price || 0),
          stock: Number(variant.stock || 0)
        }));
      } catch {
        return res.status(400).json({
          success: false,
          error: "Invalid variants data"
        });
      }
    }

    const firstVariant = variants[0] || {};

    const product = await Product.create({
      name: req.body.name,
      price: Number(req.body.price),
      description: req.body.description,
      stock: Number(req.body.stock),
      category: req.body.category || "",
      images: imageUrls,
      condition: req.body.condition || firstVariant.condition || "New",
      storage: req.body.storage || firstVariant.storage || "",
      ram: req.body.ram || firstVariant.ram || "",
      battery: req.body.battery || firstVariant.battery || "",
      grade: req.body.grade || firstVariant.grade || "",
      workingStatus: req.body.workingStatus || firstVariant.workingStatus || "",
      variants,
      vendorId: req.seller.id,
      vendorName: req.seller.storeName
    });

    res.status(201).json({
      success: true,
      message: "Product created successfully",
      data: product
    });

  } catch (err) {
    console.error("Seller product create:", err);
    res.status(500).json({
      success: false,
      error: "Failed to add product"
    });
  }
});

// Seller update product
app.put("/api/seller/products/:id", sellerAuth, adminUploader.array("images", 5), async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, vendorId: req.seller.id });
    if (!product) return res.status(404).json({ error: "Product not found" });

    const updates = {
      name: req.body.name || product.name,
      price: req.body.price ? Number(req.body.price) : product.price,
      description: req.body.description || product.description,
      stock: req.body.stock !== undefined ? Number(req.body.stock) : product.stock,
      category: req.body.category || product.category,
    };

    // Upload new images if provided
    if (req.files && req.files.length > 0) {
      const imageUrls = [];
      for (const file of req.files) {
        const result = await cloudinaryCloud.uploader.upload(file.path, {
          folder: "techmart_products",
          transformation: [{ width: 800, height: 800, crop: "limit" }, { quality: "auto" }]
        });
        imageUrls.push(result.secure_url);
      }
      updates.images = imageUrls;
    }

    // Keep existing images if new ones sent as JSON string
    if (req.body.existingImages) {
      try {
        const existing = JSON.parse(req.body.existingImages);
        updates.images = updates.images ? [...existing, ...updates.images] : existing;
      } catch {}
    }

    const updated = await Product.findByIdAndUpdate(req.params.id, updates, { new: true });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error("Product update error:", err.message);
    res.status(500).json({ error: "Failed to update product" });
  }
});

// Seller get their products
app.get("/api/seller/products", sellerAuth, async (req, res) => {
  try {
    const products = await Product.find({ vendorId: req.seller.id });
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// Seller delete product
app.delete("/api/seller/products/:id", sellerAuth, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, vendorId: req.seller.id });
    if (!product) return res.status(404).json({ error: "Product not found" });
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete product" });
  }
});

// Admin - get all sellers
app.get("/api/admin/sellers", adminOnly, async (req, res) => {
  try {
    const sellers = await Seller.find().select("-password").sort({ createdAt: -1 });
    res.json(sellers);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sellers" });
  }
});

// Admin - approve/reject seller while keeping verification badge in sync
app.put("/api/admin/sellers/:id", adminOnly, async (req, res) => {
  try {
    const { status } = req.body;
    if (!["pending", "approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Invalid seller status" });
    }

    const seller = await Seller.findById(req.params.id);
    if (!seller) {
      return res.status(404).json({ error: "Seller not found" });
    }

    seller.status = status;

    // Seller approval and TechMart Verified are separate:
    // approval permits selling; the badge requires every applicable check.
    const summary = getSellerVerificationSummary(seller);
    seller.verified = summary.eligible;
    seller.techmartVerifiedAt = summary.eligible
      ? (seller.techmartVerifiedAt || new Date())
      : null;
    seller.verificationLevel = summary.eligible ? "seller" : "none";

    await seller.save();

    const data = seller.toObject();
    delete data.password;

    res.json({
      success: true,
      data,
      verificationSummary: getSellerVerificationSummary(seller)
    });
  } catch (err) {
    console.error("Seller approval update failed:", err.message);
    res.status(500).json({ error: "Failed to update seller" });
  }
});

// Admin - delete seller
app.delete("/api/admin/sellers/:id", adminOnly, async (req, res) => {
  try {
    await Seller.findByIdAndDelete(req.params.id);
    await Product.deleteMany({ vendorId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete seller" });
  }
});

app.post("/api/paystack/init", auth, async (req, res) => {
  const reference = "TX-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const allocatedItems = [];
  let buyer = null;
  let appliedWalletDebit = 0;
  let walletDebited = false;
  let orderCreated = false;

  const fail = (message, statusCode = 400) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    throw error;
  };

  try {
    const {
      cart,
      deliveryAddress,
      phone,
      couponCode,
      walletDebit
    } = req.body || {};

    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: "Your cart is empty or invalid." });
    }

    if (!deliveryAddress || !String(deliveryAddress).trim()) {
      return res.status(400).json({ error: "Delivery address is required." });
    }

    if (!phone || !String(phone).trim()) {
      return res.status(400).json({ error: "Phone number is required." });
    }

    buyer = await User.findById(req.user.id);
    if (!buyer) return res.status(401).json({ error: "Buyer account not found." });

    const variantFields = [
      "name", "color", "size", "storage", "ram",
      "battery", "grade", "workingStatus", "condition"
    ];

    const validatedItems = [];
    let subtotal = 0;

    // Fetch authoritative products, prices and variant details.
    for (const item of cart) {
      const productId = item.productId || item._id;
      const quantity = Number(item.quantity ?? 1);

      if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
        fail("A cart item has an invalid product ID.");
      }

      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
        fail("Invalid product quantity.");
      }

      const product = await Product.findById(productId).lean();

      if (!product) {
        fail("A product in your cart is no longer available.", 409);
      }

      let variant = null;
      let variantMatch = null;

      if (product.variants && product.variants.length > 0) {
        const selected = item.selectedVariant;

        if (!selected) {
          fail(`Please select a variant for "${product.name}".`);
        }

        const suppliedFields = variantFields.filter(
          field => selected[field] !== undefined &&
            selected[field] !== null &&
            String(selected[field]).trim() !== ""
        );

        variant = product.variants.find(candidate => {
          if (selected._id) {
            return String(candidate._id) === String(selected._id);
          }

          return suppliedFields.length > 0 &&
            suppliedFields.every(
              field => String(candidate[field] ?? "").trim() ===
                String(selected[field]).trim()
            );
        });

        if (!variant) {
          fail(`The selected variant for "${product.name}" is no longer available.`, 409);
        }

        variantMatch = variant._id
          ? { _id: variant._id }
          : Object.fromEntries(
              suppliedFields.map(field => [field, variant[field]])
            );
      }

      const unitPrice = variant && Number(variant.price) > 0
        ? Number(variant.price)
        : Number(product.price);

      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        fail(`Invalid price for "${product.name}".`);
      }

      const lineTotal = unitPrice * quantity;
      subtotal += lineTotal;

      validatedItems.push({
        _id: String(product._id),
        productId: String(product._id),
        name: product.name,
        price: unitPrice,
        quantity,
        image: product.images?.[0] || item.image || "",
        images: product.images || [],
        vendorId: product.vendorId || "",
        vendorName: product.vendorName || "",
        ...(variant ? {
          selectedVariant: {
            ...(variant._id ? { _id: String(variant._id) } : {}),
            ...Object.fromEntries(
              variantFields.map(field => [field, variant[field] ?? ""])
            ),
            price: Number(variant.price) || unitPrice
          }
        } : {})
      });

      validatedItems[validatedItems.length - 1]._stockReservation = {
        productId: String(product._id),
        quantity,
        variantMatch
      };
    }

    // Revalidate coupon against the database-calculated subtotal.
    let discount = 0;
    let appliedCoupon = null;

    if (couponCode) {
      const normalizedCode = String(couponCode).trim().toUpperCase();
      const coupon = await Coupon.findOne({
        code: normalizedCode,
        active: true
      });

      if (!coupon) fail("This coupon is invalid or inactive.");

      if (coupon.expiresAt && new Date() > new Date(coupon.expiresAt)) {
        fail("This coupon has expired.");
      }

      if (subtotal < (Number(coupon.minOrder) || 0)) {
        fail("Your order does not meet this coupon's minimum spend.");
      }

      discount = coupon.type === "percent"
        ? Math.min(subtotal, Math.round((Number(coupon.value) / 100) * subtotal))
        : Math.min(subtotal, Number(coupon.value) || 0);

      appliedCoupon = normalizedCode;
    }

    // Calculate delivery on the server. The free-delivery threshold
    // uses the product subtotal, before coupon deductions.
    const delivery = calculateDeliveryFee(String(deliveryAddress).trim());
    const deliveryFee = subtotal >= FREE_DELIVERY_THRESHOLD ? 0 : delivery.fee;
    const deliveryZone = delivery.zone;

    const amountBeforeWallet = Math.max(0, subtotal - discount + deliveryFee);
    const requestedWalletDebit = Number(walletDebit || 0);

    if (!Number.isFinite(requestedWalletDebit) || requestedWalletDebit < 0) {
      fail("Invalid wallet payment amount.");
    }

    appliedWalletDebit = Math.min(
      requestedWalletDebit,
      Math.max(0, Number(buyer.walletBalance) || 0),
      amountBeforeWallet
    );

    const finalAmount = Math.max(0, amountBeforeWallet - appliedWalletDebit);

    // Atomically reserve parent or selected-variant stock.
    for (const item of validatedItems) {
      const reservation = item._stockReservation;
      let updatedProduct;

      if (reservation.variantMatch) {
        updatedProduct = await Product.findOneAndUpdate(
          {
            _id: reservation.productId,
            variants: {
              $elemMatch: {
                ...reservation.variantMatch,
                stock: { $gte: reservation.quantity }
              }
            }
          },
          {
            $inc: {
              "variants.$.stock": -reservation.quantity
            }
          },
          { new: true }
        );
      } else {
        updatedProduct = await Product.findOneAndUpdate(
          {
            _id: reservation.productId,
            stock: { $gte: reservation.quantity }
          },
          {
            $inc: { stock: -reservation.quantity }
          },
          { new: true }
        );
      }

      if (!updatedProduct) {
        fail(`"${item.name}" has insufficient stock. Please update your cart.`, 409);
      }

      allocatedItems.push(reservation);

      if (!reservation.variantMatch && updatedProduct.stock <= 5) {
        sendLowStockAlert(updatedProduct).catch(error =>
          console.error("Low stock alert failed:", error.message)
        );
      }
    }

    // Debit the wallet with a balance condition to prevent overspending.
    if (appliedWalletDebit > 0) {
      const debitedBuyer = await User.findOneAndUpdate(
        {
          _id: buyer._id,
          walletBalance: { $gte: appliedWalletDebit }
        },
        {
          $inc: { walletBalance: -appliedWalletDebit },
          $push: {
            walletTransactions: {
              type: "debit",
              amount: appliedWalletDebit,
              description: `Wallet payment for order ${reference}`,
              reference
            }
          }
        },
        { new: true }
      );

      if (!debitedBuyer) {
        fail("Your wallet balance changed. Please try checkout again.", 409);
      }

      walletDebited = true;
    }

    // Never store client-submitted prices or delivery charges.
    const orderItems = validatedItems.map(({ _stockReservation, ...item }) => item);

    await Order.create({
      email: buyer.email,
      items: orderItems,
      amount: finalAmount,
      originalAmount: subtotal + deliveryFee,
      couponCode: appliedCoupon,
      walletDebit: appliedWalletDebit,
      deliveryFee,
      deliveryZone,
      reference,
      status: "Pending",
      deliveryAddress: String(deliveryAddress).trim(),
      phone: String(phone).trim()
    });

    orderCreated = true;

    // A wallet-only checkout needs no Paystack transaction.
    if (finalAmount === 0) {
      await Order.findOneAndUpdate(
        { reference, status: "Pending" },
        { $set: { status: "Paid", paymentMethod: "TechMart Wallet" } }
      );

      const frontendUrl = (
        process.env.FRONTEND_URL || "https://techmart-frontend.onrender.com"
      ).replace(/\/$/, "");

      return res.json({
        url: `${frontendUrl}/success?reference=${encodeURIComponent(reference)}`
      });
    }

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: buyer.email,
        amount: Math.round(finalAmount * 100),
        reference,
        callback_url: `${process.env.FRONTEND_URL}/success`
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const authorizationUrl = response.data?.data?.authorization_url;

    if (!authorizationUrl) {
      throw new Error("Paystack did not return a payment authorization URL.");
    }

    return res.json({ url: authorizationUrl });

  } catch (err) {
    console.error("PAYSTACK CHECKOUT ERROR:", err.response?.data || err.message);

    // Restore stock reservations in reverse order.
    for (const reservation of allocatedItems.reverse()) {
      try {
        if (reservation.variantMatch) {
          await Product.findOneAndUpdate(
            {
              _id: reservation.productId,
              variants: { $elemMatch: reservation.variantMatch }
            },
            {
              $inc: {
                "variants.$.stock": reservation.quantity
              }
            }
          );
        } else {
          await Product.findByIdAndUpdate(
            reservation.productId,
            { $inc: { stock: reservation.quantity } }
          );
        }
      } catch (rollbackError) {
        console.error("Stock rollback failed:", rollbackError.message);
      }
    }

    // Refund wallet funds if the debit succeeded.
    if (walletDebited && buyer) {
      try {
        await User.findByIdAndUpdate(buyer._id, {
          $inc: { walletBalance: appliedWalletDebit },
          $push: {
            walletTransactions: {
              type: "credit",
              amount: appliedWalletDebit,
              description: "Wallet refund after failed Paystack initialization",
              reference: `REFUND-${reference}`
            }
          }
        });
      } catch (refundError) {
        console.error("Wallet refund failed:", refundError.message);
      }
    }

    if (orderCreated) {
      try {
        await Order.deleteOne({ reference, status: "Pending" });
      } catch (deleteError) {
        console.error("Pending order cleanup failed:", deleteError.message);
      }
    }

    return res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Payment setup failed. Please try again."
    });
  }
});

app.post("/api/paystack/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    // 1. VERIFY SIGNATURE
    const hash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      console.log("❌ Invalid webhook signature");
      return res.status(401).send("Invalid signature");
    }

    const event = JSON.parse(req.body.toString("utf8"));

    console.log("📩 Paystack webhook:", {
      event: event.event,
      reference: event.data?.reference
    });

    // Seller payout transfer events: manual and automatic.
    if (["transfer.success", "transfer.failed", "transfer.reversed"].includes(event.event)) {
      const reference = event.data?.reference;

      if (!reference) {
        console.warn("Paystack transfer webhook missing reference");
        return res.status(200).send("Transfer reference missing");
      }

      const payout = await Payout.findOne({ reference });

      if (!payout) {
        console.log(`No seller payout found for transfer: ${reference}`);
        return res.status(200).send("Transfer payout not found");
      }

      if (event.event === "transfer.success") {
        const updated = await Payout.findOneAndUpdate(
          {
            _id: payout._id,
            transferStatus: { $in: ["pending", "processing"] },
            status: { $in: ["pending", "approved"] }
          },
          {
            $set: {
              transferStatus: "success",
              status: "paid",
              fundsReserved: false,
              transferCode: event.data?.transfer_code || payout.transferCode,
              transferId: event.data?.id ? String(event.data.id) : payout.transferId,
              processedAt: new Date(),
              note: "Paystack transfer confirmed successful"
            }
          },
          { new: true }
        );

        console.log(updated
          ? `Seller payout confirmed successful: ${reference}`
          : `Duplicate or terminal success webhook ignored: ${reference}`);
        return res.status(200).send("Transfer success processed");
      }

      const session = await mongoose.startSession();

      try {
        await session.withTransaction(async () => {
          const current = await Payout.findById(payout._id).session(session);
          if (!current || ["success", "failed", "reversed"].includes(current.transferStatus)) return;

          const seller = await Seller.findById(current.sellerId).session(session);
          if (!seller) throw new Error(`Seller not found for payout ${reference}`);

          const hasLegacyAutoReservation =
            current.payoutType === "auto_weekly" &&
            (seller.walletTransactions || []).some(transaction =>
              transaction.reference === reference &&
              transaction.type === "debit" &&
              Number(transaction.amount) === Number(current.amount)
            );

          if (current.fundsReserved === true || hasLegacyAutoReservation) {
            const refundReference = `REFUND-${reference}`;
            const alreadyRefunded = (seller.walletTransactions || []).some(
              transaction => transaction.reference === refundReference
            );

            if (!alreadyRefunded) {
              seller.walletBalance = Number(seller.walletBalance || 0) + current.amount;
              seller.walletTransactions = seller.walletTransactions || [];
              seller.walletTransactions.push({
                type: "credit",
                amount: current.amount,
                description: `Failed payout returned — ${reference}`,
                reference: refundReference
              });
              await seller.save({ session });
            }

            current.fundsReserved = false;
          }

          current.transferStatus = event.event === "transfer.reversed" ? "reversed" : "failed";
          current.status = "rejected";
          current.processedAt = new Date();
          current.transferCode = event.data?.transfer_code || current.transferCode;
          current.transferId = event.data?.id ? String(event.data.id) : current.transferId;
          current.note = event.event === "transfer.reversed"
            ? "Paystack transfer reversed; reserved funds returned where applicable"
            : "Paystack transfer failed; reserved funds returned where applicable";

          await current.save({ session });
        });
      } finally {
        await session.endSession();
      }

      console.log(`Seller payout failure processed: ${reference}`);
      return res.status(200).send("Transfer failure processed");
    }

    if (!event || event.event !== "charge.success") {
      return res.status(200).send("Event ignored");
    }

    const reference = event.data.reference;

    // 2. VERIFY WITH PAYSTACK API
    const verify = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const paymentData = verify.data.data;

    // Handle Wallet Funding
    if (paymentData.metadata?.purpose === "wallet_funding") {
      try {
        const amount = paymentData.amount / 100;
        const reference = paymentData.reference;

        const email = paymentData.customer?.email
          ?.toLowerCase()
          .trim();

        let user = null;

        if (paymentData.metadata?.userId) {
          user = await User.findById(paymentData.metadata.userId);
        }

        if (!user && email) {
          user = await User.findOne({ email });
        }

        if (!user) {
          console.error("❌ Wallet webhook: user not found", { reference, email });
          // Update webhook event status
          await WebhookEvent.findOneAndUpdate({ reference }, { status: "failed", metadata: { reason: "user_not_found", email } });
          return res.status(200).json({ status: "ignored" });
        }

        user.walletTransactions = user.walletTransactions || [];

        const alreadyCredited = user.walletTransactions.some(
          t => t.reference === reference
        );

        if (alreadyCredited) {
          console.log("ℹ️ Wallet already credited:", reference);
          return res.status(200).json({ status: "duplicate" });
        }

        user.walletBalance =
          (user.walletBalance || 0) + amount;

        user.walletTransactions.push({
          type: "credit",
          amount,
          description: "Wallet funded via Paystack",
          reference,
          createdAt: new Date(paymentData.paid_at)
        });

        await user.save();

        console.log(
          `✅ Wallet credited: ${user.email} +₦${amount}`
        );
      } catch (e) {
        console.error("Wallet funding webhook error:", e);
      }

      return res.status(200).json({ status: "success" });
    }

    // Handle POD full payment (sent by admin at door)
    if (paymentData.metadata?.isPodPayment) {
      try {
        const orderId = paymentData.metadata.orderId;

        // Only the first successful webhook may transition POD -> Paid.
        const order = await Order.findOneAndUpdate(
          {
            _id: orderId,
            status: "Pay on Delivery"
          },
          {
            $set: {
              status: "Paid",
              podPaymentReference: paymentData.reference
            }
          },
          { new: true }
        );

        if (!order) {
          console.log(`ℹ️ POD payment already processed or order not eligible: ${orderId}`);
          return res.status(200).json({ status: "duplicate" });
        }

        // Cashback is also protected by its transaction reference.
        const buyer = await User.findOne({ email: order.email });

        if (buyer) {
          buyer.walletTransactions = buyer.walletTransactions || [];

          const cashbackReference = `POD-CASHBACK-${order.reference}`;

          const alreadyCredited = buyer.walletTransactions.some(
            t => t.reference === cashbackReference
          );

          if (!alreadyCredited) {
            const cashback = Math.round(
              (CASHBACK_PERCENT / 100) * order.amount
            );

            if (cashback > 0) {
              buyer.walletBalance = (buyer.walletBalance || 0) + cashback;

              buyer.walletTransactions.push({
                type: "credit",
                amount: cashback,
                description: `${CASHBACK_PERCENT}% cashback on POD payment ${order.reference}`,
                reference: cashbackReference
              });

              await buyer.save();

              console.log(
                `💰 POD cashback credited: ${buyer.email} +₦${cashback}`
              );
            }
          } else {
            console.log(`ℹ️ POD cashback already credited: ${order.reference}`);
          }
        }

        console.log(`✅ POD order ${orderId} marked as Paid`);
      } catch(e) {
        console.error("POD payment webhook error:", e.message);
      }
      return res.status(200).json({ status: "success" });
    }

    // Handle POD deposit payment
if (paymentData.metadata?.isPodDeposit) {
  try {
    const meta = paymentData.metadata;
    const cart = JSON.parse(meta.cart || "[]");

    // Paystack references are unique.
    // Use the deposit reference as our idempotency key.
    const depositReference = paymentData.reference;
    const reference = "POD-" + depositReference;

    // Prevent duplicate orders when Paystack retries the webhook.
    const existingOrder = await Order.findOne({ depositReference });

    if (existingOrder) {
      console.log(
        `ℹ️ POD deposit already processed: ${depositReference}`
      );

      return res.status(200).json({
        status: "duplicate",
        orderId: existingOrder._id
      });
    }

    const amount = cart.reduce(
      (sum, item) =>
        sum +
        (Number(item.price) || 0) *
        (Number(item.quantity) || 1),
      0
    );

    const deliveryFee = Number(meta.deliveryFee || 0);

    const order = await Order.create({
      email: paymentData.customer?.email || "",
      items: cart,
      amount: amount + deliveryFee,
      originalAmount: amount + deliveryFee,
      deliveryFee,
      deliveryZone: meta.deliveryZone || "",
      depositPaid: deliveryFee,
      depositReference,
      reference,
      status: "Pay on Delivery",
      deliveryAddress: meta.deliveryAddress || "",
      phone: meta.phone || "",
      paymentMethod: "Pay on Delivery",
      couponCode: meta.couponCode || null,
      confirmationEmailSent: false,
      confirmationEmailSentAt: null,
      confirmationEmailError: ""
    });

    console.log(
      `✅ POD order created: ${order.reference}`
    );

    // Customer confirmation email
    try {
      await sendOrderConfirmation(order);

      await Order.findByIdAndUpdate(order._id, {
        confirmationEmailSent: true,
        confirmationEmailSentAt: new Date(),
        confirmationEmailError: ""
      });

      console.log(
        `📧 POD confirmation email sent to ${order.email}`
      );
    } catch (e) {
      await Order.findByIdAndUpdate(order._id, {
        confirmationEmailSent: false,
        confirmationEmailError: e.message
      });

      console.error(
        `❌ POD confirmation email failed for ${order.email}:`,
        e.message
      );
    }

    // Admin notification
    try {
      await sendAdminOrderNotification(order);
    } catch (e) {
      console.error(
        "❌ POD admin notification failed:",
        e.message
      );
    }

    // Cashback
    const buyer = await User.findOne({
      email: paymentData.customer?.email
    });

    if (buyer) {
      const cashback = Math.round(
        (CASHBACK_PERCENT / 100) * order.amount
      );

      if (cashback > 0) {
        buyer.walletBalance =
          (buyer.walletBalance || 0) + cashback;

        buyer.walletTransactions.push({
          type: "credit",
          amount: cashback,
          description: `Cashback on POD order ${reference}`,
          reference
        });

        await buyer.save();

        console.log(
          `💰 POD cashback credited: ${buyer.email} +₦${cashback}`
        );
      }
    }
  } catch (e) {
    console.error(
      "❌ POD deposit webhook error:",
      e.message
    );
  }

  return res.status(200).json({
    status: "success"
  });
}

if (paymentData.status !== "success") {
      console.log(`⚠️ Payment not successful for ${reference}: ${paymentData.status}`);
      return res.status(200).send("Payment not verified");
    }

    console.log(`✅ Payment verified for ${reference}`);

    // 3. UPDATE ORDER ONLY IF PENDING
    const order = await Order.findOneAndUpdate(
      { reference, status: "Pending" },
      { status: "Paid" },
      { new: true }
    );

    if (!order) {
      console.log(`ℹ️ Order ${reference} already processed or not found`);
      return res.status(200).send("Already processed");
    }

    console.log(`✅ Order ${order._id} marked as Paid`);

    // PAYMENT DEBUG
    console.log("========== PAYMENT DEBUG ==========");
    console.log("Reference:", reference);
    console.log("Paystack Status:", paymentData.status);
    console.log("Order Status Before Update:", order?.status);
    console.log("Order Email:", order?.email);
    console.log("==================================");

    // 4. SEND CONFIRMATION EMAIL
    try {
      await sendOrderConfirmation(order);
      console.log(`📧 Confirmation email sent to ${order.email}`);
    } catch (e) {
      console.error("❌ Email failed:", e.message);
    }
    // 5. NOTIFY ADMIN
    try {
      await sendAdminOrderNotification(order);
    } catch (e) {
      console.error("❌ Admin notification failed:", e.message);
    }
    // 6. CREDIT CASHBACK TO WALLET
    try {
      const buyer = await User.findOne({ email: order.email });
      if (buyer) {
        const cashback = Math.round((CASHBACK_PERCENT / 100) * order.amount);
        if (cashback > 0) {
          buyer.walletBalance = (buyer.walletBalance || 0) + cashback;
          buyer.walletTransactions.push({
            type: "credit",
            amount: cashback,
            description: `${CASHBACK_PERCENT}% cashback on order ${order.reference}`,
            reference: order.reference
          });
          await buyer.save();
          console.log(`Wallet: Credited N${cashback} cashback to ${buyer.email}`);
        }
      }
    } catch (e) {
      console.error("Cashback credit failed:", e.message);
    }

    // 5. NOTIFY FRONTEND
    if (io) {
      io.to(order.email).emit("paymentConfirmed", { reference, email: order.email });
    }

    return res.status(200).json({ status: "success" });

  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    return res.status(500).send("Webhook error");
  }
});

/* ===========================
   👑 ADMIN
=========================== */
app.get("/api/admin/stats", adminOnly, async (req, res) => {
  try {
    const orders = await Order.find();
    const users = await User.find();
    const revenue = orders
      .filter((o) => o.status !== "Cancelled" && o.status !== "Pending")
      .reduce((sum, o) => sum + (o.amount || 0), 0);
    res.json({ totalOrders: orders.length, totalUsers: users.length, totalRevenue: revenue });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

app.get("/api/admin/orders", adminOnly, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/* UPDATE ORDER STATUS */
app.put("/api/admin/orders/:id", adminOnly, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );

    // 📱 SEND ORDER STATUS SMS
    if (order && order.email) {
      try {
        const buyer = await User.findOne({ email: order.email });

        if (buyer && buyer.phone) {
          const { sendOrderUpdate } = require("./services/notificationService");

          await sendOrderUpdate(
            buyer.phone,
            buyer.name || "Customer",
            order._id.toString(),
            req.body.status
          );
        } else {
          console.log("⚠️ SMS skipped: Buyer phone not found for " + order.email);
        }
      } catch (smsError) {
        console.error("❌ SMS notification error:", smsError.message);
      }
    }

    // 📧 SEND ORDER STATUS EMAIL
    try {
      await sendShippingUpdate(order);
    } catch (e) {
      console.log("Order status email failed:", e.message);
    }

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update order" });
  }
});

app.get("/api/admin/users", adminOnly, async (req, res) => {
  try {
    const users = await User.find().select("-password").sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

app.get("/api/admin/analytics", adminOnly, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    const users = await User.find();
    const revenue = orders
      .filter((o) => o.status !== "Cancelled" && o.status !== "Pending")
      .reduce((sum, o) => sum + (o.amount || 0), 0);
    const revenueByDate = {};
    orders
      .filter((o) => o.status !== "Cancelled" && o.status !== "Pending")
      .forEach((o) => {
        const date = new Date(o.createdAt).toLocaleDateString("en-NG");
        revenueByDate[date] = (revenueByDate[date] || 0) + (o.amount || 0);
      });
    res.json({
      totalOrders: orders.length,
      totalUsers: users.length,
      totalRevenue: revenue,
      revenueByDate,
      recentOrders: orders.slice(0, 5),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

/* ===========================
   ⭐ REVIEWS
=========================== */

/* ADD REVIEW - verified buyers only */
app.post("/api/products/:id/review", auth, async (req, res) => {
  try {
    const { stars } = req.body;
    const comment = sanitize(req.body.comment);
    if (!comment || !stars) return res.status(400).json({ error: "Comment and stars required" });

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    const order = await Order.findOne({
      email: req.user.email,
      status: { $in: ["Paid", "Shipped", "Delivered"] },
    });
    const isVerified = !!order;

    const alreadyReviewed = product.reviews.find((r) => r.email === req.user.email);
    if (alreadyReviewed) return res.status(400).json({ error: "You already reviewed this product" });

    let sentiment = "neutral";
    try {
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const sentimentRes = await groq.chat.completions.create({
        model: "openai/gpt-oss-20b",
        messages: [
          {
            role: "system",
            content: `Analyze the sentiment of this product review and respond with ONLY one word: "positive", "negative", or "neutral". Nothing else.`
          },
          { role: "user", content: comment }
        ],
        max_tokens: 10,
        temperature: 0,
      });
      const raw = sentimentRes.choices[0]?.message?.content?.trim().toLowerCase();
      if (["positive", "negative", "neutral"].includes(raw)) sentiment = raw;
    } catch (err) {
      console.log("Sentiment analysis failed:", err.message);
    }

    const review = {
      user: req.user.email.split("@")[0],
      email: req.user.email,
      comment,
      stars: Number(stars),
      verified: isVerified,
      approved: false,
      flagged: false,
      sentiment,
      createdAt: new Date(),
    };

    product.reviews.push(review);

    const approvedReviews = product.reviews.filter((r) => r.approved);
    if (approvedReviews.length > 0) {
      product.rating = (
        approvedReviews.reduce((sum, r) => sum + r.stars, 0) / approvedReviews.length
      ).toFixed(1);
    }

    await product.save();
    res.json({ success: true, message: "Review submitted and pending approval" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to submit review" });
  }
});

/* GET PENDING REVIEWS - admin */
app.get("/api/admin/reviews/pending", adminOnly, async (req, res) => {
  try {
    const products = await Product.find({ "reviews.approved": false });
    const pending = [];
    products.forEach((p) => {
      p.reviews
        .filter((r) => !r.approved && !r.flagged)
        .forEach((r) => {
          pending.push({ ...r.toObject(), productId: p._id, productName: p.name });
        });
    });
    res.json(pending);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch pending reviews" });
  }
});

/* GET FLAGGED REVIEWS - admin */
app.get("/api/admin/reviews/flagged", adminOnly, async (req, res) => {
  try {
    const products = await Product.find({ "reviews.flagged": true });
    const flagged = [];
    products.forEach((p) => {
      p.reviews
        .filter((r) => r.flagged)
        .forEach((r) => {
          flagged.push({ ...r.toObject(), productId: p._id, productName: p.name });
        });
    });
    res.json(flagged);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch flagged reviews" });
  }
});

/* APPROVE REVIEW - admin */
app.put("/api/products/:id/review/:reviewId/approve", adminOnly, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    const review = product.reviews.id(req.params.reviewId);
    if (!review) return res.status(404).json({ error: "Review not found" });
    review.approved = true;
    review.flagged = false;
    const approvedReviews = product.reviews.filter((r) => r.approved);
    if (approvedReviews.length > 0) {
      product.rating = (
        approvedReviews.reduce((sum, r) => sum + r.stars, 0) / approvedReviews.length
      ).toFixed(1);
    }
    await product.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to approve review" });
  }
});

/* FLAG REVIEW */
app.put("/api/products/:id/review/:reviewId/flag", auth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    const review = product.reviews.id(req.params.reviewId);
    if (!review) return res.status(404).json({ error: "Review not found" });
    review.flagged = true;
    review.approved = false;
    await product.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to flag review" });
  }
});

/* DELETE REVIEW - admin */
app.delete("/api/products/:id/review/:reviewId", adminOnly, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    product.reviews = product.reviews.filter(
      (r) => r._id.toString() !== req.params.reviewId
    );
    await product.save();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete review" });
  }
});

/* GET SENTIMENT ANALYTICS - admin */
app.get("/api/admin/reviews/sentiment", adminOnly, async (req, res) => {
  try {
    const products = await Product.find();
    const stats = { positive: 0, negative: 0, neutral: 0, total: 0 };
    const productSentiments = [];

    products.forEach((p) => {
      const approved = p.reviews.filter((r) => r.approved);
      const pos = approved.filter((r) => r.sentiment === "positive").length;
      const neg = approved.filter((r) => r.sentiment === "negative").length;
      const neu = approved.filter((r) => r.sentiment === "neutral").length;

      stats.positive += pos;
      stats.negative += neg;
      stats.neutral += neu;
      stats.total += approved.length;

      if (approved.length > 0) {
        productSentiments.push({
          name: p.name,
          positive: pos,
          negative: neg,
          neutral: neu,
          total: approved.length,
          score: ((pos - neg) / approved.length * 100).toFixed(0),
        });
      }
    });

    productSentiments.sort((a, b) => b.score - a.score);
    res.json({ stats, productSentiments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch sentiment data" });
  }
});

/* ===========================
   📦 TRACKING
=========================== */
app.get("/api/orders/track/:reference", async (req, res) => {
  try {
    const order = await Order.findOne({ reference: req.params.reference });
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to track order" });
  }
});

app.get("/api/orders/my", auth, async (req, res) => {
  try {
    const orders = await Order.find({ email: req.user.email }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

app.put("/api/orders/:id/tracking", adminOnly, async (req, res) => {
  try {
    const { trackingNumber, status } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { trackingNumber, status },
      { new: true }
    );
    io.to(order.email).emit("orderUpdated", {
      orderId: order._id,
      reference: order.reference,
      status: order.status,
      trackingNumber: order.trackingNumber
    });
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update tracking" });
  }
});
/* ===========================
   🖼️ IMAGE UPLOAD
=========================== */
app.post("/api/upload", adminOnly, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image provided" });

    // Upload to Cloudinary
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          folder: "techmart/products",
          transformation: [
            { width: 800, height: 800, crop: "limit" },
            { quality: "auto" },
            { fetch_format: "auto" }
          ]
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      ).end(req.file.buffer);
    });

    res.json({
      success: true,
      url: result.secure_url,
      public_id: result.public_id,
    });

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Image upload failed" });
  }
});

/* ===========================
   MULTI-IMAGE UPLOAD
=========================== */
app.post("/api/admin/products/upload-images", adminOnly, adminUploader.array("images", 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No images provided" });
    const urls = [];
    for (const file of req.files) {
      const result = await cloudinaryCloud.uploader.upload(file.path, {
        folder: "techmart_products",
        transformation: [
          { width: 800, height: 800, crop: "limit" },
          { quality: "auto" },
          { fetch_format: "auto" }
        ]
      });
      urls.push(result.secure_url);
    }
    res.json({ success: true, urls });
  } catch (err) {
    console.error("Multi-upload error:", err);
    res.status(500).json({ error: "Image upload failed" });
  }
});

/* ===========================
   ⚡ SOCKET.IO
=========================== */
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});

io.on("connection", (socket) => {
  console.log("⚡ Connected:", socket.id);
  // Client joins a private room keyed by their email so order updates
  // are only delivered to that customer, never broadcast to everyone.
  socket.on("join", (email) => {
    if (email && typeof email === "string") {
      socket.join(email.toLowerCase().trim());
    }
  });
  socket.on("disconnect", () => {
    console.log("❌ Disconnected:", socket.id);
  });
});

// (old generic error handler removed — see global handler at end of file)

/* ===========================
   🏓 KEEP ALIVE
=========================== */
setInterval(() => {
  fetch("https://techmart-backend-ecbi.onrender.com/")
    .then(() => console.log("🏓 Keep alive ping"))
    .catch(() => console.log("⚠️ Ping failed"));
}, 14 * 60 * 1000);

/* ===========================
   🚀 START SERVER
=========================== */
const PORT = process.env.PORT || 5002;


/* ===========================
   🛡️ FRAUD ADMIN ENDPOINTS
=========================== */
// Get all flagged users
app.get("/api/admin/fraud/flagged", adminOnly, async (req, res) => {
  try {
    const flagged = await User.find({ isFlagged: true })
      .select("name email fraudScore fraudFlags isFlagged createdAt walletBalance")
      .sort({ fraudScore: -1 });
    res.json(flagged);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch flagged users" });
  }
});

// Clear fraud flag on a user
app.post("/api/admin/fraud/clear/:userId", adminOnly, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.userId, {
      $set: { isFlagged: false, fraudScore: 0, fraudFlags: [] }
    });
    res.json({ success: true, message: "Fraud flag cleared" });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear flag" });
  }
});

// Suspend a flagged user
app.post("/api/admin/fraud/suspend/:userId", adminOnly, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.userId, {
      $set: { role: "suspended" }
    });
    res.json({ success: true, message: "User suspended" });
  } catch (err) {
    res.status(500).json({ error: "Failed to suspend user" });
  }
});


/* ===========================
   ESCROW + CANCELLATION + SELLER ANALYTICS
=========================== */

// Atomically release escrow so concurrent requests cannot pay sellers twice.
async function releaseEscrowAtomically(orderId, buyerEmail = null) {
  const session = await mongoose.startSession();

  try {
    let releasedOrder = null;

    await session.withTransaction(async () => {
      const order = await Order.findOne({
        _id: orderId,
        escrowStatus: "holding"
      }).session(session);

      if (!order) {
        const err = new Error("No escrow funds to release");
        err.statusCode = 400;
        throw err;
      }

      if (buyerEmail && order.email !== buyerEmail) {
        const err = new Error("Not your order");
        err.statusCode = 403;
        throw err;
      }

      if (order.buyerConfirmed) {
        const err = new Error("Delivery already confirmed");
        err.statusCode = 400;
        throw err;
      }

      const sellerAmounts = new Map();

      for (const item of order.items || []) {
        const sellerId = item.vendorId?.toString();
        const itemAmount =
          Number(item.price || 0) * Number(item.quantity || 0);

        if (!sellerId || itemAmount <= 0) {
          const err = new Error(
            "Escrow release failed: invalid seller or item amount"
          );
          err.statusCode = 400;
          throw err;
        }

        sellerAmounts.set(
          sellerId,
          (sellerAmounts.get(sellerId) || 0) + itemAmount
        );
      }

      const allocatedAmount = [...sellerAmounts.values()]
        .reduce((sum, value) => sum + value, 0);

      if (Math.abs(allocatedAmount - Number(order.amount || 0)) > 0.01) {
        const err = new Error(
          "Escrow release failed: seller allocations do not match order amount"
        );
        err.statusCode = 400;
        throw err;
      }

      for (const [sellerId, releaseAmount] of sellerAmounts) {
        let seller = await Seller.findById(sellerId).session(session);
        if (!seller) {
          seller = await User.findById(sellerId).session(session);
        }

        if (!seller) {
          const err = new Error(
            `Escrow release failed: seller ${sellerId} was not found`
          );
          err.statusCode = 400;
          throw err;
        }

        seller.walletBalance = (seller.walletBalance || 0) + releaseAmount;
        seller.walletTransactions = seller.walletTransactions || [];
        seller.walletTransactions.push({
          type: "credit",
          amount: releaseAmount,
          description: buyerEmail
            ? `Escrow released for order #${order.trackingNumber || order._id}`
            : `Escrow released (admin) for order #${order.trackingNumber || order._id}`,
          reference: (buyerEmail ? "ESC-" : "ESC-REL-") + Date.now()
        });

        await seller.save({ session });
      }

      order.escrowStatus = "released";
      order.escrowReleasedAt = new Date();
      if (buyerEmail) order.buyerConfirmed = true;
      order.status = "Delivered";

      await order.save({ session });
      releasedOrder = order;
    });

    return releasedOrder;
  } finally {
    await session.endSession();
  }
}

// Buyer confirms delivery — releases escrow to seller wallet
app.post("/api/orders/:orderId/confirm-delivery", auth, async (req, res) => {
  try {
    const order = await releaseEscrowAtomically(
      req.params.orderId,
      req.user.email
    );

    // 🌐 Update Network Score on purchase
    try {
      const orderAmount = Number(order.amount) || 0;
      const networkPoints = Math.floor(orderAmount / 100);
      await updateNetworkScore(
        (await User.findOne({ email: order.email }))?._id,
        networkPoints,
        { lifetimeSpend: orderAmount }
      );
    } catch (nsErr) {
      console.error("Network score error:", nsErr.message);
    }

    // 🎯 Award Loyalty Points
    const pointsEarned = Math.floor((Number(order.amount) || 0) / 1000);
    if (pointsEarned > 0) {
      try {
        const buyerForPoints = await User.findOne({ email: order.email });
        if (buyerForPoints) {
          buyerForPoints.loyaltyPoints =
            (buyerForPoints.loyaltyPoints || 0) + pointsEarned;
          buyerForPoints.totalPointsEarned =
            (buyerForPoints.totalPointsEarned || 0) + pointsEarned;
          await buyerForPoints.save();
          console.log(
            `🎯 ${pointsEarned} loyalty points awarded to ${order.email}`
          );
        }
      } catch (lpErr) {
        console.error("Loyalty points error:", lpErr.message);
      }
    }

    // 💰 2% Cashback to buyer wallet
    const cashbackAmount = Math.floor((Number(order.amount) || 0) * 0.02);
    let cashbackMsg = "";

    if (cashbackAmount > 0) {
      try {
        const buyer = await User.findOne({ email: order.email });
        if (buyer) {
          buyer.walletBalance =
            (buyer.walletBalance || 0) + cashbackAmount;
          buyer.walletTransactions = buyer.walletTransactions || [];
          buyer.walletTransactions.push({
            type: "credit",
            amount: cashbackAmount,
            description: `2% cashback on order #${order.trackingNumber || order._id}`,
            reference: "CBK-" + Date.now()
          });
          await buyer.save();
          cashbackMsg =
            `You earned ₦${cashbackAmount.toLocaleString()} cashback!`;
          console.log(
            `💰 Cashback ₦${cashbackAmount} credited to ${order.email}`
          );
        }
      } catch (cbErr) {
        console.error("Cashback error:", cbErr.message);
      }
    }

    res.json({
      success: true,
      message: "Delivery confirmed. Payment released to seller.",
      cashback: cashbackAmount,
      cashbackMsg
    });
  } catch (err) {
    console.error("Escrow release error:", err.message);
    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to confirm delivery"
    });
  }
});

// Cancel order and refund to wallet
app.post("/api/orders/:orderId/cancel", auth, async (req, res) => {
  try {
    const { reason } = req.body;
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.email !== req.user.email) return res.status(403).json({ error: "Not your order" });

    const cancellableStatuses = ["Pending", "Processing"];
    if (!cancellableStatuses.includes(order.status)) {
      return res.status(400).json({ error: `Cannot cancel an order that is ${order.status}` });
    }

    // Refund to wallet if order was paid
    const refundAmount = Number(order.amount) || 0;
    if (refundAmount > 0) {
      const buyer = await User.findOne({ email: order.email });
      if (buyer) {
        buyer.walletBalance = (buyer.walletBalance || 0) + refundAmount;
        buyer.walletTransactions = buyer.walletTransactions || [];
        buyer.walletTransactions.push({
          type: "credit",
          amount: refundAmount,
          description: `Refund for cancelled order #${order.trackingNumber || order._id}`,
          reference: "REF-" + Date.now()
        });
        await buyer.save();
      }
    }

    order.status = "Cancelled";
    order.cancelledAt = new Date();
    order.cancelReason = reason || "Cancelled by buyer";
    if (order.escrowStatus === "holding") order.escrowStatus = "refunded";
    await order.save();

    res.json({ success: true, message: "Order cancelled. Refund added to your TechMart wallet." });
  } catch (err) {
    console.error("Cancel error:", err.message);
    res.status(500).json({ error: "Failed to cancel order" });
  }
});

/* ===========================
   🛡️ TRUST & SAFETY
=========================== */

// Send OTP for 2FA
app.post("/api/auth/send-otp", async (req, res) => {
  try {
    const email = req.body.email ? String(req.body.email).toLowerCase().trim() : req.body.email;
    if (!email) return res.status(400).json({ error: "Email is required" });
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Generate a cryptographically secure 6-digit OTP.
    const otp = randomInt(100000, 1000000).toString();
    const otpHash = await bcrypt.hash(otp, 10);
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await User.findByIdAndUpdate(user._id, {
      otpCode: otpHash,
      otpExpires: expires
    });

    await sendOTPEmail(user.email, user.name, otp);
    res.json({ success: true, message: "OTP sent to your email" });
  } catch (err) {
    console.error("OTP error:", err.message);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

// Verify OTP
app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const { otp } = req.body;
    const email = req.body.email ? String(req.body.email).toLowerCase().trim() : req.body.email;
    if (!email || !otp) return res.status(400).json({ error: "Email and OTP are required" });
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.otpCode || !user.otpExpires) {
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    if (new Date() > new Date(user.otpExpires)) {
      return res.status(400).json({ error: "OTP has expired. Please request a new one." });
    }

    const otpValid = await bcrypt.compare(String(otp), user.otpCode);
    if (!otpValid) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    const deviceToken = crypto.randomBytes(32).toString("hex");
    const updatedTokens = [...(user.deviceTokens || []), deviceToken].slice(-5);
    await User.findByIdAndUpdate(user._id, { otpCode: null, otpExpires: null, deviceTokens: updatedTokens });
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ success: true, token, deviceToken, user: { id: user._id, name: user.name, email: user.email, role: user.role, walletBalance: user.walletBalance, walletPinSet: user.walletPinSet, twoFactorEnabled: user.twoFactorEnabled } });
  } catch (err) {
    console.error("OTP verify error:", err.message);
    res.status(500).json({ error: "OTP verification failed" });
  }
});

// Submit Return Request
app.post("/api/returns", auth, async (req, res) => {
  try {
    const { orderId, reason, description } = req.body;
    if (!orderId || !reason) return res.status(400).json({ error: "Order ID and reason are required" });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.email !== req.user.email) return res.status(403).json({ error: "Not your order" });
    if (!["Delivered", "Paid", "Shipped"].includes(order.status)) {
      return res.status(400).json({ error: "Only delivered or shipped orders can be returned" });
    }

    const existing = await Return.findOne({ orderId, buyerEmail: req.user.email });
    if (existing) return res.status(400).json({ error: "You already submitted a return for this order" });

    const user = await User.findById(req.user.id);
    const returnRequest = await Return.create({
      orderId,
      buyerEmail: req.user.email,
      buyerName: user?.name || req.user.email,
      reason,
      description,
      refundAmount: order.amount
    });

    res.json({ success: true, message: "Return request submitted. We will review it within 24 hours.", returnRequest });
  } catch (err) {
    console.error("Return error:", err.message);
    res.status(500).json({ error: "Failed to submit return request" });
  }
});

// Get buyer's return requests
app.get("/api/returns/my", auth, async (req, res) => {
  try {
    const returns = await Return.find({ buyerEmail: req.user.email }).sort({ createdAt: -1 });
    res.json(returns);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch returns" });
  }
});

// Admin — get all returns
app.get("/api/admin/returns", adminOnly, async (req, res) => {
  try {
    const returns = await Return.find().sort({ createdAt: -1 });
    res.json(returns);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch returns" });
  }
});

// Admin — approve/reject return
app.put("/api/admin/returns/:id", adminOnly, async (req, res) => {
  try {
    const { status, adminNote, refundAmount } = req.body;
    const returnReq = await Return.findByIdAndUpdate(
      req.params.id,
      { status, adminNote, refundAmount },
      { new: true }
    );
    if (!returnReq) return res.status(404).json({ error: "Return not found" });

    // If approved, credit buyer wallet
    if (status === "approved") {
      const buyer = await User.findOne({ email: returnReq.buyerEmail });
      if (buyer) {
        buyer.walletBalance = (buyer.walletBalance || 0) + Number(refundAmount || returnReq.refundAmount);
        buyer.walletTransactions.push({
          type: "credit",
          amount: Number(refundAmount || returnReq.refundAmount),
          description: `Refund approved for return request #${returnReq._id}`,
          reference: "RET-" + Date.now()
        });
        await buyer.save();
      }
    }

    res.json({ success: true, returnReq });
  } catch (err) {
    res.status(500).json({ error: "Failed to update return" });
  }
});


/* ===========================
   🤖 AI PLATFORM ASSISTANT V2
=========================== */
app.post("/api/ai/assistant", auth, async (req, res) => {
  try {
    const { message, history = [], context = {} } = req.body;
    const isSeller = req.user.role === "seller";
    const user = isSeller ? await Seller.findById(req.user.id).lean() : await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: "Account not found" });
    const isAdmin = !isSeller && user.role === "admin";

    // 1. Classify intent with full context
    const classifyRes = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{
        role: "system",
        content: `You are an intent classifier for TechMart, a Nigerian e-commerce platform.
Classify the user message into ONE intent. Use conversation history and context to resolve pronouns like "it", "that", "the cheaper one", "the first one".
Return ONLY valid JSON with no markdown.

Context from previous turn: ${JSON.stringify(context)}

Intents:
- find_product: search products (params: query, maxPrice, minPrice, category)
- add_to_cart: add product to cart (params: productId, productName, quantity)
- buy_now: prepare a purchase and direct the user to normal checkout; NEVER place or pay for an order (params: productId, productName, price)
- compare_products: compare two products (params: product1, product2)
- wallet_balance: check balance
- wallet_transfer: transfer money (params: recipientEmail, amount, note)
- wallet_split: split money between people (params: amount, recipients[])
- wallet_spending: show spending summary (params: period e.g. "this month")
- wallet_cashback: show cashback earned
- fund_wallet: add money to wallet (params: amount)
- track_order: track orders
- show_orders: list recent orders
- apply_coupon: apply best coupon
- place_order: direct the user to normal checkout; NEVER create, confirm, or pay for an order (params: couponCode)
- start_return: start return (params: orderId)
- generate_description: generate product description (params: productName, category)
- seller_flash_sale: create flash sale (params: productName, discount, endDate) - seller/admin only
- seller_low_stock: show low stock products - seller/admin only
- seller_reorder: suggest reorder products - seller/admin only
- seller_descriptions: generate descriptions for all new products - seller/admin only
- admin_revenue: show today revenue - admin only
- admin_suspicious: list suspicious transactions - admin only
- admin_payouts: show/approve pending payouts - admin only
- admin_flag_accounts: show high risk accounts - admin only
- proactive_check: check for alerts (low balance, stock, coupons)
- general_chat: conversation

Example: {"intent": "add_to_cart", "params": {"productId": "abc123", "quantity": 1}}`
      }, {
        role: "user",
        content: `History: ${JSON.stringify(history.slice(-4).map(m => m.text))}

Current message: ${message}`
      }],
      max_tokens: 300,
      temperature: 0.1
    });

    let intent, params;
    try {
      const parsed = JSON.parse(classifyRes.choices[0].message.content.trim());
      intent = parsed.intent;
      params = parsed.params || {};
    } catch {
      intent = "general_chat";
      params = {};
    }

    let responseData = { intent, message: "", data: null, action: null, context: {} };

    switch (intent) {

      case "find_product": {
        const query = { stock: { $gt: 0 } };
        if (params.category) query.category = new RegExp(params.category, "i");
        if (params.maxPrice) query.price = { ...(query.price||{}), $lte: Number(params.maxPrice) };
        if (params.minPrice) query.price = { ...(query.price||{}), $gte: Number(params.minPrice) };
        let products = params.query
          ? await Product.find({ name: new RegExp(params.query, "i"), stock: { $gt: 0 }, ...query }).limit(5)
          : await Product.find(query).limit(5);
        responseData.message = products.length > 0 ? `Found ${products.length} product${products.length > 1 ? "s" : ""}:` : "No products found.";
        const sellerIds = [...new Set(products.map(p => p.vendorId).filter(Boolean).map(String))];
        const sellers = await Seller.find({ _id: { $in: sellerIds } }).select("_id verified").lean();
        const sellerById = new Map(sellers.map(s => [String(s._id), s]));
        responseData.data = {
          type: "products",
          items: products.map(p => {
            const seller = sellerById.get(String(p.vendorId || ""));
            return {
              _id: p._id, name: p.name, price: p.price,
              image: p.images?.[0], category: p.category, stock: p.stock,
              techmartVerified: p.techmartVerified === true,
              sellerVerified: seller ? seller.verified === true : null,
              sellerVerification: !seller ? "unavailable" : seller.verified === true ? "verified" : "not_verified"
            };
          })
        };
        responseData.context = { lastProducts: products.map(p => ({ _id: p._id, name: p.name, price: p.price })) };
        break;
      }

      case "compare_products": {
        const p1 = params.product1 || context.lastProducts?.[0]?.name;
        const p2 = params.product2 || context.lastProducts?.[1]?.name;
        if (!p1 || !p2) { responseData.message = "Please specify two products to compare."; break; }
        const [prod1, prod2] = await Promise.all([
          Product.findOne({ name: new RegExp(p1, "i") }),
          Product.findOne({ name: new RegExp(p2, "i") })
        ]);
        if (!prod1 || !prod2) { responseData.message = "Could not find both products to compare."; break; }
        const cheaper = prod1.price < prod2.price ? prod1 : prod2;
        responseData.message = `Comparing **${prod1.name}** vs **${prod2.name}**:`;
        const compareProducts = [prod1, prod2];
        const compareSellerIds = [...new Set(compareProducts.map(p => p.vendorId).filter(Boolean).map(String))];
        const compareSellers = await Seller.find({ _id: { $in: compareSellerIds } }).select("_id verified").lean();
        const compareSellerById = new Map(compareSellers.map(s => [String(s._id), s]));
        responseData.data = {
          type: "compare",
          items: compareProducts.map(p => {
            const seller = compareSellerById.get(String(p.vendorId || ""));
            return {
              _id: p._id, name: p.name, price: p.price,
              image: p.images?.[0], category: p.category, stock: p.stock,
              rating: p.rating,
              techmartVerified: p.techmartVerified === true,
              sellerVerified: seller ? seller.verified === true : null,
              sellerVerification: !seller ? "unavailable" : seller.verified === true ? "verified" : "not_verified"
            };
          }),
          cheaper: cheaper._id
        };
        responseData.context = { lastProducts: [prod1, prod2].map(p => ({ _id: p._id, name: p.name, price: p.price })), cheaperProduct: { _id: cheaper._id, name: cheaper.name, price: cheaper.price } };
        break;
      }

      case "add_to_cart": {
        let product = null;
        if (params.productId) product = await Product.findById(params.productId);
        else if (params.productName) product = await Product.findOne({ name: new RegExp(params.productName, "i") });
        else if (context.cheaperProduct) product = await Product.findById(context.cheaperProduct._id);
        else if (context.lastProducts?.[0]) product = await Product.findById(context.lastProducts[0]._id);
        if (!product) { responseData.message = "Could not find the product to add to cart."; break; }
        responseData.message = `Added **${product.name}** (₦${product.price?.toLocaleString()}) to your cart!`;
        responseData.data = { type: "add_to_cart", product: { _id: product._id, name: product.name, price: product.price, images: product.images } };
        responseData.action = "add_to_cart";
        responseData.context = { ...context, cartProduct: { _id: product._id, name: product.name, price: product.price } };
        break;
      }

      case "place_order":
      case "buy_now": {
        responseData.message = "I can help you prepare your purchase, but I cannot place or pay for orders. Please review your cart, enter your delivery address and phone number, and complete payment through checkout. No order has been placed.";
        responseData.data = { type: "navigate", path: "/checkout" };
        break;
      }

      case "wallet_balance": {
        const recent = (user.walletTransactions || []).slice(-3).reverse();
        responseData.message = `Your wallet balance is ₦${(user.walletBalance || 0).toLocaleString()}.`;
        responseData.data = { type: "balance", balance: user.walletBalance || 0, recent };
        break;
      }

      case "wallet_split": {
        const { amount, recipients = [] } = params;
        if (!amount || recipients.length === 0) { responseData.message = "Please specify the amount and recipients. E.g. 'Split ₦30,000 between john@gmail.com, jane@gmail.com, bob@gmail.com'"; break; }
        const share = Math.floor(Number(amount) / recipients.length);
        responseData.message = `Split ₦${Number(amount).toLocaleString()} between ${recipients.length} people: each gets ₦${share.toLocaleString()}. Confirm transfers?`;
        responseData.data = { type: "confirm_split", amount, recipients, share };
        responseData.action = "confirm_split";
        break;
      }

      case "wallet_spending": {
        const period = params.period || "this month";
        const startDate = new Date();
        startDate.setDate(1);
        const txns = (user.walletTransactions || []).filter(t => new Date(t.createdAt) >= startDate);
        const totalSpent = txns.filter(t => t.type === "debit").reduce((s, t) => s + t.amount, 0);
        const totalIn = txns.filter(t => t.type === "credit").reduce((s, t) => s + t.amount, 0);
        responseData.message = `This month: spent ₦${totalSpent.toLocaleString()}, received ₦${totalIn.toLocaleString()}. Net: ${totalIn > totalSpent ? "+" : ""}₦${(totalIn - totalSpent).toLocaleString()}.`;
        responseData.data = { type: "spending", totalSpent, totalIn, txns: txns.slice(-5) };
        break;
      }

      case "wallet_cashback": {
        const cashbackTxns = (user.walletTransactions || []).filter(t => t.description?.toLowerCase().includes("cashback"));
        const total = cashbackTxns.reduce((s, t) => s + t.amount, 0);
        responseData.message = `You have earned ₦${total.toLocaleString()} in cashback across ${cashbackTxns.length} transaction${cashbackTxns.length !== 1 ? "s" : ""}.`;
        responseData.data = { type: "cashback", total, count: cashbackTxns.length };
        break;
      }

      case "wallet_transfer": {
        if (!params.recipientEmail || !params.amount) { responseData.message = "Please provide recipient email and amount."; break; }
        responseData.message = `Transfer ₦${Number(params.amount).toLocaleString()} to ${params.recipientEmail}. Confirm?`;
        responseData.data = { type: "confirm_transfer", recipientEmail: params.recipientEmail, amount: params.amount, note: params.note };
        responseData.action = "confirm_transfer";
        break;
      }

      case "apply_coupon": {
        const coupons = await Coupon.find({ active: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).sort({ value: -1 }).limit(1);
        if (!coupons.length) { responseData.message = "No active coupons available right now."; break; }
        const best = coupons[0];
        responseData.message = `Best coupon: **${best.code}** — ${best.type === "percent" ? best.value + "% off" : "₦" + best.value + " off"}. Tap to copy!`;
        responseData.data = { type: "coupon", code: best.code, value: best.value, discountType: best.type };
        responseData.action = "apply_coupon";
        break;
      }

      case "track_order": {
        const orders = await Order.find({ email: user.email }).sort({ createdAt: -1 }).limit(5);
        if (!orders.length) { responseData.message = "You have no orders yet."; break; }
        const o = orders[0];
        responseData.message = `Last order (#${o.trackingNumber || o._id.toString().slice(-6)}) is **${o.status}** — ₦${o.amount?.toLocaleString()}.`;
        responseData.data = { type: "orders", items: orders.slice(0, 3).map(o => ({ _id: o._id, status: o.status, amount: o.amount, trackingNumber: o.trackingNumber, createdAt: o.createdAt })) };
        break;
      }

      case "show_orders": {
        const orders = await Order.find({ email: user.email }).sort({ createdAt: -1 }).limit(5);
        responseData.message = orders.length ? `Your ${orders.length} most recent orders:` : "No orders yet.";
        responseData.data = { type: "orders", items: orders.map(o => ({ _id: o._id, status: o.status, amount: o.amount, trackingNumber: o.trackingNumber, createdAt: o.createdAt })) };
        break;
      }

      case "start_return": {
        const orders = await Order.find({ email: user.email, status: { $in: ["Delivered", "Shipped"] } }).sort({ createdAt: -1 }).limit(1);
        if (!orders.length) { responseData.message = "No eligible orders for return."; break; }
        responseData.message = `Start return for order #${orders[0].trackingNumber || orders[0]._id.toString().slice(-6)} (₦${orders[0].amount?.toLocaleString()})? What is the reason?`;
        responseData.data = { type: "start_return", orderId: orders[0]._id };
        responseData.action = "start_return";
        break;
      }

      case "generate_description": {
        const name = params.productName || "this product";
        const descRes = await groq.chat.completions.create({
          model: "openai/gpt-oss-20b",
          messages: [{ role: "user", content: `Write a compelling 2-3 sentence product description for "${name}" ${params.category ? "in the " + params.category + " category" : ""} for a Nigerian e-commerce store. Focus on key features and value. Be concise and persuasive.` }],
          max_tokens: 150, temperature: 0.7
        });
        responseData.message = descRes.choices[0].message.content.trim();
        responseData.data = { type: "description", text: responseData.message };
        break;
      }

      case "seller_low_stock": {
        const query = isSeller ? { vendorId: req.user.id, stock: { $lte: 5 } } : { stock: { $lte: 5 } };
        const products = await Product.find(query).sort({ stock: 1 }).limit(10);
        responseData.message = products.length ? `${products.length} products with low stock:` : "No low stock products.";
        responseData.data = { type: "products", items: products.map(p => ({ _id: p._id, name: p.name, price: p.price, stock: p.stock, image: p.images?.[0] })) };
        break;
      }

      case "seller_reorder": {
        const query = isSeller ? { vendorId: req.user.id, stock: { $lte: 10 } } : { stock: { $lte: 10 } };
        const products = await Product.find(query).sort({ stock: 1 }).limit(5);
        responseData.message = products.length ? `I recommend reordering these ${products.length} products:` : "All products have sufficient stock.";
        responseData.data = { type: "products", items: products.map(p => ({ _id: p._id, name: p.name, price: p.price, stock: p.stock, image: p.images?.[0] })) };
        break;
      }

      case "seller_descriptions": {
        const query = isSeller ? { vendorId: req.user.id, description: { $in: [null, "", "No description"] } } : { description: { $in: [null, "", "No description"] } };
        const products = await Product.find(query).limit(3);
        if (!products.length) { responseData.message = "All products have descriptions."; break; }
        const descriptions = await Promise.all(products.map(async p => {
          const r = await groq.chat.completions.create({
            model: "openai/gpt-oss-20b",
            messages: [{ role: "user", content: `Write a 2-sentence product description for "${p.name}" (${p.category}) for a Nigerian electronics store.` }],
            max_tokens: 100, temperature: 0.7
          });
          return { _id: p._id, name: p.name, description: r.choices[0].message.content.trim() };
        }));
        responseData.message = `Generated descriptions for ${descriptions.length} products:`;
        responseData.data = { type: "descriptions", items: descriptions };
        break;
      }

      case "admin_revenue": {
        if (!isAdmin) { responseData.message = "Admin access required."; break; }
        const today = new Date(); today.setHours(0,0,0,0);
        const orders = await Order.find({ createdAt: { $gte: today }, status: { $nin: ["Cancelled"] } });
        const revenue = orders.reduce((s, o) => s + (o.amount || 0), 0);
        responseData.message = `Today's revenue: ₦${revenue.toLocaleString()} from ${orders.length} order${orders.length !== 1 ? "s" : ""}.`;
        responseData.data = { type: "revenue", revenue, orders: orders.length, date: today };
        break;
      }

      case "admin_suspicious": {
        if (!isAdmin) { responseData.message = "Admin access required."; break; }
        const flagged = await User.find({ isFlagged: true }).select("name email fraudScore fraudFlags").sort({ fraudScore: -1 }).limit(5);
        responseData.message = flagged.length ? `${flagged.length} suspicious account${flagged.length !== 1 ? "s" : ""} flagged:` : "No suspicious accounts detected.";
        responseData.data = { type: "users", items: flagged.map(u => ({ _id: u._id, name: u.name, email: u.email, fraudScore: u.fraudScore, reason: u.fraudFlags?.[0]?.reason })) };
        break;
      }

      case "admin_payouts": {
        if (!isAdmin) { responseData.message = "Admin access required."; break; }
        const Payout = mongoose.models.Payout;
        if (!Payout) { responseData.message = "Payout system not initialized."; break; }
        const payouts = await Payout.find({ status: "pending" }).limit(5);
        responseData.message = payouts.length ? `${payouts.length} pending payout${payouts.length !== 1 ? "s" : ""} awaiting approval.` : "No pending payouts.";
        responseData.data = { type: "payouts", items: payouts, action: "navigate", path: "/admin" };
        break;
      }

      case "admin_flag_accounts": {
        if (!isAdmin) { responseData.message = "Admin access required."; break; }
        const high = await User.find({ fraudScore: { $gte: 60 } }).select("name email fraudScore").sort({ fraudScore: -1 }).limit(5);
        responseData.message = high.length ? `${high.length} high-risk account${high.length !== 1 ? "s" : ""}:` : "No high-risk accounts.";
        responseData.data = { type: "users", items: high.map(u => ({ _id: u._id, name: u.name, email: u.email, fraudScore: u.fraudScore })) };
        break;
      }

      case "proactive_check": {
        const alerts = [];
        if ((user.walletBalance || 0) < 500) alerts.push("💰 Your wallet balance is low (₦" + (user.walletBalance||0).toLocaleString() + ").");
        const coupon = await Coupon.findOne({ active: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });
        if (coupon) alerts.push(`🎟 Active coupon available: **${coupon.code}**`);
        const lowStock = await Product.find({ stock: { $lte: 3, $gt: 0 }, ...(isSeller ? { vendorId: req.user.id } : {}) }).limit(2);
        lowStock.forEach(p => alerts.push(`⚠️ Low stock: **${p.name}** (${p.stock} left)`));
        responseData.message = alerts.length ? alerts.join(" | ") : "Everything looks good! No alerts at this time.";
        responseData.data = { type: "alerts", items: alerts };
        break;
      }

      case "fund_wallet": {
        responseData.message = `Taking you to Add Money${params.amount ? " to fund ₦" + Number(params.amount).toLocaleString() : ""}.`;
        responseData.data = { type: "navigate", path: "/pay", tab: "Add Money", amount: params.amount };
        responseData.action = "navigate";
        break;
      }

      case "general_chat":
      default: {
        const products = await Product.find({ stock: { $gt: 0 } }).select("name price category");
        const catalog = products.map(p => p.name + " (" + "N" + p.price?.toLocaleString() + ") - " + p.category).join(", ");
        const chatRes = await groq.chat.completions.create({
          model: "openai/gpt-oss-20b",
          messages: [
            { role: "system", content: `You are TechMart AI for ${user.name}. Wallet: N${(user.walletBalance||0).toLocaleString()}. Role: ${user.role}. Products: ${catalog}. TechMart was founded by Jamiu Sanni with a vision to build Africa's leading e-commerce platform, connecting buyers and sellers globally.
TECHMART FAQ KNOWLEDGE:
- Return Policy: Buyers have 7 days after delivery to request a return. Items must be in original condition.
- Escrow: Payment is held securely by TechMart when an order is placed. Funds are only released to the seller after the buyer confirms delivery. This protects both parties.
- Seller Fees: Selling on TechMart is completely free for now. No listing fees, no commission.
- Delivery: TechMart partners with trusted delivery partners to fulfil orders. Sellers coordinate dispatch and buyers are notified with tracking updates.
If a user asks about any of these topics, answer confidently using the above information.
You cannot place, confirm or pay for orders, and you cannot move money. Never say or imply that an order was placed or that a payment was made. For purchases, tell the user to add the item to their cart and pay at checkout.
Be helpful and concise.` },
            ...history.slice(-6).map(m => ({ role: m.sender === "user" ? "user" : "assistant", content: m.text })),
            { role: "user", content: message }
          ],
          max_tokens: 300, temperature: 0.7
        });
        responseData.message = scrubOrderClaims(chatRes.choices[0].message.content.trim());
        break;
      }
    }

    res.json({ success: true, ...responseData });
  } catch (err) {
    console.error("AI Assistant error:", err.message);
    res.status(500).json({ error: "AI Assistant failed", message: "Sorry, I encountered an error. Please try again." });
  }
});

/* ===========================
   🧠 AI AGENT - TOOL CALLING
=========================== */

// Tool definitions for Groq function calling
const TECHMART_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search for products on TechMart by name, category, or price range",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Product name or keywords" },
          category: { type: "string", description: "Product category" },
          maxPrice: { type: "number", description: "Maximum price in Naira" },
          minPrice: { type: "number", description: "Minimum price in Naira" },
          limit: { type: "number", description: "Number of results (default 5)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_wallet_info",
      description: "Get user wallet balance and recent transactions",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "transfer_money",
      description: "Transfer money from wallet to another TechMart user",
      parameters: {
        type: "object",
        properties: {
          recipientEmail: { type: "string", description: "Recipient email address" },
          amount: { type: "number", description: "Amount in Naira" },
          note: { type: "string", description: "Optional note" }
        },
        required: ["recipientEmail", "amount"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_orders",
      description: "Get user recent orders and their status",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of orders to return" },
          status: { type: "string", description: "Filter by status" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_best_coupon",
      description: "Get the best available coupon code",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_spending_summary",
      description: "Get wallet spending summary for a period",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string", description: "Period e.g. this month, last week, today" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_low_stock_products",
      description: "Get products with low stock (for sellers and admins)",
      parameters: {
        type: "object",
        properties: {
          threshold: { type: "number", description: "Stock threshold (default 5)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_admin_stats",
      description: "Get admin dashboard stats including today revenue and orders",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_flagged_users",
      description: "Get users flagged for suspicious activity (admin only)",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "generate_product_description",
      description: "Generate a compelling product description using AI",
      parameters: {
        type: "object",
        properties: {
          productName: { type: "string", description: "Product name" },
          category: { type: "string", description: "Product category" }
        },
        required: ["productName"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_preference",
      description: "Save a user preference or memory for future conversations",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Preference key e.g. preferred_network, budget" },
          value: { type: "string", description: "Preference value" }
        },
        required: ["key", "value"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "compare_products",
      description: "Compare two products side by side",
      parameters: {
        type: "object",
        properties: {
          product1: { type: "string", description: "First product name or ID" },
          product2: { type: "string", description: "Second product name or ID" }
        },
        required: ["product1", "product2"]
      }
    }
  }
];

// Tool executor
async function executeTool(toolName, toolArgs, user) {
  switch (toolName) {
    case "search_products": {
      const query = { stock: { $gt: 0 } };
      if (toolArgs.category) query.category = new RegExp(toolArgs.category, "i");
      if (toolArgs.maxPrice) query.price = { ...(query.price||{}), $lte: toolArgs.maxPrice };
      if (toolArgs.minPrice) query.price = { ...(query.price||{}), $gte: toolArgs.minPrice };
      const limit = toolArgs.limit || 5;
      let products;
      if (toolArgs.query) {
        products = await Product.find({ name: new RegExp(toolArgs.query, "i"), stock: { $gt: 0 }, ...query }).limit(limit);
        if (!products.length) products = await Product.find({ description: new RegExp(toolArgs.query, "i"), stock: { $gt: 0 }, ...query }).limit(limit);
      } else {
        products = await Product.find(query).limit(limit);
      }
      return { products: products.map(p => ({ _id: p._id, name: p.name, price: p.price, category: p.category, stock: p.stock, image: p.images?.[0] })) };
    }

    case "get_wallet_info": {
      const recent = (user.walletTransactions || []).slice(-5).reverse();
      return { balance: user.walletBalance || 0, recentTransactions: recent };
    }

    case "transfer_money": {
      // Disabled for the AI agent: transfers must go through the wallet screen, which asks for the PIN.
      return { error: "Transfers are not available through the AI agent. Please use the wallet screen, which asks for your PIN." };
      // eslint-disable-next-line no-unreachable
      const recipient = await User.findOne({ email: toolArgs.recipientEmail });
      if (!recipient) return { error: "Recipient not found" };
      if ((user.walletBalance || 0) < toolArgs.amount) return { error: "Insufficient balance" };
      const reference = "TXF-" + Date.now();
      user.walletBalance -= toolArgs.amount;
      user.walletTransactions.push({ type: "debit", amount: toolArgs.amount, description: `Transfer to ${recipient.name}${toolArgs.note ? " — " + toolArgs.note : ""}`, reference });
      await user.save();
      recipient.walletBalance = (recipient.walletBalance || 0) + toolArgs.amount;
      recipient.walletTransactions.push({ type: "credit", amount: toolArgs.amount, description: `Transfer from ${user.name}`, reference });
      await recipient.save();
      return { success: true, message: `Transferred ₦${toolArgs.amount.toLocaleString()} to ${recipient.name}`, reference };
    }

    case "get_orders": {
      const query = { email: user.email };
      if (toolArgs.status) query.status = toolArgs.status;
      const orders = await Order.find(query).sort({ createdAt: -1 }).limit(toolArgs.limit || 5);
      return { orders: orders.map(o => ({ _id: o._id, status: o.status, amount: o.amount, trackingNumber: o.trackingNumber, createdAt: o.createdAt, items: o.items?.length })) };
    }

    case "get_best_coupon": {
      const coupon = await Coupon.findOne({ active: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).sort({ value: -1 });
      if (!coupon) return { error: "No active coupons" };
      return { code: coupon.code, type: coupon.type, value: coupon.value, minOrder: coupon.minOrder };
    }

    case "get_spending_summary": {
      const start = new Date();
      start.setDate(1);
      const txns = (user.walletTransactions || []).filter(t => new Date(t.createdAt) >= start);
      const spent = txns.filter(t => t.type === "debit").reduce((s, t) => s + t.amount, 0);
      const received = txns.filter(t => t.type === "credit").reduce((s, t) => s + t.amount, 0);
      return { period: toolArgs.period || "this month", totalSpent: spent, totalReceived: received, transactionCount: txns.length };
    }

    case "get_low_stock_products": {
      const threshold = toolArgs.threshold || 5;
      const query = { stock: { $lte: threshold, $gt: 0 } };
      if (user.role === "seller") query.vendorId = user._id.toString();
      const products = await Product.find(query).sort({ stock: 1 }).limit(10);
      return { products: products.map(p => ({ _id: p._id, name: p.name, stock: p.stock, price: p.price })) };
    }

    case "get_admin_stats": {
      if (user.role !== "admin") return { error: "Admin access required" };
      const today = new Date(); today.setHours(0,0,0,0);
      const orders = await Order.find({ createdAt: { $gte: today }, status: { $nin: ["Cancelled"] } });
      const revenue = orders.reduce((s, o) => s + (o.amount || 0), 0);
      const totalUsers = await User.countDocuments();
      const flagged = await User.countDocuments({ isFlagged: true });
      return { todayRevenue: revenue, todayOrders: orders.length, totalUsers, flaggedUsers: flagged };
    }

    case "get_flagged_users": {
      if (user.role !== "admin") return { error: "Admin access required" };
      const flagged = await User.find({ isFlagged: true }).select("name email fraudScore").sort({ fraudScore: -1 }).limit(10);
      return { users: flagged.map(u => ({ _id: u._id, name: u.name, email: u.email, fraudScore: u.fraudScore })) };
    }

    case "generate_product_description": {
      const res = await groq.chat.completions.create({
        model: "openai/gpt-oss-20b",
        messages: [{ role: "user", content: `Write a compelling 2-3 sentence product description for "${toolArgs.productName}" ${toolArgs.category ? "in the " + toolArgs.category + " category" : ""} for a Nigerian e-commerce store. Be concise and persuasive.` }],
        max_tokens: 150, temperature: 0.7
      });
      return { description: res.choices[0].message.content.trim() };
    }

    case "save_preference": {
      const prefs = user.aiPreferences || {};
      prefs[toolArgs.key] = toolArgs.value;
      await User.findByIdAndUpdate(user._id, { aiPreferences: prefs });
      return { success: true, message: `Saved preference: ${toolArgs.key} = ${toolArgs.value}` };
    }

    case "compare_products": {
      const [p1, p2] = await Promise.all([
        Product.findOne({ $or: [{ _id: toolArgs.product1.length === 24 ? toolArgs.product1 : null }, { name: new RegExp(toolArgs.product1, "i") }] }),
        Product.findOne({ $or: [{ _id: toolArgs.product2.length === 24 ? toolArgs.product2 : null }, { name: new RegExp(toolArgs.product2, "i") }] })
      ]);
      if (!p1 || !p2) return { error: "Could not find one or both products" };
      return {
        product1: { _id: p1._id, name: p1.name, price: p1.price, category: p1.category, stock: p1.stock, rating: p1.rating, image: p1.images?.[0] },
        product2: { _id: p2._id, name: p2.name, price: p2.price, category: p2.category, stock: p2.stock, rating: p2.rating, image: p2.images?.[0] },
        cheaper: p1.price < p2.price ? p1._id : p2._id,
        recommendation: p1.price < p2.price ? p1.name : p2.name
      };
    }

    case "seller_flash_sale": {
      if (!["seller", "admin"].includes(user.role)) return { error: "Only sellers can create flash sales" };
      const { productName, discount, endDate } = toolArgs;
      if (!productName || !discount || !endDate) return { error: "Product name, discount percentage, and end date are required" };
      const query = { name: new RegExp(productName, "i") };
      if (user.role === "seller") query.vendorId = user._id.toString();
      const product = await Product.findOne(query);
      if (!product) return { error: `Could not find a product matching "${productName}"${user.role === "seller" ? " in your store" : ""}` };
      const discountPct = Math.min(90, Math.max(1, Number(discount)));
      const salePrice = Math.round(product.price * (1 - discountPct / 100));
      const endTime = new Date(endDate);
      if (isNaN(endTime.getTime()) || endTime <= new Date()) return { error: "End date must be a valid future date" };
      const sale = await FlashSale.create({
        productId: product._id,
        productName: product.name,
        originalPrice: product.price,
        salePrice,
        startTime: new Date(),
        endTime
      });
      return { success: true, message: `Flash sale created for ${product.name}: ₦${product.price.toLocaleString()} → ₦${salePrice.toLocaleString()} (${discountPct}% off) until ${endTime.toLocaleDateString()}`, flashSaleId: sale._id };
    }
    default:
      return { error: "Unknown tool" };
  }
}

// AI Agent endpoint with tool calling loop
app.post("/api/ai/agent", auth, async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    const user = req.user.role === "seller" ? await Seller.findById(req.user.id) : await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: "Account not found" });
    const prefs = user.aiPreferences || {};

    // Build system prompt with user context
    const systemPrompt = `You are TechMart AI Agent for ${user.name} (${user.role}).
Wallet: ₦${(user.walletBalance || 0).toLocaleString()}
Preferences: ${JSON.stringify(prefs)}
Date: ${new Date().toLocaleDateString("en-NG")}

TechMart was founded by Jamiu Sanni with a vision to build Africa's leading e-commerce platform, connecting buyers and sellers globally.
You are an autonomous AI agent that can plan and execute multi-step tasks across TechMart.
Use tools to gather information before responding. Chain multiple tools when needed.
For sensitive actions (transfers, purchases), always confirm with the user first.
Be concise, helpful, and proactive.
TECHMART FAQ KNOWLEDGE:
- Return Policy: Buyers have 7 days after delivery to request a return. Items must be in original condition.
- Escrow: Payment is held securely by TechMart when an order is placed. Funds are only released to the seller after the buyer confirms delivery. This protects both parties.
- Seller Fees: Selling on TechMart is completely free for now. No listing fees, no commission.
- Delivery: TechMart partners with trusted delivery partners to fulfil orders. Sellers coordinate dispatch and buyers are notified with tracking updates.
If a user asks about any of these topics, answer confidently using the above information.
You cannot place, confirm or pay for orders, and you cannot move money. Never say or imply that an order was placed or that a payment was made. For purchases, tell the user to add the item to their cart and pay at checkout.
Speak naturally like a smart Nigerian assistant.`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...history.slice(-10).map(m => ({ role: m.sender === "user" ? "user" : "assistant", content: m.text })),
      { role: "user", content: message }
    ];

    let toolResults = [];
    let finalMessage = "";
    let finalData = null;
    let iterations = 0;
    const MAX_ITERATIONS = 5;

    // Agentic loop — keep calling tools until done
    while (iterations < MAX_ITERATIONS) {
      iterations++;
      const response = await groq.chat.completions.create({
        model: "openai/gpt-oss-20b",
        messages,
        tools: TECHMART_TOOLS.filter(t => t.function.name !== "transfer_money"),
        tool_choice: "auto",
        max_tokens: 1000,
        temperature: 0.3
      });

      const choice = response.choices[0];

      // If no tool calls, we have the final answer
      if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
        finalMessage = toolResults.some(t => t.tool === "get_orders") ? (choice.message.content || "") : scrubOrderClaims(choice.message.content || "");
        break;
      }

      // Execute all tool calls
      messages.push({ role: "assistant", content: choice.message.content || "", tool_calls: choice.message.tool_calls });

      for (const toolCall of choice.message.tool_calls) {
        const toolName = toolCall.function.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(toolCall.function.arguments); } catch {}

        console.log(`🔧 Agent calling tool: ${toolName}`, toolArgs);
        const result = await executeTool(toolName, toolArgs, user);
        toolResults.push({ tool: toolName, args: toolArgs, result });

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });

        // Build rich data response for frontend
        if (toolName === "search_products" && result.products) {
          finalData = { type: "products", items: result.products };
        }
        if (toolName === "compare_products" && result.product1) {
          finalData = { type: "compare", items: [result.product1, result.product2], cheaper: result.cheaper };
        }
        if (toolName === "get_wallet_info") {
          finalData = { type: "balance", balance: result.balance };
        }
        if (toolName === "get_orders" && result.orders) {
          finalData = { type: "orders", items: result.orders };
        }
        if (toolName === "get_best_coupon" && result.code) {
          finalData = { type: "coupon", code: result.code, value: result.value, discountType: result.type };
        }
        if (toolName === "get_flagged_users" && result.users) {
          finalData = { type: "users", items: result.users };
        }
      }
    }

    res.json({
      success: true,
      message: finalMessage,
      data: finalData,
      toolsUsed: toolResults.map(t => t.tool),
      iterations
    });

  } catch (err) {
    console.error("AI Agent error:", err.message);
    res.status(500).json({ error: "Agent failed", message: "Sorry, I encountered an error. Please try again." });
  }
});

// Streaming agent endpoint
app.post("/api/ai/agent/stream", auth, async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    const user = req.user.role === "seller" ? await Seller.findById(req.user.id) : await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: "Account not found" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const systemPrompt = `You are TechMart AI Agent for ${user.name}. Wallet: ₦${(user.walletBalance || 0).toLocaleString()}. TechMart was founded by Jamiu Sanni with a vision to build Africa's leading e-commerce platform, connecting buyers and sellers globally.
TECHMART FAQ KNOWLEDGE:
- Return Policy: Buyers have 7 days after delivery to request a return. Items must be in original condition.
- Escrow: Payment is held securely by TechMart when an order is placed. Funds are only released to the seller after the buyer confirms delivery. This protects both parties.
- Seller Fees: Selling on TechMart is completely free for now. No listing fees, no commission.
- Delivery: TechMart partners with trusted delivery partners to fulfil orders. Sellers coordinate dispatch and buyers are notified with tracking updates.
If a user asks about any of these topics, answer confidently using the above information.
Be helpful, concise and natural.`;

    const stream = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: systemPrompt },
        ...history.slice(-6).map(m => ({ role: m.sender === "user" ? "user" : "assistant", content: m.text })),
        { role: "user", content: message }
      ],
      max_tokens: 500,
      temperature: 0.7,
      stream: true
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || "";
      if (delta) res.write(`data: ${JSON.stringify({ token: delta })}

`);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("Stream error:", err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}

`);
    res.end();
  }
});


/* ===========================
   🛒 BUNDLE + ESCROW FLOW
=========================== */

// 1. Add bundle to cart (returns bundle items for frontend)
app.post("/api/orders/bundle", auth, async (req, res) => {
  try {
    const { productIds } = req.body;
    if (!productIds || !productIds.length) return res.status(400).json({ error: "No products provided" });
    const products = await Product.find({ _id: { $in: productIds }, stock: { $gt: 0 } });
    if (!products.length) return res.status(404).json({ error: "No products found" });
    const total = products.reduce((s, p) => s + p.price, 0);
    const discount = Math.round(total * 0.05);
    res.json({
      success: true,
      items: products.map(p => ({ _id: p._id, name: p.name, price: p.price, images: p.images, category: p.category, quantity: 1, vendorId: p.vendorId, vendorName: p.vendorName })),
      total,
      discount,
      bundlePrice: total - discount
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch bundle" });
  }
});

// 2. Checkout with wallet escrow / BNPL
app.post("/api/orders/checkout-escrow", auth, async (req, res) => {
  try {
    const {
      items,
      amount,
      deliveryAddress,
      phone,
      couponCode,
      deliveryFee,
      deliveryZone,
      paymentMode = "escrow",
      installments
    } = req.body;

    if (!items || !Array.isArray(items) || !items.length) {
      return res.status(400).json({
        error: "Items are required"
      });
    }

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({
        error: "A valid order amount is required"
      });
    }

    if (!deliveryAddress?.trim()) {
      return res.status(400).json({
        error: "Delivery address is required"
      });
    }

    if (!phone?.trim()) {
      return res.status(400).json({
        error: "Phone number is required"
      });
    }

    if (!["escrow", "bnpl"].includes(paymentMode)) {
      return res.status(400).json({
        error: "Invalid payment mode"
      });
    }

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(401).json({
        error: "User not found"
      });
    }

    // Validate stock and always use the database product price.
    const validatedItems = [];

    for (const item of items) {
      const productId = item.productId || item._id;

      if (!productId) {
        return res.status(400).json({
          error: "Invalid item — missing product ID"
        });
      }

      const qty = Number(item.quantity) || 1;

      if (qty < 1 || qty > 100) {
        return res.status(400).json({
          error: "Quantity must be between 1 and 100"
        });
      }

      const product = await Product.findById(productId)
        .select("name price stock vendorId");

      if (!product) {
        return res.status(404).json({
          error: `Product not found: ${productId}`
        });
      }

      if (product.stock < qty) {
        return res.status(400).json({
          error:
            `Sorry, only ${product.stock} unit(s) of "${product.name}" available`
        });
      }

      validatedItems.push({
        productId: product._id,
        _id: product._id,
        name: product.name,
        price: Number(product.price),
        quantity: qty,
        vendorId: product.vendorId
      });
    }

    const totalAmount = validatedItems.reduce(
      (sum, item) => sum + (Number(item.price) * Number(item.quantity)),
      0
    );

    // BNPL must have a valid installment count.
    const installmentCount = Number(installments || 2);

    if (
      paymentMode === "bnpl" &&
      ![2, 3].includes(installmentCount)
    ) {
      return res.status(400).json({
        error: "Choose 2 or 3 installments"
      });
    }

    // BNPL eligibility.
    if (paymentMode === "bnpl") {
      if (totalAmount < 5000) {
        return res.status(400).json({
          error: "Minimum order amount for BNPL is ₦5,000"
        });
      }

      const completedOrders = await Order.countDocuments({
        email: user.email,
        status: "Delivered"
      });

      if (completedOrders < 3) {
        return res.status(403).json({
          error:
            `You need ${3 - completedOrders} more completed order(s) to unlock Buy Now Pay Later`
        });
      }
    }

    // Calculate the amount actually charged to the wallet.
    // For BNPL, split the total exactly so installments never
    // overcharge due to rounding.
    let walletCharge = totalAmount;
    let bnplPaymentAmounts = [];

    if (paymentMode === "bnpl") {
      const baseInstallment = Math.floor(totalAmount / installmentCount);
      const remainder = totalAmount - (baseInstallment * installmentCount);

      for (let i = 0; i < installmentCount; i++) {
        bnplPaymentAmounts.push(
          baseInstallment + (i < remainder ? 1 : 0)
        );
      }

      walletCharge = bnplPaymentAmounts[0];
    }

    if ((user.walletBalance || 0) < walletCharge) {
      return res.status(400).json({
        error:
          `Insufficient wallet balance. You need ₦${walletCharge.toLocaleString()} ` +
          `but have ₦${(user.walletBalance || 0).toLocaleString()}`
      });
    }

    // Final stock check immediately before charging the wallet.
    for (const item of validatedItems) {
      const currentProduct = await Product.findById(item.productId)
        .select("name stock");

      if (!currentProduct || currentProduct.stock < item.quantity) {
        return res.status(409).json({
          error:
            `"${item.name}" is no longer available in the requested quantity`
        });
      }
    }

    // Deduct wallet amount exactly once.
    user.walletBalance =
      (user.walletBalance || 0) - walletCharge;

    const referencePrefix =
      paymentMode === "bnpl" ? "BNPL-" : "ESC-";

    const reference =
      referencePrefix + Date.now();

    const trackingNumber =
      "TM" +
      Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase();

    user.walletTransactions.push({
      type: "debit",
      amount: walletCharge,
      description:
        paymentMode === "bnpl"
          ? `BNPL first installment for order ${trackingNumber}`
          : `Escrow hold for order ${trackingNumber}`,
      reference
    });

    await user.save();

    // Deduct stock.
    for (const item of validatedItems) {
      const updated = await Product.findOneAndUpdate(
        {
          _id: item.productId,
          stock: { $gte: item.quantity }
        },
        {
          $inc: { stock: -item.quantity }
        },
        { new: true }
      );

      if (!updated) {
        return res.status(409).json({
          error:
            `"${item.name}" is no longer available in the requested quantity`
        });
      }
    }

    const order = await Order.create({
      email: req.user.email,
      items: validatedItems,
      amount: totalAmount,
      originalAmount: totalAmount,
      deliveryFee: Number(deliveryFee) || 0,
      deliveryZone: deliveryZone || "",
      deliveryAddress: sanitize(deliveryAddress),
      phone: sanitize(phone),
      couponCode: couponCode || "",
      reference,
      trackingNumber,
      status: "Paid",
      paymentMethod:
        paymentMode === "bnpl"
          ? "BNPL"
          : "TechMart Wallet",
      escrow: paymentMode === "escrow",
      escrowStatus:
        paymentMode === "escrow"
          ? "holding"
          : "none",
      buyerConfirmed: false
    });

    // BNPL plan is created here so checkout is one complete operation.
    let plan = null;

    if (paymentMode === "bnpl") {
      // Build an exact repayment schedule so all installments
      // add up to totalAmount with no rounding discrepancy.
      const baseInstallment =
        Math.floor(totalAmount / installmentCount);

      const remainder =
        totalAmount - (baseInstallment * installmentCount);

      const now = new Date();
      const payments = [];

      for (let i = 0; i < installmentCount; i++) {
        // Distribute any remainder across the earliest installments.
        const paymentAmount =
          baseInstallment + (i < remainder ? 1 : 0);

        const dueDate = new Date(now);
        dueDate.setDate(
          dueDate.getDate() + (i * 30)
        );

        payments.push({
          amount: paymentAmount,
          dueDate,
          paidAt: i === 0 ? now : null,
          status: i === 0 ? "paid" : "pending"
        });
      }

      const installmentAmount = payments[0].amount;

      plan = await BNPLPlan.create({
        userId: req.user.id,
        orderId: order._id,
        totalAmount,
        installments: installmentCount,
        installmentAmount,
        paidInstallments: 1,
        payments
      });

      try {
        await updateNetworkScore(req.user.id, 100, {
          bnplCompleted: 1
        });
      } catch {}
    }

    res.json({
      success: true,
      order,
      plan,
      message:
        paymentMode === "bnpl"
          ? `Order placed! First BNPL installment of ₦${walletCharge.toLocaleString()} paid.`
          : `Order placed! ₦${totalAmount.toLocaleString()} held in escrow until delivery confirmed.`
    });

  } catch (err) {
    console.error("Checkout escrow/BNPL error:", err);

    res.status(500).json({
      error: "Checkout failed"
    });
  }
});


// 3. Mark order as Shipped (admin or seller)
app.post("/api/orders/:orderId/ship", auth, async (req, res) => {
  try {
    const { trackingNumber, courierName } = req.body;
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!["admin", "seller"].includes(req.user.role)) return res.status(403).json({ error: "Not authorized" });
    if (!["Paid", "Processing"].includes(order.status)) return res.status(400).json({ error: "Order cannot be marked as shipped" });

    order.status = "Shipped";
    if (trackingNumber) order.trackingNumber = trackingNumber;
    if (courierName) order.courierName = courierName;
    await order.save();

    io.to(order.email).emit("orderUpdated", { orderId: order._id, reference: order.reference, status: "Shipped", trackingNumber: order.trackingNumber });
    res.json({ success: true, order, message: "Order marked as shipped" });
  } catch (err) {
    res.status(500).json({ error: "Failed to mark as shipped" });
  }
});

// 4. Admin force release escrow (manual override)
app.post("/api/orders/:orderId/release-escrow", adminOnly, async (req, res) => {
  try {
    await releaseEscrowAtomically(req.params.orderId);

    res.json({
      success: true,
      message: "Escrow released to seller wallet"
    });
  } catch (err) {
    console.error("Admin escrow release error:", err.message);
    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to release escrow"
    });
  }
});

// 5. Seller requests withdrawal from wallet
app.post("/api/seller/withdraw", sellerAuth, async (req, res) => {
  try {
    const payout = await createSellerPayoutRequest(req.seller.id, req.body.amount);
    res.status(201).json({
      success: true,
      reference: payout.reference,
      message: `₦${payout.amount.toLocaleString()} reserved. Your withdrawal is awaiting admin approval and Paystack processing.`
    });
  } catch (err) {
    console.error("Seller withdrawal request error:", err.message);
    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Withdrawal request failed"
    });
  }
});

app.get("/api/seller/wallet", sellerAuth, async (req, res) => {
  try {
    const seller = await Seller.findById(req.seller.id).select("walletBalance walletTransactions name email");
    const earnings = (seller.walletTransactions || [])
      .filter(t => t.type === "credit" && t.description?.includes("Escrow"))
      .reduce((s, t) => s + t.amount, 0);
    const withdrawn = (seller.walletTransactions || [])
      .filter(t => t.type === "debit" && t.description?.includes("Withdrawal"))
      .reduce((s, t) => s + t.amount, 0);
    res.json({
      success: true,
      balance: seller.walletBalance || 0,
      totalEarnings: earnings,
      totalWithdrawn: withdrawn,
      recentTransactions: (seller.walletTransactions || []).slice(-10).reverse()
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch wallet" });
  }
});

// 7. Admin get all escrow orders
app.get("/api/admin/escrow", adminOnly, async (req, res) => {
  try {
    const orders = await Order.find({ escrow: true }).sort({ createdAt: -1 }).limit(50);
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch escrow orders" });
  }
});


/* ===========================
   🛒 CART PERSISTENCE
=========================== */
// Add cartItems to User schema handled via existing walletTransactions pattern
// We'll store cart in a simple field

// Sync cart to server
app.post("/api/cart/sync", auth, async (req, res) => {
  try {
    const { items } = req.body;
    await User.findByIdAndUpdate(req.user.id, { savedCart: items || [], cartUpdatedAt: items && items.length > 0 ? new Date() : null, cartReminderSent: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to sync cart" });
  }
});

// Get cart from server
app.get("/api/cart", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("savedCart");
    res.json({ items: user.savedCart || [] });
  } catch (err) {
    res.status(500).json({ error: "Failed to get cart" });
  }
});

// Clear cart on server
app.delete("/api/cart/clear", auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.id, { savedCart: [] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear cart" });
  }
});



/* ===============================
   TERMII DEBUG (TEMPORARY)
================================ */
app.get("/api/admin/termii/debug", adminOnly, async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.ng.termii.com/api/get-balance?api_key=${process.env.TERMII_API_KEY}`
    );

    res.json({
      success: true,
      workspace: response.data.application,
      user: response.data.user,
      balance: response.data.balance,
      currency: response.data.currency,
      senderId: process.env.TERMII_SENDER_ID,
      apiKeyLoaded: Boolean(process.env.TERMII_API_KEY)
    });

  } catch (err) {

    res.status(500).json({
      success: false,
      status: err.response?.status,
      data: err.response?.data,
      message: err.message
    });

  }
});


// Atomically deduct a BNPL installment so concurrent cron runs cannot double-charge.
async function deductBNPLInstallmentAtomically(planId, paymentIndex, today) {
  const session = await mongoose.startSession();

  try {
    let result = null;

    await session.withTransaction(async () => {
      const plan = await BNPLPlan.findOne({
        _id: planId,
        status: "active"
      }).session(session);

      if (!plan) return;

      const payment = plan.payments[paymentIndex];

      if (!payment) return;

      if (!["pending", "overdue"].includes(payment.status)) return;

      if (new Date(payment.dueDate) > today) return;

      const user = await User.findById(plan.userId).session(session);

      if (!user) return;

      if ((user.walletBalance || 0) < payment.amount) {
        payment.status = "overdue";
        await plan.save({ session });

        result = {
          status: "overdue",
          amount: payment.amount,
          userId: plan.userId
        };
        return;
      }

      user.walletBalance -= payment.amount;
      user.walletTransactions = user.walletTransactions || [];
      user.walletTransactions.push({
        type: "debit",
        amount: payment.amount,
        description: `BNPL installment ${paymentIndex + 1}/${plan.installments} auto-deducted`,
        reference: `BNPL-AUTO-${plan._id}-${paymentIndex}`
      });

      payment.paidAt = today;
      payment.status = "paid";
      plan.paidInstallments += 1;

      if (plan.paidInstallments >= plan.installments) {
        plan.status = "completed";
      }

      await user.save({ session });
      await plan.save({ session });

      result = {
        status: "paid",
        amount: payment.amount,
        userId: plan.userId,
        email: user.email,
        name: user.name,
        paidInstallments: plan.paidInstallments,
        installments: plan.installments
      };
    });

    return result;
  } finally {
    await session.endSession();
  }
}

// ── BNPL Auto-Deduction Cron (runs daily at 9am)
cron.schedule("0 9 * * *", async () => {
  const monitorStartedAt = Date.now();
  try {
    const today = new Date();
    const plans = await BNPLPlan.find({ status: "active" });
    for (const plan of plans) {
      for (let i = 0; i < plan.payments.length; i++) {
        const payment = plan.payments[i];
        if (!["pending", "overdue"].includes(payment.status)) continue;
        if (new Date(payment.dueDate) > today) continue;

        // Due — atomically try to auto-deduct
        const result = await deductBNPLInstallmentAtomically(
          plan._id,
          i,
          today
        );

        if (!result) continue;

        if (result.status === "paid") {
          console.log(
            `💳 BNPL auto-deducted ₦${result.amount} from ${result.email}`
          );

          // Send email reminder
          try {
            const { sendOTPEmail } = await import("./utils/email.js");
            await sendOTPEmail(
              result.email,
              result.name,
              `Your BNPL installment of ₦${result.amount.toLocaleString()} has been auto-deducted. ${result.paidInstallments}/${result.installments} paid.`
            );
          } catch {}
        } else if (result.status === "overdue") {
          console.warn(
            `⚠️ BNPL overdue for ${result.userId} — insufficient wallet balance`
          );
        }
      }
    }

    await recordSystemStatus("bnpl-auto-deduction", "healthy", {
      responseTimeMs: Date.now() - monitorStartedAt
    });
  } catch (e) {
    console.error("❌ BNPL cron error:", e.message);

    await recordSystemStatus("bnpl-auto-deduction", "down", {
      responseTimeMs: Date.now() - monitorStartedAt,
      error: e.message
    });
  }
});

// ── Auto Seller Payout Cron (every Friday at 10am)
cron.schedule("0 10 * * 5", async () => {
  const monitorStartedAt = Date.now();

  try {
    console.log("💸 Running auto seller payout...");

    const now = new Date();
    const payoutDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Lagos",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(now);

    const sellers = await Seller.find({
      status: "approved",
      "verification.bank.status": "verified",
      walletBalance: { $gte: 1000 },
      bankCode: { $exists: true, $nin: [null, ""] },
      bankName: { $exists: true, $nin: [null, ""] },
      accountNumber: { $regex: /^\d{10}$/ },
      accountName: { $exists: true, $nin: [null, ""] }
    }).lean();

    for (const candidate of sellers) {
      try {
        const reference = `auto-pay-${candidate._id}-${payoutDate}`;

        const existing = await Payout.findOne({
          reference,
          payoutType: "auto_weekly"
        });

        if (existing) {
          console.log(`ℹ️ Auto payout already exists for ${candidate.name}: ${reference}`);
          continue;
        }

        const session = await mongoose.startSession();
        let payout;

        try {
          await session.withTransaction(async () => {
            const seller = await Seller.findById(candidate._id).session(session);

            const normalizeAutoPayoutBankName = value =>
              String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

            const verifiedAccountName =
              seller?.verification?.bank?.verifiedAccountName;

            if (
              !seller ||
              seller.status !== "approved" ||
              seller.verification?.bank?.status !== "verified" ||
              !seller.bankCode ||
              !seller.bankName ||
              !/^\d{10}$/.test(String(seller.accountNumber || "")) ||
              !seller.accountName ||
              !verifiedAccountName ||
              normalizeAutoPayoutBankName(seller.accountName) !==
                normalizeAutoPayoutBankName(verifiedAccountName) ||
              seller.walletBalance < 1000
            ) {
              throw new Error("Seller is not eligible or no longer has enough available balance");
            }

            const amount = seller.walletBalance;

            const updatedSeller = await Seller.findOneAndUpdate(
              {
                _id: seller._id,
                walletBalance: amount
              },
              {
                $inc: { walletBalance: -amount },
                $push: {
                  walletTransactions: {
                    type: "debit",
                    amount,
                    description: `Auto weekly payout reserved — ${reference}`,
                    reference
                  }
                }
              },
              { new: true, session }
            );

            if (!updatedSeller) {
              throw new Error("Seller balance changed before payout reservation");
            }

            const created = await Payout.create([{
              sellerId: seller._id,
              sellerName: seller.name,
              sellerEmail: seller.email,
              storeName: seller.storeName,
              amount,
              bankCode: seller.bankCode,
              bankName: seller.bankName,
              accountNumber: seller.accountNumber,
              accountName: seller.accountName,
              reference,
              payoutType: "auto_weekly",
              transferStatus: "pending",
              status: "approved",
              fundsReserved: true,
              note: "Weekly automatic seller payout; funds reserved"
            }], { session });

            payout = created[0];
          });
        } finally {
          await session.endSession();
        }

        console.log(
          `🔒 Reserved ₦${payout.amount} for ${payout.sellerName} — ${reference}`
        );

        try {
          const recipientRes = await axios.post(
            "https://api.paystack.co/transferrecipient",
            {
              type: "nuban",
              name: payout.accountName || payout.sellerName,
              account_number: payout.accountNumber,
              bank_code: payout.bankCode,
              currency: "NGN"
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
              }
            }
          );

          const recipientCode = recipientRes.data.data.recipient_code;

          const transferRes = await axios.post(
            "https://api.paystack.co/transfer",
            {
              source: "balance",
              amount: payout.amount * 100,
              recipient: recipientCode,
              reason: `TechMart weekly payout for ${payout.sellerName}`,
              reference
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
              }
            }
          );

          const transfer = transferRes.data.data;

          await Payout.findByIdAndUpdate(payout._id, {
            transferStatus: "processing",
            transferCode: transfer?.transfer_code || null,
            transferId: transfer?.id ? String(transfer.id) : null,
            note: "Paystack transfer submitted; awaiting final webhook status"
          });

          console.log(
            `⏳ Auto payout submitted ₦${payout.amount} to ${payout.sellerName} — ${reference}`
          );
        } catch (transferError) {
          console.error(
            `❌ Auto payout transfer failed for ${payout.sellerName}:`,
            transferError.response?.data || transferError.message
          );

          await Payout.findByIdAndUpdate(payout._id, {
            transferStatus: "processing",
            note: `Paystack transfer requires reconciliation: ${transferError.message}`
          });
        }
      } catch (e) {
        console.error(
          `❌ Auto payout preparation failed for ${candidate.name}:`,
          e.message
        );
      }
    }

    await recordSystemStatus("auto-seller-payout", "healthy", {
      responseTimeMs: Date.now() - monitorStartedAt
    });
  } catch (e) {
    console.error("❌ Auto payout cron error:", e.message);

    await recordSystemStatus("auto-seller-payout", "down", {
      responseTimeMs: Date.now() - monitorStartedAt,
      error: e.message
    });
  }
}, { timezone: "Africa/Lagos" });

// ── Seller Payout Reconciliation Cron (every 30 minutes)
cron.schedule("*/30 * * * *", async () => {
  const monitorStartedAt = Date.now();

  try {
    const payouts = await Payout.find({
      $or: [
        { status: "approved" },
        { status: "pending", payoutType: "auto_weekly" }
      ],
      transferStatus: { $in: ["pending", "processing"] },
      reference: { $exists: true, $ne: "" }
    }).limit(50);

    for (const payout of payouts) {
      try {
        let transfer;

        try {
          const verifyRes = await axios.get(
            `https://api.paystack.co/transfer/verify/${encodeURIComponent(payout.reference)}`,
            {
              headers: {
                Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
              },
              timeout: 15000
            }
          );

          transfer = verifyRes.data?.data;
        } catch (verifyError) {
          const notFound = verifyError.response?.status === 404;

          // Only an untouched automatic payout may be submitted here.
          // Processing payouts are never blindly retried after an ambiguous result.
          if (
            !notFound ||
            payout.payoutType !== "auto_weekly" ||
            payout.transferStatus !== "pending"
          ) {
            throw verifyError;
          }

          const claimed = await Payout.findOneAndUpdate(
            {
              _id: payout._id,
              payoutType: "auto_weekly",
              transferStatus: "pending",
              status: { $in: ["approved", "pending"] }
            },
            {
              $set: {
                transferStatus: "processing",
                note: "Recovery claimed payout; submitting transfer with original reference"
              }
            },
            { new: true }
          );

          if (!claimed) continue;

          try {
            const recipientRes = await axios.post(
              "https://api.paystack.co/transferrecipient",
              {
                type: "nuban",
                name: claimed.accountName || claimed.sellerName,
                account_number: claimed.accountNumber,
                bank_code: claimed.bankCode,
                currency: "NGN"
              },
              {
                headers: {
                  Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
                },
                timeout: 15000
              }
            );

            const recipientCode = recipientRes.data?.data?.recipient_code;
            if (!recipientCode) {
              throw new Error("Paystack did not return a transfer recipient code");
            }

            const transferRes = await axios.post(
              "https://api.paystack.co/transfer",
              {
                source: "balance",
                amount: Math.round(Number(claimed.amount) * 100),
                recipient: recipientCode,
                reason: `TechMart recovered weekly payout for ${claimed.sellerName}`,
                reference: claimed.reference
              },
              {
                headers: {
                  Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
                },
                timeout: 20000
              }
            );

            const submitted = transferRes.data?.data;

            await Payout.findOneAndUpdate(
              { _id: claimed._id, transferStatus: "processing" },
              {
                $set: {
                  transferCode: submitted?.transfer_code || claimed.transferCode,
                  transferId: submitted?.id ? String(submitted.id) : claimed.transferId,
                  note: "Recovered transfer submitted; awaiting Paystack confirmation"
                }
              }
            );

            console.log(`Recovered pending automatic payout: ${claimed.reference}`);
          } catch (submitError) {
            await Payout.findOneAndUpdate(
              { _id: claimed._id, transferStatus: "processing" },
              {
                $set: {
                  note: `Recovery submission outcome requires Paystack verification: ${submitError.message}`
                }
              }
            );

            console.error(
              `Automatic payout recovery requires verification ${claimed.reference}:`,
              submitError.response?.data || submitError.message
            );
          }

          continue;
        }

        const transferStatus = transfer?.status;
        if (!transferStatus) {
          console.warn(`Paystack verification returned no status: ${payout.reference}`);
          continue;
        }

        if (transferStatus === "success") {
          const updated = await Payout.findOneAndUpdate(
            {
              _id: payout._id,
              transferStatus: { $in: ["pending", "processing"] },
              status: { $in: ["approved", "pending"] }
            },
            {
              $set: {
                transferStatus: "success",
                status: "paid",
                fundsReserved: false,
                transferCode: transfer.transfer_code || payout.transferCode,
                transferId: transfer.id ? String(transfer.id) : payout.transferId,
                processedAt: new Date(),
                note: "Paystack transfer confirmed successful by reconciliation"
              }
            },
            { new: true }
          );

          console.log(updated
            ? `Payout reconciled successful: ${payout.reference}`
            : `Terminal or duplicate payout success ignored: ${payout.reference}`);
          continue;
        }

        if (["failed", "reversed", "abandoned", "blocked", "rejected"].includes(transferStatus)) {
          const session = await mongoose.startSession();

          try {
            await session.withTransaction(async () => {
              const current = await Payout.findById(payout._id).session(session);

              if (
                !current ||
                ["success", "failed", "reversed"].includes(current.transferStatus)
              ) return;

              const seller = await Seller.findById(current.sellerId).session(session);
              if (!seller) {
                throw new Error(`Seller not found for payout ${payout.reference}`);
              }

              const hasLegacyAutoReservation =
                current.payoutType === "auto_weekly" &&
                (seller.walletTransactions || []).some(transaction =>
                  transaction.reference === current.reference &&
                  transaction.type === "debit" &&
                  Number(transaction.amount) === Number(current.amount)
                );

              if (current.fundsReserved === true || hasLegacyAutoReservation) {
                const refundReference = `REFUND-${current.reference}`;
                const alreadyRefunded = (seller.walletTransactions || []).some(
                  transaction => transaction.reference === refundReference
                );

                if (!alreadyRefunded) {
                  seller.walletBalance = Number(seller.walletBalance || 0) + current.amount;
                  seller.walletTransactions = seller.walletTransactions || [];
                  seller.walletTransactions.push({
                    type: "credit",
                    amount: current.amount,
                    description: `Seller payout returned — ${current.reference}`,
                    reference: refundReference
                  });
                  await seller.save({ session });
                }

                current.fundsReserved = false;
              }

              current.transferStatus = transferStatus === "reversed" ? "reversed" : "failed";
              current.status = "rejected";
              current.processedAt = new Date();
              current.transferCode = transfer.transfer_code || current.transferCode;
              current.transferId = transfer.id ? String(transfer.id) : current.transferId;
              current.note = `Paystack confirmed terminal transfer status "${transferStatus}"; reserved funds returned where applicable`;

              await current.save({ session });
            });
          } finally {
            await session.endSession();
          }

          console.log(`Payout reconciled ${transferStatus}: ${payout.reference}`);
          continue;
        }

        // A transfer already known to Paystack remains processing until terminal confirmation.
        if (["pending", "otp", "queued", "received"].includes(transferStatus)) {
          await Payout.findOneAndUpdate(
            {
              _id: payout._id,
              transferStatus: { $in: ["pending", "processing"] },
              status: { $in: ["approved", "pending"] }
            },
            {
              $set: {
                transferStatus: "processing",
                transferCode: transfer.transfer_code || payout.transferCode,
                transferId: transfer.id ? String(transfer.id) : payout.transferId,
                note: `Paystack transfer status: ${transferStatus}; awaiting final confirmation`
              }
            }
          );
        }
      } catch (e) {
        console.error(
          `Payout reconciliation failed for ${payout.reference}:`,
          e.response?.data || e.message
        );
      }
    }

    await recordSystemStatus("auto-seller-payout-reconciliation", "healthy", {
      responseTimeMs: Date.now() - monitorStartedAt
    });
  } catch (e) {
    console.error("Seller payout reconciliation cron error:", e.message);

    await recordSystemStatus("auto-seller-payout-reconciliation", "down", {
      responseTimeMs: Date.now() - monitorStartedAt,
      error: e.message
    });
  }
});

// ── Sponsored Listing Expiry Cron (runs daily at midnight)
cron.schedule("0 0 * * *", async () => {
  const monitorStartedAt = Date.now();
  try {
    const expired = await SponsoredListing.updateMany(
      { status: "active", expiresAt: { $lte: new Date() } },
      { $set: { status: "expired" } }
    );
    if (expired.modifiedCount > 0) console.log(`📢 ${expired.modifiedCount} sponsored listing(s) expired`);

    await recordSystemStatus("sponsored-listing-expiry", "healthy", {
      responseTimeMs: Date.now() - monitorStartedAt
    });
  } catch (e) {
    console.error("❌ Sponsored listing cron error:", e.message);

    await recordSystemStatus("sponsored-listing-expiry", "down", {
      responseTimeMs: Date.now() - monitorStartedAt,
      error: e.message
    });
  }
});

// ── AI Pro Expiry Cron (runs daily at 1am)
cron.schedule("0 1 * * *", async () => {
  const monitorStartedAt = Date.now();
  try {
    const expired = await User.updateMany(
      { aiPro: true, aiProExpiry: { $lte: new Date() } },
      { $set: { aiPro: false } }
    );
    if (expired.modifiedCount > 0) console.log(`🤖 ${expired.modifiedCount} AI Pro subscription(s) expired`);

    await recordSystemStatus("ai-pro-expiry", "healthy", {
      responseTimeMs: Date.now() - monitorStartedAt
    });
  } catch (e) {
    console.error("❌ AI Pro expiry cron error:", e.message);

    await recordSystemStatus("ai-pro-expiry", "down", {
      responseTimeMs: Date.now() - monitorStartedAt,
      error: e.message
    });
  }
});

// ── AI Seller Coach Cron (every Friday at 6pm)
cron.schedule("0 18 * * 5", async () => {
  const monitorStartedAt = Date.now();
  try {
    console.log("🤖 Running AI Seller Coach...");
    const sellers = await Seller.find({ email: { $exists: true } }).select("name email _id");
    for (const seller of sellers) {
      try {
        const orders = await Order.find({ "items.vendorId": seller._id.toString(), status: { $in: ["Paid", "Shipped", "Delivered"] } });
        const products = await Product.find({ vendorId: seller._id.toString() }).select("name stock price");
        const totalRevenue = orders.reduce((s, o) => s + (o.amount || 0), 0);
        const lowStock = products.filter(p => (p.stock || 0) <= 5);
        const thisWeek = orders.filter(o => new Date(o.createdAt) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

        const prompt = `You are TechMart AI Seller Coach. Analyze this seller's data and give 3 specific, actionable tips to improve their sales this week. Be direct and practical.

Seller: ${seller.name}
Total Revenue: ₦${totalRevenue.toLocaleString()}
Orders This Week: ${thisWeek.length}
Total Products: ${products.length}
Low Stock Products: ${lowStock.map(p => p.name).join(", ") || "None"}
Total Orders: ${orders.length}

Give exactly 3 tips numbered 1, 2, 3. Each tip should be 1-2 sentences. Focus on what will make the most difference this week.`;

        const groq = (await import("groq")).default;
        const groqClient = new groq({ apiKey: process.env.GROQ_API_KEY });
        const completion = await groqClient.chat.completions.create({
          model: "openai/gpt-oss-20b",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 300
        });
        const tips = completion.choices[0]?.message?.content || "Keep listing quality products and responding to buyers quickly!";

        const { sendAbandonedCartEmail } = await import("./utils/email.js");
        // Reuse email infrastructure with custom HTML
        const html = `
          <div style="background:#0a0a0a;padding:32px;font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border-radius:12px;">
            <h1 style="color:#f97316;font-size:22px;margin:0 0 4px;">TechMart</h1>
            <p style="color:#888;font-size:12px;margin:0 0 20px;">AI Seller Coach — Weekly Insights</p>
            <h2 style="color:#ffffff;font-size:18px;margin:0 0 16px;">Hi ${seller.name}, here's your weekly AI coaching 🤖</h2>
            <div style="background:#111;border-radius:10px;padding:20px;margin-bottom:20px;">
              <div style="display:flex;gap:16px;flex-wrap:wrap;">
                <div style="flex:1;min-width:120px;background:#1a0a00;border:1px solid #f97316;border-radius:8px;padding:12px;text-align:center;">
                  <p style="color:#888;font-size:11px;margin:0 0 4px;">WEEKLY ORDERS</p>
                  <p style="color:#f97316;font-size:22px;font-weight:900;margin:0;">${thisWeek.length}</p>
                </div>
                <div style="flex:1;min-width:120px;background:#0a1a0a;border:1px solid #22c55e;border-radius:8px;padding:12px;text-align:center;">
                  <p style="color:#888;font-size:11px;margin:0 0 4px;">TOTAL REVENUE</p>
                  <p style="color:#22c55e;font-size:22px;font-weight:900;margin:0;">₦${totalRevenue.toLocaleString()}</p>
                </div>
                <div style="flex:1;min-width:120px;background:#1a1a0a;border:1px solid #f59e0b;border-radius:8px;padding:12px;text-align:center;">
                  <p style="color:#888;font-size:11px;margin:0 0 4px;">LOW STOCK</p>
                  <p style="color:#f59e0b;font-size:22px;font-weight:900;margin:0;">${lowStock.length}</p>
                </div>
              </div>
            </div>
            <h3 style="color:#f97316;font-size:16px;margin:0 0 12px;">🎯 Your 3 AI Tips for This Week</h3>
            <div style="background:#111;border-radius:10px;padding:20px;margin-bottom:20px;color:#ccc;font-size:14px;line-height:1.8;white-space:pre-line;">${tips}</div>
            ${lowStock.length > 0 ? `<div style="background:#1a0a00;border:1px solid #dc2626;border-radius:10px;padding:16px;margin-bottom:20px;"><p style="color:#dc2626;font-weight:700;margin:0 0 8px;">⚠️ Restock Alert</p><p style="color:#888;font-size:13px;margin:0;">${lowStock.map(p => `${p.name} (${p.stock} left)`).join(", ")}</p></div>` : ""}
            <a href="${process.env.FRONTEND_URL || "https://techmart-frontend.onrender.com"}/seller/dashboard" style="display:block;text-align:center;padding:14px;background:linear-gradient(135deg,#f97316,#dc2626);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">📊 View My Dashboard →</a>
            <p style="color:#333;font-size:11px;text-align:center;margin:16px 0 0;">TechMart AI Seller Coach — Powered by Groq AI</p>
          </div>`;

        const { default: BrevoModule } = await import("@getbrevo/brevo");
        const brevoClient = new BrevoModule.BrevoClient({ apiKey: process.env.BREVO_API_KEY?.trim() });
        await brevoClient.transactionalEmails.sendTransacEmail({
          sender: { email: "michaelwill326@gmail.com", name: "TechMart AI Coach" },
          to: [{ email: seller.email, name: seller.name }],
          subject: `🤖 Your Weekly AI Coaching is Ready, ${seller.name.split(" ")[0]}!`,
          htmlContent: html
        });
        console.log(`🤖 AI Coach email sent to ${seller.email}`);
      } catch (sellerErr) {
        console.error(`❌ AI Coach failed for ${seller.email}:`, sellerErr.message);
      }
    }

    await recordSystemStatus("ai-seller-coach", "healthy", {
      responseTimeMs: Date.now() - monitorStartedAt
    });
  } catch (e) {
    console.error("❌ AI Seller Coach cron error:", e.message);

    await recordSystemStatus("ai-seller-coach", "down", {
      responseTimeMs: Date.now() - monitorStartedAt,
      error: e.message
    });
  }
});

// ── Gift Card Expiry Cron (runs daily at midnight)
cron.schedule("0 0 * * *", async () => {
  const monitorStartedAt = Date.now();
  try {
    const expired = await GiftCard.updateMany(
      { status: "active", expiresAt: { $lte: new Date() } },
      { $set: { status: "expired" } }
    );
    if (expired.modifiedCount > 0) console.log(`🎁 ${expired.modifiedCount} gift card(s) expired`);
    await recordSystemStatus("gift-card-expiry", "healthy", {
      responseTimeMs: Date.now() - monitorStartedAt
    });
  } catch (e) {
    console.error("❌ Gift card expiry cron error:", e.message);

    await recordSystemStatus("gift-card-expiry", "down", {
      responseTimeMs: Date.now() - monitorStartedAt,
      error: e.message
    });
  }
});

// ── Savings Vault Maturity Cron (runs daily at 8am)
// ── Auto Wallet Reconciliation Cron (daily at 3am)
cron.schedule("0 3 * * *", async () => {
  const monitorStartedAt = Date.now();
  try {
    console.log("🔄 Running auto wallet reconciliation...");
    const response = await axios.get("https://api.paystack.co/transaction", {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      params: { perPage: 100, status: "success" }
    });
    const walletTxns = response.data.data.filter(t =>
      t.reference.startsWith("WAL-") ||
      t.metadata?.purpose === "wallet_funding"
    );
    let fixed = 0;
    for (const txn of walletTxns) {
      let user = null;
      if (txn.metadata?.userId) user = await User.findById(txn.metadata.userId);
      if (!user && txn.customer?.email) user = await User.findOne({ email: txn.customer.email.toLowerCase().trim() });
      if (!user) continue;
      const alreadyCredited = (user.walletTransactions || []).some(t => t.reference === txn.reference);
      if (alreadyCredited) continue;
      const amount = txn.amount / 100;
      user.walletBalance = (user.walletBalance || 0) + amount;
      user.walletTransactions = user.walletTransactions || [];
      user.walletTransactions.push({
        type: "credit",
        amount,
        description: "Wallet funded via Paystack (auto-reconciled)",
        reference: txn.reference,
        createdAt: new Date(txn.paid_at)
      });
      await user.save();
      fixed++;
      console.log(`✅ Auto-reconciled: ${user.email} +₦${amount} [${txn.reference}]`);
    }
    console.log(`🔄 Auto reconciliation done: ${fixed} transaction(s) fixed`);

    await recordSystemStatus("auto-wallet-reconciliation", "healthy", {
      responseTimeMs: Date.now() - monitorStartedAt
    });
  } catch (e) {
    console.error("❌ Auto reconciliation error:", e.message);

    await recordSystemStatus("auto-wallet-reconciliation", "down", {
      responseTimeMs: Date.now() - monitorStartedAt,
      error: e.message
    });
  }
});

cron.schedule("0 8 * * *", async () => {
  const monitorStartedAt = Date.now();
  try {
    const now = new Date();
    const maturedVaults = await SavingsVault.find({ status: "active", maturityDate: { $lte: now }, interestCredited: false });
    for (const vault of maturedVaults) {
      vault.status = "matured";
      await vault.save();
      console.log(`🏦 Vault matured for user ${vault.userId}: ₦${vault.amount} + ₦${vault.expectedInterest} interest`);
    }
    console.log(`🏦 Vault maturity check: ${maturedVaults.length} vault(s) matured`);

    await recordSystemStatus("savings-vault-maturity", "healthy", {
      responseTimeMs: Date.now() - monitorStartedAt
    });
  } catch (e) {
    console.error("❌ Vault cron error:", e.message);

    await recordSystemStatus("savings-vault-maturity", "down", {
      responseTimeMs: Date.now() - monitorStartedAt,
      error: e.message
    });
  }
});

// ── Abandoned Cart Recovery Cron (runs every 15 mins) ──
cron.schedule("*/15 * * * *", async () => {
  const monitorStartedAt = Date.now();
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const users = await User.find({
      cartUpdatedAt: { $lte: oneHourAgo },
      cartReminderSent: false,
      savedCart: { $exists: true, $ne: [] }
    }).select("name email savedCart cartUpdatedAt");

    for (const user of users) {
      if (!user.savedCart || user.savedCart.length === 0) continue;
      try {
        await sendAbandonedCartEmail(user, user.savedCart);
        await User.findByIdAndUpdate(user._id, { cartReminderSent: true });
        console.log("📧 Abandoned cart email sent to " + user.email);
      } catch (e) {
        console.error("❌ Failed to send cart email to " + user.email + ":", e.message);
      }
    }
    await recordSystemStatus("abandoned-cart-recovery", "healthy", {
      responseTimeMs: Date.now() - monitorStartedAt
    });
  } catch (e) {
    console.error("❌ Abandoned cart cron error:", e.message);

    await recordSystemStatus("abandoned-cart-recovery", "down", {
      responseTimeMs: Date.now() - monitorStartedAt,
      error: e.message
    });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
// --- ADMIN FILE UPLOAD ROUTE INTEGRATION ---
// Product model already imported above

app.post("/api/admin/products/add", adminOnly, adminUploader.array("images", 5), async (req, res) => {
  try {
    let imageUrls = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const result = await cloudinaryCloud.uploader.upload(file.path, {
          folder: "techmart_products"
        });
        imageUrls.push(result.secure_url);
      }
    } else if (req.body.images) {
      imageUrls = Array.isArray(req.body.images) ? req.body.images : [req.body.images];
    } else {
      return res.status(400).json({ message: "Product image asset is required." });
    }
    let variants = null;

    try {
      if (req.body.variants) {
        variants = JSON.parse(req.body.variants);
      }
    } catch (err) {
      console.warn("⚠️ Invalid variants JSON received.");
    }

    if (!Array.isArray(variants) || variants.length === 0) {
      variants = [{
        name: "Default",
        color: "",
        size: "",
        storage: "",
        condition: req.body.condition || "New",
        price: Number(req.body.price),
        stock: Number(req.body.stock)
      }];
    }

    const newProduct = new Product({
      name: req.body.name,
      price: Number(req.body.price),
      description: req.body.description,
      stock: Number(req.body.stock),
      category: req.body.category || "",
      condition: req.body.condition || "New",
      images: imageUrls,
      variants
    });
    await newProduct.save();
    res.status(201).json({ success: true, data: newProduct });
  } catch (error) {
    console.error("UPLOAD EXCEPTION:", error);
    res.status(500).json({ message: error.message });
  }
});
// deploy trigger




// 🔍 View Webhook Logs (Admin)
app.get("/api/admin/webhook-logs", adminOnly, async (req, res) => {
  try {
    const logs = await WebhookEvent.find().sort({ processedAt: -1 }).limit(50);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch webhook logs" });
  }
});

/* ===========================
   🔄 PAYSTACK RECONCILIATION (admin)
=========================== */
// Catches wallet-funding payments that succeeded on Paystack but never
// got credited (e.g. a missed/failed webhook delivery) and credits them.
app.post("/api/admin/reconcile-wallets", adminOnly, async (req, res) => {
  try {
    const response = await axios.get("https://api.paystack.co/transaction", {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      params: { perPage: 100, status: "success" }
    });
    // Match by WAL- prefix OR by wallet_funding metadata purpose
    const walletTxns = response.data.data.filter(t =>
      t.reference.startsWith("WAL-") ||
      t.metadata?.purpose === "wallet_funding"
    );
    const fixed = [];
    for (const txn of walletTxns) {
      // Try userId from metadata first, fall back to email
      let user = null;
      if (txn.metadata?.userId) {
        user = await User.findById(txn.metadata.userId);
      }
      if (!user && txn.customer?.email) {
        user = await User.findOne({ email: txn.customer.email.toLowerCase().trim() });
      }
      if (!user) {
        console.warn("Reconcile: user not found for", txn.reference);
        continue;
      }
      const alreadyCredited = (user.walletTransactions || []).some(t => t.reference === txn.reference);
      if (alreadyCredited) continue;
      const amount = txn.amount / 100;
      user.walletBalance = (user.walletBalance || 0) + amount;
      user.walletTransactions = user.walletTransactions || [];
      user.walletTransactions.push({
        type: "credit",
        amount,
        description: "Wallet funded via Paystack (reconciled)",
        reference: txn.reference,
        createdAt: new Date(txn.paid_at)
      });
      await user.save();
      fixed.push({ email: user.email, amount, reference: txn.reference });
      console.log(`✅ Reconciled: ${user.email} +₦${amount} [${txn.reference}]`);
    }
    res.json({ success: true, checked: walletTxns.length, fixed: fixed.length, details: fixed });
  } catch (err) {
    console.error("Reconciliation error:", err.message);
    res.status(500).json({ error: "Reconciliation failed" });
  }
});

/* ===========================
   ��️ GLOBAL ERROR HANDLING
=========================== */

/* ===========================
   🔄 PAYSTACK RECONCILIATION (admin)
=========================== */
// Multer-specific error handler (must come before the generic error handler)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Image too large. Maximum file size is 5MB." });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err && err.message && err.message.includes("Only images")) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// Global Express error handler
app.use((err, req, res, next) => {
  console.error("🔥 Unhandled error:", err.message, err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === "production"
      ? "An unexpected error occurred. Please try again."
      : err.message
  });
});

// Ajo Group Routes
app.post("/api/pay/ajo/create", auth, async (req, res) => {
  try {
    const { name, description, contributionAmount, frequency, maxMembers } = req.body;
    if (!name || !contributionAmount) return res.status(400).json({ error: "Name and amount required" });
    const user = await User.findById(req.user.id);
    const inviteCode = Math.random().toString(36).substring(2,8).toUpperCase();
    const group = await AjoGroup.create({ name, description, creatorId:req.user.id, contributionAmount:Number(contributionAmount), frequency:frequency||"monthly", maxMembers:Math.min(Number(maxMembers)||10,20), inviteCode, members:[{userId:req.user.id,name:user.name,position:1,hasPaid:false}], nextPayoutDate:new Date(Date.now()+30*24*60*60*1000) });
    if (!user.ajoGroups) user.ajoGroups = [];
    user.ajoGroups.push(group._id); await user.save();
    res.json({ success:true, group, inviteCode });
  } catch (err) { res.status(500).json({ error: "Failed to create group" }); }
});
app.post("/api/pay/ajo/join", auth, async (req, res) => {
  try {
    const { inviteCode } = req.body;
    if (!inviteCode) return res.status(400).json({ error: "Invite code required" });
    const group = await AjoGroup.findOne({ inviteCode: inviteCode.toUpperCase() });
    if (!group) return res.status(404).json({ error: "Group not found" });
    if (group.status !== "open") return res.status(400).json({ error: "Group is no longer accepting members" });
    if (group.members.length >= group.maxMembers) return res.status(400).json({ error: "Group is full" });
    if (group.members.find(m => m.userId.toString() === req.user.id)) return res.status(400).json({ error: "Already a member" });
    const user = await User.findById(req.user.id);
    group.members.push({ userId:req.user.id, name:user.name, position:group.members.length+1, hasPaid:false });
    if (group.members.length === group.maxMembers) group.status = "active";
    await group.save();
    if (!user.ajoGroups) user.ajoGroups = [];
    user.ajoGroups.push(group._id); await user.save();
    res.json({ success:true, group });
  } catch (err) { res.status(500).json({ error: "Failed to join" }); }
});
app.get("/api/pay/ajo", auth, async (req, res) => {
  try { const groups = await AjoGroup.find({ "members.userId": req.user.id }).lean(); res.json({ success:true, groups }); }
  catch (err) { res.status(500).json({ error: "Failed to fetch" }); }
});
app.post("/api/pay/ajo/:groupId/contribute", auth, async (req, res) => {
  try {
    const group = await AjoGroup.findById(req.params.groupId);
    if (!group) return res.status(404).json({ error: "Group not found" });
    const member = group.members.find(m => m.userId.toString() === req.user.id);
    if (!member) return res.status(403).json({ error: "Not a member" });
    if (member.hasPaid) return res.status(400).json({ error: "Already contributed this round" });
    const user = await User.findById(req.user.id);
    if (user.walletBalance < group.contributionAmount) return res.status(400).json({ error: "Insufficient wallet balance" });
    user.walletBalance -= group.contributionAmount;
    user.walletTransactions.push({ type:"debit", amount:group.contributionAmount, description:`Ajo contribution: ${group.name}`, reference:"AJO-"+Date.now(), channel:"ajo", status:"completed" });
    member.hasPaid = true; member.paidAt = new Date();
    group.totalPot = (group.totalPot||0) + group.contributionAmount;
    await Promise.all([user.save(), group.save()]);
    const allPaid = group.members.every(m=>m.hasPaid);
    if (allPaid && group.currentRecipient) {
      const recipient = await User.findById(group.currentRecipient);
      if (recipient) {
        recipient.walletBalance = (recipient.walletBalance||0) + group.totalPot;
        recipient.walletTransactions.push({ type:"credit", amount:group.totalPot, description:`Ajo payout: ${group.name}`, reference:"AJO-PAYOUT-"+Date.now(), channel:"ajo", status:"completed" });
        await recipient.save();
        group.members.forEach(m=>{m.hasPaid=false;m.paidAt=null;}); group.totalPot=0; group.currentRound=(group.currentRound||1)+1;
        const nextIdx = group.currentRound % group.members.length; group.currentRecipient = group.members[nextIdx]?.userId;
        group.nextPayoutDate = new Date(Date.now()+(group.frequency==="weekly"?7:30)*24*60*60*1000);
        await group.save();
      }
    }
    res.json({ success:true, message:`₦${group.contributionAmount.toLocaleString()} contributed to ${group.name}`, allPaid });
  } catch (err) { res.status(500).json({ error: "Contribution failed" }); }
});



/* ===========================
   📱 PHONE CHECKER
=========================== */

app.post("/api/phone-checker/imei", auth, async (req, res) => {
  try {
    const { imei } = req.body;

    if (!imei || !/^\d{15}$/.test(String(imei).trim())) {
      return res.status(400).json({
        error: "Please enter a valid 15-digit IMEI number"
      });
    }

    const cleanImei = String(imei).trim();

    // IMEI Luhn checksum validation
    const digits = cleanImei.split("").map(Number);
    let sum = 0;

    for (let i = 0; i < 15; i++) {
      let d = digits[i];

      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }

      sum += d;
    }

    if (sum % 10 !== 0) {
      return res.status(400).json({
        error: "Invalid IMEI checksum. Please double-check the number."
      });
    }

    if (!process.env.IMEICHECK_API_KEY) {
      console.error("IMEICHECK_API_KEY is missing");
      return res.status(503).json({
        error: "IMEI verification service is not configured.",
        code: "IMEI_PROVIDER_NOT_CONFIGURED"
      });
    }

    let blacklistData, deviceData;

    try {
      const headers = {
        Authorization: "Bearer " + process.env.IMEICHECK_API_KEY,
        "Content-Type": "application/json"
      };

      const providerRes = await axios.post(
        "https://api.imeicheck.net/v1/checks",
        { deviceId: cleanImei, serviceId: 12 },
        { headers, timeout: 15000 }
      );

      blacklistData = providerRes.data;
      deviceData = providerRes.data;

    } catch (providerErr) {
      console.error("IMEICheck provider error:", providerErr.message);
      return res.status(502).json({
        error: "IMEI verification service is currently unavailable. Please try again later.",
        code: "IMEI_PROVIDER_UNAVAILABLE"
      });
    }

    if (!blacklistData) {
      return res.status(502).json({
        error: "IMEI verification service returned no data.",
        code: "IMEI_NO_DATA"
      });
    }


    const properties = { ...( deviceData?.properties || {}), ...(blacklistData.properties || {}) };

    const blacklistRaw =
      properties.gsmaBlacklisted ??
      properties.blacklistStatus ??
      properties.blackListStatus ??
      properties.blacklist ??
      properties.blackListed ??
      properties.usaBlockStatus ??
      properties.blockStatus ??
      null;

    const blacklistText = blacklistRaw == null
      ? ""
      : String(blacklistRaw).toLowerCase();

    let blacklistStatus = "unknown";

    if (
      blacklistText.includes("clean") ||
      blacklistText === "false" ||
      blacklistText === "no"
    ) {
      blacklistStatus = "pass";
    } else if (
      blacklistText.includes("blacklist") ||
      blacklistText.includes("blocked") ||
      blacklistText.includes("stolen") ||
      blacklistText.includes("reported") ||
      blacklistText === "true" ||
      blacklistText === "yes"
    ) {
      blacklistStatus = "fail";
    }

    let verdict = "UNVERIFIED";
    let riskLevel = "medium";

    if (blacklistStatus === "pass") {
      verdict = "CLEAN";
      riskLevel = "low";
    } else if (blacklistStatus === "fail") {
      verdict = "BLACKLISTED";
      riskLevel = "high";
    }

    const deviceName =
      properties.deviceName ||
      properties.modelDesc ||
      properties.model ||
      "Unknown";

    const brand =
      properties.brand ||
      properties.manufacturer ||
      (/^iphone\b/i.test(deviceName) ? "Apple" :
       /^ipad\b/i.test(deviceName) ? "Apple" :
       /^redmi\b/i.test(deviceName) ? "Xiaomi" :
       /^mi\b/i.test(deviceName) ? "Xiaomi" :
       /^galaxy\b/i.test(deviceName) ? "Samsung" :
       "Unknown");

    const manufactureYear =
      properties.manufactureYear ||
      properties.year ||
      "Unknown";

    const estimatedPurchaseYear =
      properties.estPurchaseDate
        ? new Date(Number(properties.estPurchaseDate) * 1000).getUTCFullYear()
        : "Unknown";

    const result = {
      verdict,
      riskLevel,
      summary:
        blacklistStatus === "pass"
          ? "The IMEIcheck provider reports this IMEI as clean."
          : blacklistStatus === "fail"
            ? "The IMEIcheck provider reports this IMEI as blacklisted or blocked."
            : "The IMEI was validated, but the provider did not return a definitive blacklist status.",
      deviceInfo: {
        brand,
        model: deviceName,
        manufactureYear,
        estimatedPurchaseYear,
        refurbished:
          typeof properties.refurbished === "boolean"
            ? (properties.refurbished ? "Yes" : "No")
            : "Unknown",
        purchaseCountry: properties.purchaseCountry || "Unknown",
        region: properties["apple/region"] || "Unknown",
        network: properties.network || "Unknown"
      },
      checks: [
        {
          label: "IMEI Valid",
          status: "pass",
          detail: "The IMEI passed the 15-digit format and checksum validation."
        },
        {
          label: "Blacklist Status",
          status: blacklistStatus,
          detail:
            blacklistRaw == null
              ? "The provider did not return a definitive blacklist status."
              : String(blacklistRaw)
        },
        {
          label: "Lost Mode",
          status:
            properties.lostMode === true
              ? "fail"
              : properties.lostMode === false
                ? "pass"
                : "unknown",
          detail:
            properties.lostMode === true
              ? "The provider reports that this device is currently in Lost Mode."
              : properties.lostMode === false
                ? "The provider reports that Lost Mode is not active."
                : "The provider did not return a definitive Lost Mode result."
        },
        {
          label: "Find My iPhone",
          status:
            properties.fmiOn === true
              ? "fail"
              : properties.fmiOn === false
                ? "pass"
                : "unknown",
          detail:
            properties.fmiOn === true
              ? "The provider reports that Find My iPhone is enabled."
              : properties.fmiOn === false
                ? "The provider reports that Find My iPhone is disabled."
                : "The provider did not return a definitive FMI result."
        }
      ],
      buyAdvice:
        blacklistStatus === "fail"
          ? "Do not purchase this device until the blacklist issue is resolved and independently verified."
          : blacklistStatus === "pass"
            ? "The provider reports the IMEI as clean. Still compare the IMEI shown on the device, SIM tray and packaging where applicable before payment."
            : "Do not treat this result as a clean verification yet. The provider did not return enough information to confirm blacklist status."
    };

    // Optionally persist the provider result to the seller's own product passport.
    let passportSaved = false;
    const requestedProductId = String(req.body?.productId || "").trim();

    if (requestedProductId) {
      if (req.user?.role !== "seller") {
        return res.status(403).json({
          error: "Only the product's seller can attach an IMEI check to its passport."
        });
      }

      if (!/^[a-f\\d]{24}$/i.test(requestedProductId)) {
        return res.status(400).json({ error: "Invalid product id." });
      }

      const ownedProduct = await Product.findById(requestedProductId)
        .select("vendorId")
        .lean();

      if (!ownedProduct) {
        return res.status(404).json({ error: "Product not found." });
      }

      if (String(ownedProduct.vendorId) !== String(req.user.id)) {
        return res.status(403).json({ error: "You do not own this product." });
      }

      const existingPassport = await DevicePassport.findOne({
        productId: requestedProductId
      }).lean();

      if (
        existingPassport &&
        String(existingPassport.sellerId) !== String(req.user.id)
      ) {
        return res.status(403).json({
          error: "This passport belongs to another seller."
        });
      }

      const passportChecks = (existingPassport?.checks || [])
        .filter(check => check.key !== "blacklist");

      passportChecks.push({
        key: "blacklist",
        label: "IMEI Blacklist Status",
        status: blacklistStatus,
        source: "provider_lookup",
        detail: blacklistRaw == null
          ? "Provider returned no definitive blacklist status."
          : String(blacklistRaw).slice(0, 300),
        checkedAt: new Date()
      });

      await DevicePassport.findOneAndUpdate(
        { productId: requestedProductId },
        {
          $set: {
            sellerId: String(req.user.id),
            "imei.last4": cleanImei.slice(-4),
            checks: passportChecks
          },
          $setOnInsert: {
            productId: requestedProductId
          }
        },
        { upsert: true, new: true, runValidators: true }
      );

      passportSaved = true;
    }

    return res.json({
      success: true,
      imei: cleanImei,
      result,
      passportSaved,
      rawApiData: blacklistData
    });

  } catch (err) {
    console.error("IMEI check error:", err.message);

    return res.status(500).json({
      error: "IMEI check failed. Please try again."
    });
  }
});

app.post("/api/phone-checker/photo", auth, upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Please upload a phone photo" });
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "techmart-phone-checks", resource_type: "image" },
        (err, result) => err ? reject(err) : resolve(result)
      );
      stream.end(req.file.buffer);
    });
    const photoUrl = uploadResult.secure_url;
    console.log("PHOTO_ROUTE_HIT: starting photo analysis");
    const groqPhotoRes = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "qwen/qwen3.8-27b",
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: photoUrl } },
        { type: "text", text: "You are TechMart phone condition AI for the Nigerian used-phone market. Inspect this phone image carefully. Return ONLY a valid JSON object. Do not use markdown, explanations, or thinking text.\n{\"overallCondition\":\"Good\",\"conditionScore\":75,\"verdict\":\"LIKELY ORIGINAL\",\"riskLevel\":\"low\",\"summary\":\"...\",\"checks\":[{\"label\":\"Screen Condition\",\"status\":\"pass\",\"detail\":\"\"},{\"label\":\"Body & Frame\",\"status\":\"pass\",\"detail\":\"\"},{\"label\":\"Signs of Repair\",\"status\":\"pass\",\"detail\":\"\"},{\"label\":\"Camera Area\",\"status\":\"pass\",\"detail\":\"\"},{\"label\":\"Ports & Buttons\",\"status\":\"pass\",\"detail\":\"\"},{\"label\":\"Overall Authenticity\",\"status\":\"pass\",\"detail\":\"\"}],\"redFlags\":[],\"buyAdvice\":\"...\"}" }
      ]}],
      response_format: { type: "json_object" },
      reasoning_effort: "none",
      max_completion_tokens: 800,
      temperature: 0.2
    }, { headers: { Authorization: "Bearer " + process.env.GROQ_API_KEY, "Content-Type": "application/json" } });
    let photoContent = groqPhotoRes.data.choices[0].message.content || "";
    photoContent = photoContent.replace(/```json/g, "").replace(/```/g, "").trim();

    console.log("PHOTO_CONTENT_AFTER_STRIP:", photoContent.substring(0, 200));

    const photoJsonS = photoContent.indexOf("{");
    const photoJsonE = photoContent.lastIndexOf("}");

    console.log("PHOTO_JSON_BOUNDS:", photoJsonS, photoJsonE);

    if (photoJsonS === -1 || photoJsonE === -1 || photoJsonE <= photoJsonS) {
      console.error("PHOTO_AI_NO_JSON:", photoContent.substring(0, 500));
      return res.status(502).json({
        error: "Photo AI returned an invalid analysis. Please try another clear phone photo."
      });
    }

    const photoResult = JSON.parse(
      photoContent.slice(photoJsonS, photoJsonE + 1)
    );
    res.json({ success: true, imageUrl: photoUrl, result: photoResult });
  } catch (err) {
    console.error("Photo check error:", err.message);
    if (err.response?.data) {
      console.error("PHOTO_GROQ_ERROR:", JSON.stringify(err.response.data));
    }
    res.status(500).json({ error: "Photo analysis failed. Please try again." });
  }
});

// Device Health Passport (seller-entered, source-labelled checks)
const DevicePassport = require("./models/DevicePassport");
app.use("/api/passport", require("./routes/passport")({ express, sellerAuth, Product, DevicePassport }));

// 404 handler for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});
