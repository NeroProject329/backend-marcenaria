const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");

const {
  listCosts,
  getCost,
  createCost,
  updateCost,
  deleteCost,
  costSummary, // ✅ novo
} = require("../controllers/costs.controller");

router.use(requireAuth);

router.get("/", listCosts);

// ✅ novo (tem que vir antes do "/:id")
router.get("/summary", costSummary);

router.get("/:id", getCost);
router.post("/", createCost);
router.patch("/:id", updateCost);
router.delete("/:id", deleteCost);

module.exports = router;
