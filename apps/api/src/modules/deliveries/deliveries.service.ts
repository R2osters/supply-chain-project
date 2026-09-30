import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { haversineMeters } from '@scip/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { paginated, type PaginationQueryDto } from '../../common/dto/pagination.dto';
import { requireCompanyId, scopedShipmentWhere } from '../../common/tenancy/tenant-scope';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { StorageService } from '../storage/storage.service';
import { ShipmentsService } from '../shipments/shipments.service';
import type { CapturePodDto, TransitionDeliveryDto } from './deliveries.dto';

/** Metres beyond which a proof of delivery is flagged as captured away from the destination. */
const POD_DISTANCE_WARNING_M = 1_000;

const DELIVERY_TRANSITIONS: Record<string, string[]> = {
  ASSIGNED: ['PICKED_UP', 'FAILED'],
  PICKED_UP: ['IN_TRANSIT', 'FAILED'],
  IN_TRANSIT: ['ARRIVED', 'FAILED'],
  ARRIVED: ['DELIVERED', 'FAILED'],
  DELIVERED: [],
  FAILED: ['ASSIGNED'], // a failed attempt can be re-assigned for another try
};

/** French names of the delivery statuses, for error texts. Agreed with « livraison ». */
const DELIVERY_STATUS_LABELS: Record<string, string> = {
  ASSIGNED: 'Assignée',
  PICKED_UP: 'Enlevée',
  IN_TRANSIT: 'En transit',
  ARRIVED: 'Arrivée',
  DELIVERED: 'Livrée',
  FAILED: 'Échouée',
};

/** The status quoted as a label, e.g. « Arrivée ». Unknown values pass through. */
function quotedDeliveryStatus(status: string): string {
  return `« ${DELIVERY_STATUS_LABELS[status] ?? status} »`;
}

@Injectable()
export class DeliveriesService {
  private readonly logger = new Logger(DeliveriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly shipments: ShipmentsService,
  ) {}

  async list(user: AuthenticatedUser, query: PaginationQueryDto, status?: string) {
    const where: Prisma.DeliveryWhereInput = {
      ...(user.role === 'SUPER_ADMIN' ? {} : { companyId: user.companyId ?? '__none__' }),
      ...(status ? { status: status as never } : {}),
      ...(user.role === 'DRIVER' ? { shipment: { driver: { userId: user.id } } } : {}),
      ...(user.role === 'CUSTOMER' ? { customerId: user.linkedCustomerId ?? '__none__' } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        include: {
          shipment: {
            select: {
              id: true,
              trackingNumber: true,
              status: true,
              destinationName: true,
              estimatedArrivalAt: true,
            },
          },
          customer: { select: { id: true, name: true } },
          proof: { select: { id: true, receiverName: true, capturedAt: true } },
        },
        orderBy: { assignedAt: query.order },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.delivery.count({ where }),
    ]);

    return paginated(data, total, query);
  }

  async findOne(user: AuthenticatedUser, id: string) {
    const delivery = await this.prisma.delivery.findFirst({
      where: {
        id,
        ...(user.role === 'SUPER_ADMIN' ? {} : { companyId: user.companyId ?? '__none__' }),
      },
      include: {
        shipment: { include: { items: { include: { product: true } }, driver: true } },
        customer: true,
        proof: true,
      },
    });
    if (!delivery) throw new NotFoundException('Livraison introuvable');

    // Presign only on read of a single record — signing a URL per row in a list would be
    // wasteful and hand out capabilities nobody asked for.
    const proof = delivery.proof
      ? {
          ...delivery.proof,
          signatureUrl: delivery.proof.signatureKey
            ? await this.storage.presignedUrl(delivery.proof.signatureKey)
            : null,
          photos: await this.storage.presignMany(delivery.proof.photoKeys),
        }
      : null;

    return {
      ...delivery,
      proof,
      allowedTransitions: DELIVERY_TRANSITIONS[delivery.status] ?? [],
    };
  }

  /** Creates the delivery record for a shipment. Idempotent — one delivery per shipment. */
  async createForShipment(user: AuthenticatedUser, shipmentId: string) {
    const companyId = requireCompanyId(user);
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, companyId },
    });
    if (!shipment) throw new NotFoundException('Expédition introuvable dans votre entreprise');

    const existing = await this.prisma.delivery.findUnique({ where: { shipmentId } });
    if (existing) return existing;

    return this.prisma.delivery.create({
      data: {
        companyId,
        shipmentId,
        customerId: shipment.customerId,
        status: 'ASSIGNED',
        isDemoData: shipment.isDemoData,
      },
    });
  }

  async transition(user: AuthenticatedUser, id: string, dto: TransitionDeliveryDto) {
    const delivery = await this.findOne(user, id);
    const allowed = DELIVERY_TRANSITIONS[delivery.status] ?? [];

    if (!allowed.includes(dto.status)) {
      throw new BadRequestException(
        allowed.length === 0
          ? `${quotedDeliveryStatus(delivery.status)} est un statut de livraison final`
          : `Impossible de faire passer une livraison de ${quotedDeliveryStatus(delivery.status)} à ` +
              `${quotedDeliveryStatus(dto.status)}. Transitions autorisées : ${allowed.map(quotedDeliveryStatus).join(', ')}`,
      );
    }
    if (dto.status === 'FAILED' && !dto.failureReason) {
      throw new BadRequestException('Un motif d’échec est requis');
    }
    if (dto.status === 'DELIVERED') {
      throw new BadRequestException(
        'Pour terminer une livraison, enregistrez la preuve de livraison : POST /deliveries/:id/proof',
      );
    }

    const now = new Date();
    return this.prisma.delivery.update({
      where: { id },
      data: {
        status: dto.status as never,
        ...(dto.status === 'PICKED_UP' ? { pickedUpAt: now } : {}),
        ...(dto.status === 'ARRIVED' ? { arrivedAt: now } : {}),
        ...(dto.status === 'FAILED'
          ? {
              failedAt: now,
              failureReason: dto.failureReason ?? null,
              attemptCount: { increment: 1 },
            }
          : {}),
        ...(dto.status === 'ASSIGNED' ? { failedAt: null, failureReason: null } : {}),
      },
    });
  }

  /**
   * Captures proof of delivery and completes the delivery.
   *
   * The capture point is compared against the declared destination and the distance stored. A
   * signature taken 40 km from where the goods were supposed to go is the single most useful
   * signal of a misdelivery or a fraud, and it costs one haversine to record.
   */
  async captureProof(user: AuthenticatedUser, id: string, dto: CapturePodDto) {
    const delivery = await this.findOne(user, id);

    if (delivery.status === 'DELIVERED') {
      throw new BadRequestException('La preuve de livraison a déjà été enregistrée');
    }
    if (!['ARRIVED', 'IN_TRANSIT', 'PICKED_UP'].includes(delivery.status)) {
      throw new BadRequestException(
        `Une livraison à l’état ${quotedDeliveryStatus(delivery.status)} ne peut pas être terminée. ` +
          `Passez-la d’abord à ${quotedDeliveryStatus('ARRIVED')}.`,
      );
    }
    if ((dto.signatureBase64 || dto.photosBase64?.length) && !this.storage.isAvailable) {
      throw new BadRequestException(
        'Le stockage d’objets est indisponible : la signature et les photos ne peuvent pas être ' +
          'enregistrées. Réessayez une fois le service rétabli — la livraison n’a pas été marquée ' +
          'comme terminée.',
      );
    }

    const shipment = delivery.shipment;
    let distanceToDestinationM: number | null = null;

    if (dto.latitude !== undefined && dto.longitude !== undefined) {
      distanceToDestinationM = Math.round(
        haversineMeters(
          { latitude: dto.latitude, longitude: dto.longitude },
          {
            latitude: shipment.destinationLatitude,
            longitude: shipment.destinationLongitude,
          },
        ),
      );
    }

    let signatureKey: string | null = null;
    const photoKeys: string[] = [];

    if (dto.signatureBase64) {
      signatureKey = await this.storage.putBase64(
        delivery.companyId,
        delivery.id,
        'signature',
        dto.signatureBase64,
      );
    }
    for (const photo of dto.photosBase64 ?? []) {
      photoKeys.push(
        await this.storage.putBase64(
          delivery.companyId,
          delivery.id,
          'photo',
          photo,
          'image/jpeg',
        ),
      );
    }

    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const proof = await tx.proofOfDelivery.create({
        data: {
          deliveryId: delivery.id,
          receiverName: dto.receiverName,
          signatureKey,
          photoKeys,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          distanceToDestinationM,
          notes: dto.notes ?? null,
          capturedAt: now,
          isDemoData: delivery.isDemoData,
        },
      });

      const updated = await tx.delivery.update({
        where: { id: delivery.id },
        data: { status: 'DELIVERED', deliveredAt: now },
      });

      await tx.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          type: 'DELIVERED',
          description: `Livrée à ${dto.receiverName}`,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          metadata: {
            distanceToDestinationM,
            photos: photoKeys.length,
            signature: signatureKey !== null,
          } as Prisma.InputJsonValue,
          isDemoData: delivery.isDemoData,
        },
      });

      return { proof, delivery: updated };
    });

    // Moving the shipment to DELIVERED goes through the shipment service so the carrier's
    // on-time rate and the vehicle's availability are updated by the same code path as always.
    if (!['DELIVERED', 'CANCELLED'].includes(shipment.status)) {
      if (shipment.status !== 'ARRIVED') {
        await this.shipments.transition(user, shipment.id, 'ARRIVED', 'Arrivée à destination');
      }
      await this.shipments.transition(
        user,
        shipment.id,
        'DELIVERED',
        `Preuve de livraison enregistrée pour ${dto.receiverName}`,
        dto.latitude !== undefined && dto.longitude !== undefined
          ? { latitude: dto.latitude, longitude: dto.longitude }
          : undefined,
      );
    }

    const suspicious =
      distanceToDestinationM !== null && distanceToDestinationM > POD_DISTANCE_WARNING_M;

    if (suspicious) {
      this.logger.warn(
        `Proof of delivery for ${shipment.trackingNumber} captured ${distanceToDestinationM}m from the destination`,
      );
    }

    return {
      ...result,
      distanceToDestinationM,
      suspicious,
      warning: suspicious
        ? `Preuve enregistrée à ${(distanceToDestinationM! / 1000).toFixed(1)} km de la ` +
          'destination déclarée. La détection d’anomalies signalera cette livraison comme suspecte.'
        : null,
    };
  }

  /** Today's deliveries, for the driver app and the dashboard tile. */
  async today(user: AuthenticatedUser) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86_400_000);

    const where: Prisma.DeliveryWhereInput = {
      ...(user.role === 'SUPER_ADMIN' ? {} : { companyId: user.companyId ?? '__none__' }),
      ...(user.role === 'DRIVER' ? { shipment: { driver: { userId: user.id } } } : {}),
      OR: [
        { deliveredAt: { gte: start, lt: end } },
        { status: { in: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED'] } },
      ],
    };

    const deliveries = await this.prisma.delivery.findMany({
      where,
      include: {
        shipment: {
          select: {
            trackingNumber: true,
            destinationName: true,
            destinationLatitude: true,
            destinationLongitude: true,
            estimatedArrivalAt: true,
            status: true,
          },
        },
        customer: { select: { name: true } },
      },
      orderBy: { assignedAt: 'asc' },
    });

    return {
      date: start.toISOString().slice(0, 10),
      total: deliveries.length,
      completed: deliveries.filter((d) => d.status === 'DELIVERED').length,
      pending: deliveries.filter((d) => d.status !== 'DELIVERED' && d.status !== 'FAILED').length,
      failed: deliveries.filter((d) => d.status === 'FAILED').length,
      deliveries,
    };
  }
}
