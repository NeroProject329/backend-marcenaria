const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const {
  listServices,
  createService,
  updateService,
  toggleService,
} = require("../controllers/services.controller");
const { checkLimit } = require("../middlewares/plan.middleware");

router.use(requireAuth);

router.get("/", listServices);
router.post("/", checkLimit("services"), createService);
router.patch("/:id", updateService);

// DELETE = desativar (soft delete)
router.delete("/:id", toggleService);

module.exports = router;
