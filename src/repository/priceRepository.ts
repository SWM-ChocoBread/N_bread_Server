import { priceDetailDto, priceDto } from '../dto/price/priceDto';
import prisma from '../prisma';

const isPriceExist = async (dealId: number) => {
  const price = await prisma.prices.findFirst({ where: { dealId } });
  return !!price;
};

const savePriceInfo = async (priceDto: priceDto) => {
  await prisma.prices.create({ data: priceDto });
};

const saveDetailPriceInfo = async (priceDetailDto: priceDetailDto) => {
  await prisma.prices.create({ data: priceDetailDto });
};
export { isPriceExist, savePriceInfo, saveDetailPriceInfo };
