const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");

const {
  reportsDfc,
  reportsUpcoming,
  reportsDre,
  reportsDreSeries,
  reportsProjections,
} = require("../controllers/reports.controller");

router.get("/dfc", requireAuth, reportsDfc);
router.get("/upcoming", requireAuth, reportsUpcoming);

router.get("/dre", requireAuth, reportsDre);
router.get("/dre/series", requireAuth, reportsDreSeries);

// ✅ NOVO
router.get("/projections", requireAuth, reportsProjections);

module.exports = router;