import { Router, type IRouter } from "express";
import healthRouter from "./health";
import capabilitiesRouter from "./capabilities";
import uploadsRouter from "./uploads";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(capabilitiesRouter);
router.use(uploadsRouter);
router.use(adminRouter);

export default router;
