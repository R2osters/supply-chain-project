import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';
import { RECOMMENDATION_ORDER_NOTE, RecommendationsService } from './recommendations.service';

const USER = { id: 'u1', companyId: 'co1', role: 'COMPANY_ADMIN' } as unknown as AuthenticatedUser;

function setup(payload: Record<string, unknown>) {
  const recommendation = {
    id: 'rec1',
    companyId: 'co1',
    type: 'ORDER_NOW',
    status: 'OPEN',
    subjectType: 'PRODUCT',
    subjectId: 'p6',
    expiresAt: null,
    payload,
  };
  const prisma = {
    recommendation: {
      findFirst: jest.fn().mockResolvedValue(recommendation),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...recommendation, ...data })),
    },
    domainEvent: { findMany: jest.fn().mockResolvedValue([]) },
    supplierProduct: {
      findFirst: jest.fn().mockResolvedValue({ supplierId: 's-preferred', supplier: { name: 'Volta Grain Cooperative' } }),
    },
  };
  const purchaseOrders = {
    create: jest.fn().mockResolvedValue({ id: 'po1', orderNumber: 'PO-2026-0303' }),
  };
  const service = new RecommendationsService(
    prisma as unknown as PrismaService,
    purchaseOrders as unknown as PurchaseOrdersService,
  );
  return { service, prisma, purchaseOrders };
}

describe('RecommendationsService.accept', () => {
  it('links the order it raises back to the recommendation, at the site the advice was for', async () => {
    const { service, purchaseOrders } = setup({
      productId: 'p6',
      warehouseId: 'wh-acc',
      quantity: 2963,
      lines: [{ supplierId: 's-tema', supplierName: 'Tema Port Distributors', quantity: 2963, unitPrice: 19.8 }],
    });

    const result = await service.accept(USER, 'rec1');

    expect(purchaseOrders.create).toHaveBeenCalledTimes(1);
    expect(purchaseOrders.create).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        supplierId: 's-tema',
        warehouseId: 'wh-acc',
        sourceRecommendationId: 'rec1',
        notes: RECOMMENDATION_ORDER_NOTE,
      }),
    );
    expect(result.recommendation.status).toBe('EXECUTED');
  });

  it('links every order of a split', async () => {
    const { service, purchaseOrders } = setup({
      productId: 'p6',
      warehouseId: 'wh-acc',
      lines: [
        { supplierId: 's-tema', quantity: 2000 },
        { supplierId: 's-volta', quantity: 963 },
      ],
    });

    await service.accept(USER, 'rec1');

    expect(purchaseOrders.create).toHaveBeenCalledTimes(2);
    for (const [, dto] of purchaseOrders.create.mock.calls) {
      expect(dto.sourceRecommendationId).toBe('rec1');
    }
  });

  it('links the order raised from the preferred supplier when the advice has no split', async () => {
    const { service, purchaseOrders } = setup({ productId: 'p6', warehouseId: 'wh-acc', quantity: 500 });

    await service.accept(USER, 'rec1');

    expect(purchaseOrders.create).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ supplierId: 's-preferred', sourceRecommendationId: 'rec1' }),
    );
  });
});
