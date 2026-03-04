const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const { reportsDfc, reportsUpcoming } = require("../controllers/reports.controller");

router.get("/dfc", requireAuth, reportsDfc);
router.get("/upcoming", requireAuth, reportsUpcoming);

module.exports = router;