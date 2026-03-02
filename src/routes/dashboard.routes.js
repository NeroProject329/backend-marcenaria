const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const { overview, upcomingPayments } = require("../controllers/dashboard.controller");

router.use(requireAuth);
router.get("/overview", overview);

// ✅ novo widget
router.get("/upcoming-payments", upcomingPayments);

module.exports = router;