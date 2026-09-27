export enum BrandId {
  Synexa = 'synexa',
  Voicelabs = 'voicelabs',
}

// Cosmetic identity only. Never use a brand to resolve companies or permissions.
export function getBrandName(brand: BrandId = BrandId.Synexa): string {
  return brand === BrandId.Voicelabs ? 'Voicelabs' : 'Synexa';
}
