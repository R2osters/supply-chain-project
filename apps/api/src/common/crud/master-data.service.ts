import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PaginatedResult, PaginationQueryDto } from '../dto/pagination.dto';
import { paginated, safeOrderBy } from '../dto/pagination.dto';
import { companyFilter, requireCompanyId } from '../tenancy/tenant-scope';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * The subset of a Prisma model delegate this helper needs. Typing against this instead of a
 * concrete delegate keeps one implementation usable for every master-data table without
 * `any` leaking into the modules that use it.
 */
export interface PrismaDelegateLike<TModel> {
  findMany(args: Record<string, unknown>): Promise<TModel[]>;
  findUnique(args: Record<string, unknown>): Promise<TModel | null>;
  count(args: Record<string, unknown>): Promise<number>;
  create(args: Record<string, unknown>): Promise<TModel>;
  update(args: Record<string, unknown>): Promise<TModel>;
}

export interface MasterDataOptions {
  /** Name shown in error messages, in French and capitalised, e.g. "Fournisseur". */
  entity: string;
  /** Columns `?sortBy=` may reference. Anything else falls back to `defaultSort`. */
  sortable: readonly string[];
  defaultSort: string;
  /** Columns a `?search=` term is matched against, case-insensitively. */
  searchable: readonly string[];
  /** Relations to include on findOne. */
  detailInclude?: Record<string, unknown>;
  /** Relations to include on list rows. */
  listInclude?: Record<string, unknown>;
}

/**
 * Shared list/read/create/update/soft-delete behaviour for the eight master-data tables
 * (suppliers, customers, carriers, warehouses, vehicles, drivers, products, categories).
 *
 * Written once rather than eight times because the tenancy rules are the part that must not vary:
 * every read goes through `companyFilter`, every write through `requireCompanyId`, and `findOne`
 * re-checks ownership so an id guessed from another tenant returns 404 rather than the row.
 * Modules with real domain behaviour (shipments, inventory, purchase orders) do NOT use this —
 * they have their own services, because their invariants are not CRUD.
 */
export class MasterDataService<TModel extends { id: string; companyId: string }> {
  constructor(
    private readonly delegate: PrismaDelegateLike<TModel>,
    private readonly options: MasterDataOptions,
  ) {}

  private searchWhere(term?: string): Record<string, unknown> {
    if (!term) return {};
    return {
      OR: this.options.searchable.map((field) => ({
        [field]: { contains: term, mode: 'insensitive' },
      })),
    };
  }

  async list(
    user: AuthenticatedUser,
    query: PaginationQueryDto,
    extraWhere: Record<string, unknown> = {},
  ): Promise<PaginatedResult<TModel>> {
    const where = { ...companyFilter(user), ...this.searchWhere(query.search), ...extraWhere };

    const [data, total] = await Promise.all([
      this.delegate.findMany({
        where,
        include: this.options.listInclude,
        orderBy: safeOrderBy(query, this.options.sortable, this.options.defaultSort),
        skip: query.skip,
        take: query.limit,
      }),
      this.delegate.count({ where }),
    ]);

    return paginated(data, total, query);
  }

  async findOne(user: AuthenticatedUser, id: string): Promise<TModel> {
    const row = await this.delegate.findUnique({
      where: { id },
      include: this.options.detailInclude,
    });

    // A row from another tenant is reported as missing, not forbidden: a 403 would confirm the
    // id exists, which is itself a leak across tenants.
    if (!row || (user.role !== 'SUPER_ADMIN' && row.companyId !== user.companyId)) {
      throw new NotFoundException(`${this.options.entity} introuvable (identifiant ${id})`);
    }
    return row;
  }

  async create(user: AuthenticatedUser, data: Record<string, unknown>): Promise<TModel> {
    const companyId = requireCompanyId(user, data.companyId as string | undefined);
    return this.delegate.create({
      data: { ...data, companyId },
      include: this.options.detailInclude,
    });
  }

  async update(
    user: AuthenticatedUser,
    id: string,
    data: Record<string, unknown>,
  ): Promise<TModel> {
    await this.findOne(user, id);
    // companyId is never movable through an update — reassigning a row to another tenant is
    // not a business operation, it is a bug or an attack.
    const { companyId: _ignored, ...safe } = data;
    return this.delegate.update({
      where: { id },
      data: safe,
      include: this.options.detailInclude,
    });
  }

  /**
   * Soft delete. Master data is referenced by historical documents (a shipment from three years
   * ago still points at its carrier), so rows are deactivated rather than removed; hard deletes
   * would either break foreign keys or silently rewrite history.
   */
  async deactivate(user: AuthenticatedUser, id: string): Promise<TModel> {
    await this.findOne(user, id);
    return this.delegate.update({ where: { id }, data: { isActive: false } });
  }

  async reactivate(user: AuthenticatedUser, id: string): Promise<TModel> {
    await this.findOne(user, id);
    return this.delegate.update({ where: { id }, data: { isActive: true } });
  }

  /** Guard for endpoints that a party-scoped role must never reach. */
  static denyPartyScopedRoles(user: AuthenticatedUser, entity: string): void {
    if (['SUPPLIER', 'CUSTOMER', 'DRIVER'].includes(user.role)) {
      throw new ForbiddenException(`Votre type de compte ne permet pas de gérer ces enregistrements (${entity})`);
    }
  }
}
