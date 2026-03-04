const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");

const {
  reportsDfc,
  reportsUpcoming,
  reportsDre,
  reportsDreSeries,
} = require("../controllers/reports.controller");

router.get("/dfc", requireAuth, reportsDfc);
router.get("/upcoming", requireAuth, reportsUpcoming);

// ✅ NOVO: DRE
router.get("/dre", requireAuth, reportsDre);
router.get("/dre/series", requireAuth, reportsDreSeries);

module.exports = router;