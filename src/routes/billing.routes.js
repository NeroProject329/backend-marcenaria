// src/routes/billing.routes.js
const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");

const {
  checkout,
  cancelAtPeriodEnd,
  resumeSubscription,
} = require("../controllers/billing.controller");

router.use(requireAuth);

// POST /api/billing/checkout
router.post("/checkout", checkout);

// POST /api/billing/cancel
router.post("/cancel", cancelAtPeriodEnd);

// POST /api/billing/resume
router.post("/resume", resumeSubscription);

module.exports = router;