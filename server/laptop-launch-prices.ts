import type { RetailPrice } from '../shared/retail.ts';
import { EMPTY_PROFILE } from './config.ts';

// Reviewed primary-source observations, not TechAPI MSRP. Extend only with dated,
// configuration-specific launch evidence; never infer an upgraded configuration's price.
const fpt = 'https://fptshop.com.vn/tin-tuc/tin-khuyen-mai/fpt-shop-ve-day-ke-macbook-m1-mua-ngay-khong-can-cho-doi-130379';
const release = 'https://www.apple.com/newsroom/2020/11/introducing-the-next-generation-of-mac/';
export const LAPTOP_LAUNCH_PRICES: RetailPrice[] = [
  { family:'AIR', storage:256, gpu:7, price:28_990_000 },
  { family:'AIR', storage:512, gpu:8, price:34_990_000 },
  { family:'PRO', storage:256, gpu:8, price:34_990_000 },
  { family:'PRO', storage:512, gpu:8, price:39_990_000 },
].map(row => ({
  id:`fpt-m1-${row.family.toLowerCase()}-8-${row.storage}`,
  title:`MacBook ${row.family === 'AIR' ? 'Air' : 'Pro'} 13 M1 (2020), 8 GB / ${row.storage} GB, 8 CPU / ${row.gpu} GPU`,
  url:fpt, source:'FPT Shop launch retail',
  profile:{...EMPTY_PROFILE,model:`MACBOOK ${row.family} 13`,modelYear:2020,screenInches:13.3,cpu:'APPLE M1',cpuCores:8,
    gpu:'APPLE M1',gpuClass:'integrated',gpuCores:row.gpu,ramGb:8,storageGb:row.storage,storageType:'SSD',priceBasis:'item'},
  amount:row.price,currency:'VND',observedAt:'2026-10-25T00:00:00.000Z',basis:'launch_retail',priceDate:'2021-01-08',
  releaseDate:'2020-11-10',releaseYear:2020,releaseSourceUrl:release,
  configurationSourceUrl:'https://www.apple.com/education/pricelists/pdfs/Apple_US_Education_Institution_Price_List-11-10-2020.pdf',
  market:'VN',available:false,totalCostKnown:true,shipsToVietnam:true,
}));
