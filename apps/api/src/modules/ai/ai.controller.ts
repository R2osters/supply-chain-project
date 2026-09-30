import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Audit, CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { AiClientService } from './ai-client.service';
import { AiService } from './ai.service';

class AllocateDto {
  @IsString()
  productId!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  budget?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  requiredWithinDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(1)
  maxSupplierSharePercent?: number;
}

class RouteOptimizeDto {
  @IsString()
  warehouseId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  customerIds!: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  vehicleIds?: string[];

  @IsOptional()
  @IsObject()
  demandPerCustomer?: Record<string, number>;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  fuelPricePerLiter?: number;
}

class ScenarioDto {
  @IsString()
  productId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(7)
  @Max(730)
  horizonDays?: number;

  @IsOptional()
  @IsObject()
  levers?: Record<string, number>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(50000)
  iterations?: number;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;
}

@ApiBearerAuth()
@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly client: AiClientService,
  ) {}

  @Get('status')
  @RequirePermissions('ai:read')
  @ApiOperation({
    summary: 'Is the AI service reachable, and which engines does it expose',
    description:
      'When unreachable, tracking, procurement and inventory continue to work; only ' +
      'forecasting, optimisation and recommendations are affected.',
  })
  async status() {
    const health = await this.client.health();
    return {
      ...health,
      circuitOpen: this.client.isCircuitOpen,
      degradedFeatures: health.reachable
        ? []
        : ['prévisions de la demande', 'prédiction des retards', 'détection d’anomalies', 'optimisation', 'recommandations'],
    };
  }

  /* -------------------------------------------------------------- forecast */

  @Post('forecast/:productId')
  @RequirePermissions('ai:create')
  @Audit('FORECAST', 'ai')
  @ApiOperation({
    summary: 'Forecast demand for one product',
    description:
      'Compares every eligible model by walk-forward validation, keeps the winner, and stores ' +
      'the run with its metrics and data-quality report.',
  })
  @ApiQuery({ name: 'horizonDays', required: false, enum: [7, 30, 90, 180] })
  forecast(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Query('horizonDays') horizonDays?: string,
  ) {
    const parsed = Number.parseInt(horizonDays ?? '30', 10) as 7 | 30 | 90 | 180;
    const allowed = [7, 30, 90, 180].includes(parsed) ? parsed : 30;
    return this.ai.forecastProduct(user, productId, allowed);
  }

  @Get('forecast/:productId')
  @RequirePermissions('ai:read')
  @ApiOperation({ summary: 'Most recent stored forecast for a product' })
  latestForecast(@CurrentUser() user: AuthenticatedUser, @Param('productId') productId: string) {
    return this.ai.latestForecast(user, productId);
  }

  /* ----------------------------------------------------------------- delay */

  @Post('predict-delay/:shipmentId')
  @RequirePermissions('ai:create')
  @ApiOperation({
    summary: 'Delay probability for one shipment',
    description: 'Caches the result on the shipment so lists render without re-calling the model.',
  })
  predictDelay(@CurrentUser() user: AuthenticatedUser, @Param('shipmentId') shipmentId: string) {
    return this.ai.predictShipmentDelay(user, shipmentId);
  }

  @Post('predict-delay')
  @RequirePermissions('ai:create')
  @Audit('PREDICT_DELAY_ALL', 'ai')
  @ApiOperation({ summary: 'Refresh delay probability for every shipment on the road' })
  predictAllDelays(@CurrentUser() user: AuthenticatedUser) {
    return this.ai.predictAllActiveDelays(user);
  }

  /* --------------------------------------------------------------- anomaly */

  @Post('detect-anomaly/:shipmentId')
  @RequirePermissions('ai:create')
  @ApiOperation({
    summary: 'Analyse a shipment’s track for anomalies',
    description:
      'New anomalies are persisted; one already open of the same type is not duplicated, so the ' +
      'list stays a work queue rather than a log.',
  })
  detectAnomalies(
    @CurrentUser() user: AuthenticatedUser,
    @Param('shipmentId') shipmentId: string,
  ) {
    return this.ai.detectShipmentAnomalies(user, shipmentId);
  }

  /* ---------------------------------------------------------- optimisation */

  @Post('supplier/allocation')
  @RequirePermissions('ai:create')
  @Audit('ALLOCATE', 'ai')
  @ApiOperation({
    summary: 'Split a quantity across the suppliers that carry the product',
    description:
      'Solves a MILP over the live supplier price lists, honouring minimum order quantity, ' +
      'capacity, budget and any concentration limit. The run is stored in optimization_runs.',
  })
  allocate(@CurrentUser() user: AuthenticatedUser, @Body() dto: AllocateDto) {
    return this.ai.allocate(user, dto);
  }

  @Post('route/optimize')
  @RequirePermissions('ai:create')
  @Audit('OPTIMIZE_ROUTES', 'ai')
  @ApiOperation({
    summary: 'Plan delivery routes from a warehouse to a set of customers',
    description:
      'Capacitated VRP with time windows over the company’s own fleet. Customers without ' +
      'coordinates are skipped and reported.',
  })
  optimizeRoutes(@CurrentUser() user: AuthenticatedUser, @Body() dto: RouteOptimizeDto) {
    return this.ai.optimizeRoutes(user, dto);
  }

  @Post('scenario/simulate')
  @RequirePermissions('scenario:create')
  @Audit('SIMULATE', 'scenario')
  @ApiOperation({
    summary: 'What-if simulation for one product',
    description:
      'Monte Carlo across base, best and worst cases. Demand statistics come from the movement ' +
      'ledger, so the baseline reflects what actually happened rather than a stored guess.',
  })
  simulate(@CurrentUser() user: AuthenticatedUser, @Body() dto: ScenarioDto) {
    return this.ai.simulateScenario(user, dto);
  }

  /* ----------------------------------------------------------------- risk */

  @Post('risk/analyze')
  @RequirePermissions('ai:create')
  @Audit('ANALYSE_RISK', 'ai')
  @ApiOperation({
    summary: 'Company-wide risk analysis and health score',
    description: 'Replaces the previous open findings — risk is a current picture, not a log.',
  })
  analyseRisk(@CurrentUser() user: AuthenticatedUser) {
    return this.ai.analyseRisk(user);
  }

  @Post('recommendations/generate')
  @RequirePermissions('recommendation:create')
  @Audit('GENERATE_RECOMMENDATIONS', 'ai')
  @ApiOperation({
    summary: 'Generate recommendations across the whole company',
    description:
      'Each recommendation carries an executable payload and an explanation. An open ' +
      'recommendation of the same type for the same subject is superseded, not duplicated.',
  })
  generateRecommendations(@CurrentUser() user: AuthenticatedUser) {
    return this.ai.generateRecommendations(user);
  }
}
