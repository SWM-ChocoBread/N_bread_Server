import axios from 'axios';
import { success, fail } from '../modules/util';
import { userRepository, groupRepository, dealRepository } from '../repository';
import { dealParam } from '../dto/deal/dealParam';
import { logger } from '../config/winston';
import { errorGenerator } from '../modules/error/errorGenerator';
import { responseMessage, statusCode } from '../modules/constants';
import { DealDto } from '../dto/deal/dealDto';
import prisma from '../prisma';
import { GroupDto } from '../dto/groupDto';
const admin = require('firebase-admin');

const createDeal = async (req, res, next) => {
  try {
    const dealParam: dealParam = req.body; // currentMember 수정 필요.
    const userId = req.decoded.id;
    const deal = await dealRepository.dealTransction(dealParam, userId);
    const fcmTokenJson = await axios.get(
      `https://d3wcvzzxce.execute-api.ap-northeast-2.amazonaws.com/tokens/${userId}`,
    );
    if (Object.keys(fcmTokenJson.data).length !== 0) {
      const fcmToken = fcmTokenJson.data.Item.fcmToken;
      const fcmTopicName = `dealFcmTopic` + deal.id;
      await admin.messaging().subscribeToTopic(fcmToken, fcmTopicName);
    }
    const dealDtos = new DealDto(deal);
    logger.info(`dealId : ${deal.id} 거래가 생성되었습니다.`);
    return success(res, statusCode.CREATED, responseMessage.SUCCESS, deal);
  } catch (error) {
    logger.error(error);
    next(error);
  }
};

const deleteDeal = async (req, res, next) => {
  try {
    const dealId: number = +req.params.dealId;
    const deal = await dealRepository.findDealById(dealId);
    if (deal.userId != req.decoded.id) {
      return fail(
        res,
        statusCode.UNAUTHORIZED,
        responseMessage.DEAL_DELETE_NOT_AUTHORIZED,
      );
    }
    const groups = await prisma.groups.findMany({ where: { dealId: deal.id } });
    if (groups.length > 1) {
      return fail(
        res,
        statusCode.UNAUTHORIZED,
        responseMessage.DEAL_ALREADY_PARTICIPATED,
      );
    }
    const deletedDeal = await prisma.deals.delete({
      where: { id: dealId },
    });
    const comment = await prisma.comments.deleteMany({
      where: { dealId: dealId },
    });
    const reply = await prisma.replies.deleteMany({
      where: { dealId: dealId },
    });
    return success(res, statusCode.OK, responseMessage.SUCCESS, null);
  } catch (error) {
    logger.error(error);
    next(error);
  }
};

const joinDeal = async (req, res, next) => {
  const userId = req.params.userId;
  const dealId = req.params.dealId;

  const user = await userRepository.findUserById(userId);
  const deal = await dealRepository.findDealById(dealId);
  const isJoin = await groupRepository.findAlreadyJoin(userId, dealId);

  if (isJoin) {
    return fail(res, statusCode.FORBIDDEN, responseMessage.DEAL_ALREADY_JOINED);
  }
  if (deal.dealDate.getDate() < Date.now()) {
    return fail(res, statusCode.FORBIDDEN, responseMessage.DEAL_DATE_EXPIRED);
  }
  const stock = deal.totalMember - deal.currentMember;
  if (stock <= 0) {
    return fail(
      res,
      statusCode.BAD_REQUEST,
      responseMessage.DEAL_REQUEST_OUT_OF_STOCK,
    );
  }

  const group = await groupRepository.createGroup(userId, dealId);

  await prisma.deals.update({
    data: { currentMember: deal.currentMember + 1 },
    where: { id: deal.id },
  });

  const fcmTopicName = `dealFcmTopic` + deal.id;
  // 그룹에 있는 모든 유저들에게
  const message = {
    notification: {
      title: `N빵 신규 참여 알림`,
      body: `${user.nick}님이 N빵에 참여하여 인원이 ${deal.currentMember} / ${deal.totalMember} 가 되었습니다!`,
    },
    data: {
      type: 'deal',
      dealId: `${deal.id}`,
    },
    topic: fcmTopicName,
  };
  await admin.messaging().send(message);

  const fcmTokenJson = await axios.get(
    `https://d3wcvzzxce.execute-api.ap-northeast-2.amazonaws.com/tokens/${user.id}`,
  ); // ${user.id}
  if (Object.keys(fcmTokenJson.data).length !== 0) {
    const fcmToken = fcmTokenJson.data.Item.fcmToken;
    logger.info(`fcmToken : ${fcmToken}`);
    await admin.messaging().subscribeToTopic(fcmToken, fcmTopicName);
  }
  const groupDto = new GroupDto(group);
  const dealDto = new DealDto(deal);

  const returnJson = { groupDto, dealDto };
  return success(res, statusCode.OK, responseMessage.SUCCESS, returnJson);
};

export { createDeal, deleteDeal, joinDeal };
