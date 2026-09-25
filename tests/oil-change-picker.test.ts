import { describe, expect, it } from 'vitest';
import { isOilCandidate, isOilFilter, saleSource, type OilPickerItem } from '../lib/domain/oil-change';

const item = (patch: Partial<OilPickerItem> = {}): OilPickerItem => ({
  source: 'INVENTORY', category: 'Aceite Motor', sku: '15W40', brand: 'Fanfaro',
  description: 'Fanfaro 15W40', catalog_product_name: null, product_id: 'catalog-oil', quantity_on_hand: 0, ...patch,
});

describe('Oil change product selection', () => {
  it('finds newly synced oils even when Notion has no category', () => {
    expect(isOilCandidate(item({ source: 'CATALOG', category: null, description: 'FANFARO 15W40 SEMI-SINTETICO' }))).toBe(true);
    expect(isOilCandidate(item({ source: 'CATALOG', category: null, description: 'LUBRIKON SAE 50 GRANEL', sku: 'CATÁLOGO' }))).toBe(true);
    expect(isOilCandidate(item({ category: 'Filtro Aceite', description: 'Filtro de aceite' }))).toBe(false);
    expect(isOilFilter(item({ category: 'Filtro de Aceite', description: 'Filtro de aceite' }))).toBe(true);
  });

  it('records zero or insufficient stock without inventing inventory', () => {
    expect(saleSource(item(), 1, new Set(['catalog-oil']))).toBe('CATALOG');
    expect(saleSource(item({ product_id: null }), 1, new Set())).toBe('MANUAL');
    expect(saleSource(item({ quantity_on_hand: 1 }), 2, new Set(['catalog-oil']))).toBe('CATALOG');
    expect(saleSource(item({ quantity_on_hand: 2 }), 2, new Set(['catalog-oil']))).toBe('INVENTORY');
  });
});
