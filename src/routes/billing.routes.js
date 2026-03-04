// src/routes/billing.routes.js
const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const { checkout } = require("../controllers/billing.controller");

router.use(requireAuth);

// POST /api/billing/checkout
router.post("/checkout", checkout);

module.exports = router;