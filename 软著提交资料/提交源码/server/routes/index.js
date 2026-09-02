/**
 * 路由聚合模块
 * 将各业务路由挂载到统一前缀 /api。
 */
const express = require('express');
const authRouter = require('./auth');
const userRouter = require('./user');
const taskRouter = require('./task');
const checkinRouter = require('./checkin');
const pointRouter = require('./point');
const badgeRouter = require('./badge');
const adminRouter = require('./admin');

const router = express.Router();

router.use('/auth', authRouter);
router.use('/user', userRouter);
router.use('/task', taskRouter);
router.use('/checkin', checkinRouter);
router.use('/point', pointRouter);
router.use('/badge', badgeRouter);
router.use('/admin', adminRouter);

module.exports = router;
