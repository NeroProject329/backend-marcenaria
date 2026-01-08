const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const {
  getSettings,
  updateSettings,
} = require("../controllers/settings.controller");

router.use(requireAuth);

router.get("/", getSettings);
router.patch("/", updateSettings);

module.exports = router;
