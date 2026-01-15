const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const { overview } = require("../controllers/dashboard.controller");

router.use(requireAuth);
router.get("/overview", overview);

module.exports = router;
