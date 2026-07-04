import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from './common/prisma.service';
import { BrokerRegistryService } from './core/broker-registry.service';
import type {
  BrokerCapabilities,
  BrokerProviderKey,
  ConnectedTradingAccount,
  TradingAccountContext,
  TradingPosition,
} from './core/types';

const DISABLED_CAPABILITIES: BrokerCapabilities = {
  listAccounts: false,
  listPositions: false,
  placeMarketOrder: false,
  closePosition: false,
  updateStops: false,
};

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

    // The trading-account row carries its own provider routing ('mt5' | 'rithmic').
    // The generated Prisma client can lag behind the shared schema, so read the
    // `provider` column via a scoped raw query and stamp each account with it.
    // MT5 rows keep provider 'mt5' (unchanged); Rithmic rows surface as futures.
    const providerById = await this.getProviderMap(userId);
    // Per-account contracts cap (money-safe override of risk-based sizing),
    // same `system_configs` key the backend auto-trading processor and the
    // manual Rithmic execution path already enforce. Surfaced here so the
    // terminal's cap badge can display it before an order is even placed.
    const maxContractsById = await this.getMaxContractsMap(
      accounts.map((account: any) => ({
        id: String(account.id),
        mt5AccountId: String(account.mt5AccountId),
      })),
    );

    return accounts.map((account: any) =>
      this.toConnectedAccount(
        this.toTradingAccountContext(
          account,
          this.normalizeProvider(providerById.get(String(account.id))),
          maxContractsById.get(String(account.id)),
        ),
      ),
    );
  }

  private async getProviderMap(
    userId: string,
  ): Promise<Map<string, string>> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; provider: string }>
    >`SELECT id, provider FROM mt5_accounts WHERE user_id = ${userId}::uuid`;
    return new Map(rows.map((row) => [String(row.id), row.provider]));
  }

  /**
   * Resolve a single account's provider routing. Like {@link getProviderMap},
   * this reads the `provider` column via a scoped raw query because the generated
   * Prisma client can lag behind the shared schema (so `account.provider` from a
   * typed `findFirst` is undefined). Scoped to the owning user. Without this,
   * getOwnedAccountContext defaulted every account to 'mt5' and a Rithmic account
   * would misroute its positions/actions to the MT5 adapter.
   */
  private async getProviderForAccount(
    userId: string,
    accountId: string,
  ): Promise<BrokerProviderKey> {
    const rows = await this.prisma.$queryRaw<Array<{ provider: string }>>`
      SELECT provider FROM mt5_accounts
      WHERE id = ${accountId}::uuid AND user_id = ${userId}::uuid
      LIMIT 1`;
    return this.normalizeProvider(rows[0]?.provider);
  }

  private normalizeProvider(value: unknown): BrokerProviderKey {
    return value === 'rithmic' ? 'rithmic' : 'mt5';
  }

  /**
   * Resolve the per-account contracts cap for a batch of accounts. Mirrors
   * {@link getProviderMap}'s pattern: one scoped raw query (the generated
   * Prisma client can lag behind the shared schema for newly-added tables/
   * columns too, so we don't rely on a typed `systemConfig` delegate here)
   * reading `system_configs` for every candidate key, then resolved per
   * account with the account UUID taking priority over the broker login/ref
   * fallback — the exact same priority order
   * `rithmic-execution.service.ts#resolveMaxContractsCap` and the auto-trading
   * processor use server-side. Absent or non-positive values mean "no cap"
   * and are omitted (undefined), leaving MT5 accounts without a configured
   * cap unchanged.
   */
  private async getMaxContractsMap(
    accounts: Array<{ id: string; mt5AccountId: string }>,
  ): Promise<Map<string, number>> {
    const capById = new Map<string, number>();
    if (accounts.length === 0) return capById;

    const keys = accounts.flatMap((account) => [
      `autotrading:maxContracts:${account.id}`,
      `autotrading:maxContracts:${account.mt5AccountId}`,
    ]);

    const rows = await this.prisma.$queryRaw<
      Array<{ key: string; value: unknown }>
    >`SELECT key, value FROM system_configs WHERE key = ANY(${keys})`;

    const capByKey = new Map<string, number>();
    for (const row of rows) {
      const n = Number(row.value);
      if (Number.isFinite(n) && n > 0) {
        capByKey.set(row.key, n);
      }
    }

    for (const account of accounts) {
      const cap =
        capByKey.get(`autotrading:maxContracts:${account.id}`) ??
        capByKey.get(`autotrading:maxContracts:${account.mt5AccountId}`);
      if (cap !== undefined) {
        capById.set(account.id, cap);
      }
    }

    return capById;
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

    const provider = await this.getProviderForAccount(userId, tradingAccountId);
    return this.toTradingAccountContext(account, provider);
  }

  toConnectedAccount(account: TradingAccountContext): ConnectedTradingAccount {
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
      maxContracts: account.maxContracts,
      capabilities: this.resolveCapabilities(account),
    };
  }

  private resolveCapabilities(
    account: TradingAccountContext,
  ): BrokerCapabilities {
    // Providers without a registered adapter (e.g. Rithmic in Phase 1) are
    // listable but not yet interactive: expose them read-only until their
    // adapter lands. This keeps the account visible in the terminal without
    // enabling trading actions the backend can't service yet.
    if (!this.brokerRegistry.has(account.provider)) {
      return { ...DISABLED_CAPABILITIES };
    }
    const adapter = this.brokerRegistry.get(account.provider);
    const isConnected = account.status.toLowerCase() === 'connected';
    return {
      ...adapter.capabilities,
      placeMarketOrder: adapter.capabilities.placeMarketOrder && isConnected,
      closePosition: adapter.capabilities.closePosition && isConnected,
      updateStops: adapter.capabilities.updateStops && isConnected,
    };
  }

  private toTradingAccountContext(
    account: any,
    provider: BrokerProviderKey = 'mt5',
    maxContracts?: number,
  ): TradingAccountContext {
    return {
      id: account.id,
      userId: account.userId,
      provider,
      providerAccountId: String(account.mt5AccountId),
      name: String(account.accountName || account.mt5AccountId),
      server: account.server ?? null,
      status: String(account.connectionStatus || 'pending'),
      accountType: String(account.accountType || 'demo'),
      isDefault: account.isDefault === true,
      balance: this.toNumberOrNull(account.balance),
      equity: this.toNumberOrNull(account.equity),
      maxContracts,
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
