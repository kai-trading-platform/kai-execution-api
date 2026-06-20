import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from './common/prisma.service';
import { BrokerRegistryService } from './core/broker-registry.service';
import type {
  BrokerProviderKey,
  ConnectedTradingAccount,
  TradingAccountContext,
  TradingPosition,
} from './core/types';

@Injectable()
export class QueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brokerRegistry: BrokerRegistryService,
  ) {}

  async listAccounts(userId: string): Promise<ConnectedTradingAccount[]> {
    const accounts = await this.prisma.mt5Account.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });

    return accounts.map((account: any) =>
      this.toConnectedAccount(this.toTradingAccountContext(account)),
    );
  }

  async listPositions(
    userId: string,
    tradingAccountId: string,
  ): Promise<TradingPosition[]> {
    const account = await this.getOwnedAccountContext(userId, tradingAccountId);
    const adapter = this.brokerRegistry.get(account.provider);
    if (!adapter.supports('list_positions')) {
      throw new ForbiddenException(
        `Provider ${account.provider} does not support listing positions`,
      );
    }
    try {
      return await adapter.listPositions(account);
    } catch (error) {
      throw new ServiceUnavailableException({
        code: 'TRADING_POSITIONS_UNAVAILABLE',
        message: 'No se pudo consultar posiciones del provider.',
        provider: account.provider,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getOwnedAccountContext(
    userId: string,
    tradingAccountId: string,
  ): Promise<TradingAccountContext> {
    const account = await this.prisma.mt5Account.findFirst({
      where: { id: tradingAccountId, userId },
    });

    if (!account) {
      throw new NotFoundException('Trading account not found');
    }

    return this.toTradingAccountContext(account);
  }

  toConnectedAccount(account: TradingAccountContext): ConnectedTradingAccount {
    const adapter = this.brokerRegistry.get(account.provider);
    const isConnected = account.status.toLowerCase() === 'connected';
    return {
      id: account.id,
      provider: account.provider,
      providerAccountId: account.providerAccountId,
      name: account.name,
      server: account.server,
      status: account.status,
      accountType: account.accountType,
      isDefault: account.isDefault,
      balance: account.balance,
      equity: account.equity,
      capabilities: {
        ...adapter.capabilities,
        placeMarketOrder: adapter.capabilities.placeMarketOrder && isConnected,
        closePosition: adapter.capabilities.closePosition && isConnected,
        updateStops: adapter.capabilities.updateStops && isConnected,
      },
    };
  }

  private toTradingAccountContext(account: any): TradingAccountContext {
    return {
      id: account.id,
      userId: account.userId,
      provider: 'mt5' satisfies BrokerProviderKey,
      providerAccountId: String(account.mt5AccountId),
      name: String(account.accountName || account.mt5AccountId),
      server: account.server ?? null,
      status: String(account.connectionStatus || 'pending'),
      accountType: String(account.accountType || 'demo'),
      isDefault: account.isDefault === true,
      balance: this.toNumberOrNull(account.balance),
      equity: this.toNumberOrNull(account.equity),
      bridgeInstance: account.bridgeInstance ?? null,
      customComment: account.customComment ?? null,
      customMagicNumber: account.customMagicNumber ?? null,
    };
  }

  private toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
}
