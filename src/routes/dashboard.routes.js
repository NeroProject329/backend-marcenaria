const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const { overview, upcomingPayments, plus } = require("../controllers/dashboard.controller");

router.get("/overview", requireAuth, overview);
router.get("/upcoming-payments", requireAuth, upcomingPayments);

// ✅ NOVO
router.get("/plus", requireAuth, plus);

module.exports = router;