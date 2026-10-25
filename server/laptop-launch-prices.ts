import type { RetailPrice } from '../shared/retail.ts';
import { EMPTY_PROFILE } from './config.ts';

// Reviewed primary-source observations, not TechAPI MSRP. Extend only with dated,
// configuration-specific launch evidence; never infer an upgraded configuration's price.
const fpt = 'https://fptshop.com.vn/tin-tuc/tin-khuyen-mai/fpt-shop-ve-day-ke-macbook-m1-mua-ngay-khong-can-cho-doi-130379';
const release = 'https://www.apple.com/newsroom/2020/11/introducing-the-next-generation-of-mac/';
const m1: RetailPrice[] = [
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

const observedAt = '2026-10-25T00:00:00.000Z';
// These are archived price observations, never offers that are purchasable now.
const historical = { observedAt, available:false, totalCostKnown:false, shipsToVietnam:false };
const m2Release = 'https://www.apple.com/newsroom/2022/07/all-new-macbook-air-with-m2-available-to-order-starting-friday-july-8/';
const m2: RetailPrice[] = [
  { storage:256, gpu:8, price:32_990_000 },
  { storage:512, gpu:10, price:39_990_000 },
].map(row => ({
  ...historical, id:`fpt-air-m2-8-${row.storage}`,
  title:`MacBook Air 13 M2 (2022), 8 GB / ${row.storage} GB, 8 CPU / ${row.gpu} GPU`,
  url:'https://fptshop.com.vn/tin-tuc/tin-khuyen-mai/fpt-shop-lai-bat-ngo-mo-ban-macbook-air-m2-chinh-hang-som-nhat-viet-nam-148204',
  source:'FPT Shop launch retail', basis:'launch_retail', market:'VN', currency:'VND', amount:row.price,
  priceDate:'2022-07-28', releaseDate:'2022-07-08', releaseYear:2022, releaseSourceUrl:m2Release,
  configurationSourceUrl:'https://fptshop.com.vn/tin-tuc/danh-gia/danh-gia-macbook-air-m2-2022-146863/',
  profile:{...EMPTY_PROFILE,model:'MACBOOK AIR 13',modelYear:2022,screenInches:13.6,cpu:'APPLE M2',cpuCores:8,
    gpu:'APPLE M2',gpuClass:'integrated',gpuCores:row.gpu,ramGb:8,storageGb:row.storage,storageType:'SSD',priceBasis:'item'},
}));

const airM4Path = 'newsroom/2025/03/apple-introduces-the-new-macbook-air-with-the-m4-chip-and-a-sky-blue-color/';
// Apple's starting prices apply only to the documented base configurations.
// In particular, neither row supplies a price for the 13-inch 10-GPU / 512 GB SKU.
const airM4: RetailPrice[] = [
  { size:13.6, gpu:8, price:26_999_000 },
  { size:15.3, gpu:10, price:31_999_000 },
].map(row => ({
  ...historical, id:`apple-vn-air-m4-${Math.floor(row.size)}-16-256`,
  title:`MacBook Air ${Math.floor(row.size)} M4 (2025), 16 GB / 256 GB, 10 CPU / ${row.gpu} GPU`,
  url:`https://www.apple.com/vn/${airM4Path}`, source:'Apple Vietnam launch MSRP',
  basis:'launch_msrp', market:'VN', currency:'VND', amount:row.price,
  priceDate:'2025-03-05', releaseDate:'2025-03-05', releaseYear:2025,
  releaseSourceUrl:`https://www.apple.com/${airM4Path}`,
  // The specification's battery-test footnote documents both base SKUs.
  configurationSourceUrl:'https://support.apple.com/en-ie/122209',
  profile:{...EMPTY_PROFILE,model:`MACBOOK AIR ${Math.floor(row.size)}`,modelYear:2025,screenInches:row.size,cpu:'APPLE M4',cpuCores:10,
    gpu:'APPLE M4',gpuClass:'integrated',gpuCores:row.gpu,ramGb:16,storageGb:256,storageType:'SSD',priceBasis:'item'},
}));
const proM4Path = 'newsroom/2024/10/new-macbook-pro-features-m4-family-of-chips-and-apple-intelligence/';
const proM4: RetailPrice = {
  ...historical, id:'apple-vn-pro-m4-14-16-512',
  title:'MacBook Pro 14 M4 (2024), 16 GB / 512 GB, 10 CPU / 10 GPU, standard display',
  url:`https://www.apple.com/vn/${proM4Path}`, source:'Apple Vietnam launch MSRP',
  basis:'launch_msrp', market:'VN', currency:'VND', amount:39_999_000,
  priceDate:'2024-10-30', releaseDate:'2024-10-30', releaseYear:2024,
  releaseSourceUrl:`https://www.apple.com/${proM4Path}`, configurationSourceUrl:'https://support.apple.com/vi-vn/121552',
  profile:{...EMPTY_PROFILE,model:'MACBOOK PRO 14',modelYear:2024,screenInches:14.2,cpu:'APPLE M4',cpuCores:10,
    gpu:'APPLE M4',gpuClass:'integrated',gpuCores:10,ramGb:16,storageGb:512,storageType:'SSD',priceBasis:'item'},
};

const pro7Price = 'https://news.microsoft.com/source/asia/2019/11/13/new-surface-line-up-more-versatile-more-adaptable-more-personal/';
const pro7: RetailPrice[] = [
  { cpu:'I5-1035G4', ram:8, storage:128, price:1_388 },
  { cpu:'I5-1035G4', ram:8, storage:256, price:1_788 },
  { cpu:'I7-1065G7', ram:16, storage:256, price:2_188 },
  { cpu:'I7-1065G7', ram:16, storage:512, price:2_688 },
  { cpu:'I7-1065G7', ram:16, storage:1024, price:3_288 },
].map(row => ({
  ...historical, id:`microsoft-sg-pro7-${row.cpu.toLowerCase()}-${row.ram}-${row.storage}`,
  title:`Surface Pro 7 ${row.cpu}, ${row.ram} GB / ${row.storage} GB (tablet only)`,
  url:pro7Price, source:'Microsoft Singapore launch MSRP (GST included)',
  basis:'launch_msrp', market:'SG', currency:'SGD', amount:row.price,
  priceDate:'2019-11-13', releaseDate:'2019-10-02', releaseYear:2019,
  releaseSourceUrl:'https://blogs.windows.com/devices/2019/10/02/surface-reveals-new-holiday-lineup-and-introduces-a-new-category-of-dual-screen-devices-built-for-mobile-productivity/',
  configurationSourceUrl:'https://support.microsoft.com/en-gb/surface/models/surface-pro-7-specs-and-features',
  profile:{...EMPTY_PROFILE,model:'Surface Pro 7',modelYear:2019,screenInches:12.3,cpu:row.cpu,cpuCores:4,
    gpu:'Intel Iris Plus Graphics',gpuClass:'integrated',ramGb:row.ram,ramType:'LPDDR4X',storageGb:row.storage,storageType:'SSD',priceBasis:'item'},
}));

const pro7PlusPrice = 'https://news.microsoft.com/en-hk/2021/01/12/introducing-surface-pro-7-for-business-and-surface-hub-2s-85-purpose-built-to-empower-people-teams-and-classrooms-in-the-new-digital-age/';
// Commercial MSRP, excluding the separately restricted EDU row. Connectivity
// is not extracted from listings: preserve both Wi-Fi/LTE prices as a range.
// All foreign history remains indicative, including rows with a single price.
const pro7Plus: RetailPrice[] = [
  { cpu:'I3-1115G4', ram:8, storage:128, price:7_288, lte:false },
  { cpu:'I5-1135G7', ram:8, storage:128, price:8_188, lte:false },
  { cpu:'I5-1135G7', ram:8, storage:256, price:10_788, lte:false },
  { cpu:'I5-1135G7', ram:16, storage:256, price:12_288, lte:false },
  { cpu:'I7-1165G7', ram:16, storage:256, price:13_888, lte:false },
  { cpu:'I7-1165G7', ram:16, storage:512, price:16_288, lte:false },
  { cpu:'I7-1165G7', ram:16, storage:1024, price:19_388, lte:false },
  { cpu:'I7-1165G7', ram:32, storage:1024, price:22_588, lte:false },
  { cpu:'I5-1135G7', ram:8, storage:128, price:9_388, lte:true },
  { cpu:'I5-1135G7', ram:8, storage:256, price:11_888, lte:true },
  { cpu:'I5-1135G7', ram:16, storage:256, price:13_388, lte:true },
].map(row => ({
  ...historical, id:`microsoft-hk-pro7plus-${row.cpu.toLowerCase()}-${row.ram}-${row.storage}-${row.lte ? 'lte' : 'wifi'}`,
  title:`Surface Pro 7+ ${row.cpu}, ${row.ram} GB / ${row.storage} GB (${row.lte ? 'LTE' : 'Wi-Fi'}; tablet only)`,
  url:pro7PlusPrice, source:'Microsoft Hong Kong commercial launch MSRP',
  basis:'launch_msrp', market:'HK', currency:'HKD', amount:row.price,
  priceDate:'2021-01-12', releaseDate:'2021-01-11', releaseYear:2021,
  releaseSourceUrl:'https://blogs.windows.com/devices/2021/01/11/introducing-surface-pro-7-for-business-purpose-built-to-empower-people-teams-and-classrooms-in-the-new-digital-age/',
  configurationSourceUrl:pro7PlusPrice,
  profile:{...EMPTY_PROFILE,model:'Surface Pro 7+',modelYear:2021,screenInches:12.3,cpu:row.cpu,cpuCores:row.cpu.startsWith('I3') ? 2 : 4,
    gpu:row.cpu.startsWith('I3') ? 'Intel UHD Graphics' : 'Intel Iris Xe Graphics',gpuClass:'integrated',
    ramGb:row.ram,ramType:'LPDDR4X',storageGb:row.storage,storageType:'SSD',priceBasis:'item'},
}));

export const LAPTOP_LAUNCH_PRICES: RetailPrice[] = [...m1, ...m2, ...airM4, proM4, ...pro7, ...pro7Plus];
