import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { PrismaService } from './common/prisma.service';
import { JwtStrategy } from './auth/jwt.strategy';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Mt5BridgeClient } from './mt5-bridge.client';
import { RiskGuardClient } from './risk-guard.client';
import { ExecutionController } from './controller';
import { ExecutionService } from './execution.service';
import { QueryService } from './query.service';
import { Mt5BrokerAdapter } from './adapters/mt5/mt5-broker.adapter';
import { BrokerRegistryService } from './core/broker-registry.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PassportModule.register({ defaultStrategy: 'jwt' }),
  ],
  controllers: [ExecutionController],
  providers: [
    PrismaService,
    JwtStrategy,
    JwtAuthGuard,
    Mt5BridgeClient,
    RiskGuardClient,
    ExecutionService,
    QueryService,
    Mt5BrokerAdapter,
    BrokerRegistryService,
  ],
  exports: [ExecutionService, QueryService],
})
export class ExecutionModule {}
