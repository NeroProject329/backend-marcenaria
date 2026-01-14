const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");

const {
  listCosts,
  getCost,
  createCost,
  updateCost,
  deleteCost,
} = require("../controllers/costs.controller");

router.use(requireAuth);

router.get("/", listCosts);
router.get("/:id", getCost);
router.post("/", createCost);
router.patch("/:id", updateCost);
router.delete("/:id", deleteCost);

module.exports = router;
