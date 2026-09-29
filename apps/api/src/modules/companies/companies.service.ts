import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { requireCompanyId } from '../../common/tenancy/tenant-scope';
import type { UpdateCompanyDto } from './companies.dto';

const PUBLIC_FIELDS = {
  id: true,
  name: true,
  slug: true,
  country: true,
  city: true,
  currency: true,
  timezone: true,
  isDemoData: true,
} as const;

/**
 * The caller's own company. There is deliberately no "by id" variant: a tenant only ever edits
 * itself, and the installer sets currency and time zone right after registration through this.
 */
@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  async current(user: AuthenticatedUser) {
    const company = await this.prisma.company.findUnique({
      where: { id: requireCompanyId(user) },
      select: PUBLIC_FIELDS,
    });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  async updateCurrent(user: AuthenticatedUser, dto: UpdateCompanyDto) {
    const id = requireCompanyId(user);
    const data: UpdateCompanyDto = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.currency !== undefined) data.currency = dto.currency;
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    const exists = await this.prisma.company.count({ where: { id } });
    if (!exists) throw new NotFoundException('Company not found');
    return this.prisma.company.update({ where: { id }, data, select: PUBLIC_FIELDS });
  }
}
