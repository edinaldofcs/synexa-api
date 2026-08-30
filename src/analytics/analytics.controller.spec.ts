import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsController', () => {
  let controller: AnalyticsController;

  const user = { id: 'user-1', company_id: 'company-1', role: 'owner' };
  const service = {
    getBusinessAnalytics: jest.fn().mockResolvedValue({}),
    getBiDashboard: jest.fn().mockResolvedValue({}),
    getCostsAndConsumption: jest.fn().mockResolvedValue({}),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [{ provide: AnalyticsService, useValue: service }],
    }).compile();
    controller = module.get<AnalyticsController>(AnalyticsController);
  });

  describe('resolveTimeWindow', () => {
    it('should default to the last 30 days when from/to are missing', async () => {
      const before = Date.now();
      await controller.business(user);
      const after = Date.now();

      const args = service.getBusinessAnalytics.mock.calls[0][1];
      expect(args.from.getTime()).toBeGreaterThanOrEqual(before - 30 * 86400000);
      expect(args.from.getTime()).toBeLessThanOrEqual(after - 30 * 86400000);
      expect(args.to.getTime()).toBeGreaterThanOrEqual(before);
      expect(args.to.getTime()).toBeLessThanOrEqual(after);
    });

    it('should clamp to to from + 90 days', async () => {
      await controller.business(user, '2026-01-01T00:00:00Z', '2026-08-30T00:00:00Z');

      const args = service.getBusinessAnalytics.mock.calls[0][1];
      expect(args.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(args.to.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    });

    it('should reject from >= to with 400', async () => {
      await expect(
        controller.business(user, '2026-08-30T00:00:00Z', '2026-08-01T00:00:00Z'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject invalid dates with 400', async () => {
      await expect(
        controller.business(user, 'not-a-date'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should apply the window on bi-dashboard and consumption-costs', async () => {
      await controller.biDashboard(user, undefined, undefined, '2026-08-01T00:00:00Z', '2026-08-10T00:00:00Z');
      await controller.consumptionCosts(user, undefined, '2026-08-01T00:00:00Z', '2026-08-10T00:00:00Z');

      const biArgs = service.getBiDashboard.mock.calls[0][1];
      const costArgs = service.getCostsAndConsumption.mock.calls[0][1];
      expect(biArgs.from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(biArgs.to.toISOString()).toBe('2026-08-10T00:00:00.000Z');
      expect(costArgs.from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(costArgs.to.toISOString()).toBe('2026-08-10T00:00:00.000Z');
    });
  });
});
