import { success, fail } from '../modules/util';
import {
  userRepository,
  groupRepository,
  dealRepository,
  dealReportRepository,
  dealImageRepository,
} from '../repository';
import { dealParam } from '../dto/deal/dealParam';
import { logger } from '../config/winston';
import { responseMessage, statusCode } from '../modules/constants';
import { DealDto } from '../dto/deal/dealDto';
import prisma from '../prisma';
import { GroupDto } from '../dto/groupDto';
import fcmMessage from '../modules/constants/fcmMessage';
import { dealImageModule, dealModule, fcmHandler } from '../modules';
import { DealUpdateParam } from '../dto/deal/DealUpdateParam';
import { DealReportDto } from '../dto/dealReport/dealReportDto';
import { DealWithStatusDto } from '../dto/deal/dealWithStatusDto';
import { deals } from '@prisma/client';
import { NextFunction, Request, Response } from 'express';
import {
  DataMessagePayload,
  Notification,
} from 'firebase-admin/lib/messaging/messaging-api';

const admin = require('firebase-admin');

const createDeal = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dealParam: dealParam = req.body; // currentMember 수정 필요.
    const userId = +req.query.userId;
    await dealModule._verifyDealDate(res, dealParam);

    const deal = await dealRepository.dealTransction(dealParam, userId);
    await fcmHandler.dealSubscribe(userId, deal.id);
    const dealDtos = new DealDto(deal);
    logger.info(`dealId : ${deal.id} 거래가 생성되었습니다.`);
    return success(res, statusCode.CREATED, responseMessage.SUCCESS, deal);
  } catch (error) {
    logger.error(error);
    next(error);
  }
};

const deleteDeal = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dealId: number = +req.params.dealId;
    const deal = await dealRepository.findDealById(dealId);
    if (deal.userId != +req.query.userId) {
      return fail(
        res,
        statusCode.FORBIDDEN,
        responseMessage.DEAL_DELETE_FORBIDDEN,
      );
    }
    const groups = await prisma.groups.findMany({ where: { dealId: deal.id } });
    if (groups.length > 1) {
      return fail(
        res,
        statusCode.BAD_REQUEST,
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
    return success(res, statusCode.OK, responseMessage.SUCCESS);
  } catch (error) {
    logger.error(error);
    next(error);
  }
};

const updateDeal = async (req: Request, res: Response, next: NextFunction) => {
  // #swagger.summary = '거래 수정'
  try {
    const dealId: number = +req.params.dealId;
    const dealUpdateParam: DealUpdateParam = req.body;
    const deal = await dealRepository.findDealById(dealId);

    if (deal.userId != +req.query.userId) {
      logger.info(
        `userId : ${req.query.userId}는 거래를 수정할 권한이 없습니다.`,
      );
      return fail(
        res,
        statusCode.FORBIDDEN,
        responseMessage.DEAL_UPDATE_FORBIDDEN,
      );
    }

    const groups = await prisma.groups.findMany({
      where: { dealId: dealId },
    });
    if (groups.length > 1) {
      logger.info(
        `참여자가 ${groups.length - 1}명 있으므로 거래를 수정 할 수 없습니다.`,
      );
      return fail(
        res,
        statusCode.BAD_REQUEST,
        responseMessage.DEAL_ALREADY_PARTICIPATED,
      );
    }

    const updatedDeal = await dealRepository.updateDeal(
      dealId,
      dealUpdateParam,
    );
    logger.info(`${dealId} 의 거래를 수정하였습니다.`);

    const dealDto: DealDto = new DealDto(updatedDeal);
    return success(res, statusCode.OK, responseMessage.SUCCESS, dealDto);
  } catch (error) {
    logger.error(error);
    next(error);
  }
};

const joinDeal = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = +req.query.userId;
    const dealId = +req.params.dealId;

    const user = await userRepository.findUserById(userId);
    const deal = await dealRepository.findDealById(dealId);
    const isJoin = await groupRepository.findAlreadyJoin(userId, dealId);
    const dealDate = new Date(deal.dealDate);

    if (isJoin) {
      return fail(
        res,
        statusCode.BAD_REQUEST,
        responseMessage.DEAL_ALREADY_JOINED,
      );
    }
    if (dealDate.getTime() < Date.now()) {
      return fail(
        res,
        statusCode.BAD_REQUEST,
        responseMessage.DEAL_DATE_EXPIRED,
      );
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

    const updatedDeal = await prisma.deals.update({
      data: { currentMember: deal.currentMember + 1 },
      where: { id: deal.id },
    });

    // 그룹에 있는 모든 유저들에게
    const fcmNotification: Notification = {
      title: fcmMessage.NEW_PARTICIPANT,
      body: `${user.nick}님이 N빵에 참여하여 인원이 ${updatedDeal.currentMember} / ${updatedDeal.totalMember} 가 되었습니다!`,
    };

    const fcmData: DataMessagePayload = {
      type: 'deal',
      dealId: dealId.toString(),
    };

    const fcmTopic = 'dealFcmTopic' + deal.id;

    await fcmHandler.sendToSub(fcmTopic, fcmNotification, fcmData);
    await fcmHandler.dealSubscribe(userId, dealId);

    const groupDto = new GroupDto(group);
    const dealDto = new DealDto(deal);

    const returnJson = { groupDto, dealDto };
    return success(res, statusCode.OK, responseMessage.SUCCESS, returnJson);
  } catch (error) {
    logger.error(error);
    next(error);
  }
};

const reportDeal = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, content } = req.body;
    const dealId = +req.params.dealId;
    const userId = +req.query.userId;

    const user = await userRepository.findUserById(userId);
    const deal = await dealRepository.findDealById(dealId);

    if (user.id === deal.userId) {
      logger.info(`userId : ${userId} 자신이 작성한 글을 신고 할 수 없습니다.`);
      return fail(
        res,
        statusCode.BAD_REQUEST,
        responseMessage.DEAL_REPORT_NOT_AUTHORIZED,
      );
    }

    const dealReport = await dealReportRepository.createDealReport(
      title,
      content,
      userId,
      dealId,
    );

    const dealReportDto = new DealReportDto(dealReport);

    logger.info(`${userId}님이 dealId : ${dealId}글을 신고 하였습니다.`);
    return success(res, statusCode.OK, responseMessage.SUCCESS, dealReportDto);
  } catch (error) {
    logger.error(error);
    next(error);
  }
};
const userStatusInDeal = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = +req.params.userId;
    const dealId = +req.params.dealId;
    const isValidUser = await userRepository.findUserById(userId);
    const group = await groupRepository.findGroupByUserIdAndDealId(
      userId,
      dealId,
    );

    const userStatus = await dealModule._checkUserStatusInDeal(
      group,
      userId,
      dealId,
    );
    const result = {
      participation: userStatus.status,
      description: userStatus.description,
      userId: userId,
      dealId: dealId,
    };
    return success(res, statusCode.OK, responseMessage.SUCCESS, result);
  } catch (error) {
    logger.log(error);
    next(error);
  }
};

const createDealImage = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const dealId = +req.params.dealId;
    const targetDeal = await dealRepository.findDealById(dealId);
    const result = await dealImageModule._createDealImage(req, dealId);
    logger.info(
      `dealId : ${dealId}에 ${result.length}개의 이미지가 생성되었습니다.`,
    );
    return success(res, statusCode.OK, responseMessage.SUCCESS);
  } catch (error) {
    logger.error(`[거래 이미지 생성] POST /deals/:dealId/img ${error}`);
    next(error);
  }
};

const createCoupangImage = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { url } = req.body;
    const dealId = +req.params.dealId;
    const targetDeal = await dealRepository.findDealById(dealId);
    const coupangImage = await dealImageRepository.createDealImage(url, dealId);
    logger.info(
      `dealId : ${dealId}에 dealImageId : ${coupangImage.id} 가 생성되었습니다.`,
    );
    return success(res, statusCode.OK, responseMessage.SUCCESS);
  } catch (error) {
    logger.error(error);
    next(error);
  }
};

const readDealDetail = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const dealId: number = +req.params.dealId;
    const userId: number = +req.query.userId;
    const deal = await dealRepository.getDealDetail(dealId);
    const group = await groupRepository.findGroupByUserIdAndDealId(
      userId,
      dealId,
    );

    const userStatus = await dealModule._checkUserStatusInDeal(
      group,
      userId,
      dealId,
    );

    const dealWithStatusDto: DealWithStatusDto = new DealWithStatusDto(deal);
    dealWithStatusDto['mystatus'] = userStatus.description;
    dealModule._setDealStatus(dealWithStatusDto);

    return success(
      res,
      statusCode.OK,
      responseMessage.SUCCESS,
      dealWithStatusDto,
    );
  } catch (error) {
    logger.error(error);
    next(error);
  }
};

const homeAllDeal = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { range, region } = req.params;
    const userId: number = +req.query.userId;
    const allDealList: deals[] = await dealRepository.readHomeAllDeal(
      range,
      region,
    );
    let dealWithStatusDtoList: DealWithStatusDto[] = [];

    for (const deal of allDealList) {
      const dealWithStatusDto: DealWithStatusDto = new DealWithStatusDto(deal);
      const inGroup = await groupRepository.findGroupByUserIdAndDealId(
        userId,
        deal.id,
      );
      const userStatus = await dealModule._checkUserStatusInDeal(
        inGroup,
        userId,
        deal.id,
      );
      dealWithStatusDto['mystatus'] = userStatus.description;
      dealModule._setDealStatus(dealWithStatusDto);
      dealWithStatusDtoList.push(dealWithStatusDto as DealWithStatusDto);
    }
    return success(
      res,
      statusCode.OK,
      responseMessage.SUCCESS,
      dealWithStatusDtoList,
    );
  } catch (error) {
    logger.error(error);
    next(error);
  }
};

export {
  createDeal,
  deleteDeal,
  updateDeal,
  joinDeal,
  reportDeal,
  userStatusInDeal,
  createDealImage,
  createCoupangImage,
  readDealDetail,
  homeAllDeal,
};
