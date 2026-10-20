import type { Assessment, HardwareProfile, RawListing } from '../shared/types.ts';
import { EMPTY_PROFILE } from '../server/config.ts';
export function raw(id: string, price: number, updates: Partial<RawListing> = {}): RawListing {
  return { id, price, category: 'gpu', title: 'RTX 3060 12GB', description: 'Card hoạt động tốt, chưa sửa',
    url: `https://www.chotot.com/${id}.htm`, images: [], sellerId: `seller-${id}`, sellerType: 'private',
    region: 'TP Hồ Chí Minh', district: '', ward: '', condition: 'used', params: {}, attributes: {},
    observedAt: new Date().toISOString(), displayAge: '', ...updates };
}
export function assessment(profile: Partial<HardwareProfile> = {}, updates: Partial<Assessment> = {}): Assessment {
  return { kind: 'gpu', profile: { ...EMPTY_PROFILE, gpu: 'RTX 3060', gpuClass: 'desktop', vramGb: 12, quantity: 1, priceBasis: 'item', ...profile },
    eligibility: 'eligible', risks: [], unknowns: [], conflicts: [], evidence: [], confidence: .9, method: 'rules', status: 'Test fixture', ...updates };
}
