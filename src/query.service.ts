import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from './common/prisma.service';
import { BrokerRegistryService } from './core/broker-registry.service';
import { resolveSimContract } from './adapters/sim/sim-contracts';
import type {
  BrokerCapabilities,
  BrokerProviderKey,
  ConnectedTradingAccount,
  TradingAccountContext,
  PartialExit,
  TradingHistoryItem,
  TradingOrder,
  TradingPosition,
} from './core/types';

/**
 * Inicio del día de trading actual (boundary 18:00 America/New_York, con DST).
 * El PnL diario y el SOD balance se resetean en este límite.
 */
function tradingDayStart(nowMs: number): Date {
  const now = new Date(nowMs);
  const etNow = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/New_York' }),
  );
  const offsetMs = now.getTime() - etNow.getTime();
  const boundary = new Date(etNow);
  boundary.setHours(18, 0, 0, 0);
  if (etNow.getHours() < 18) boundary.setDate(boundary.getDate() - 1);
  return new Date(boundary.getTime() + offsetMs);
}

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

    // PnL realizado del día de trading actual (18:00 ET) por cuenta, para las
    // métricas NET DAILY PNL y SOD BALANCE del terminal.
    const dayStart = tradingDayStart(Date.now());
    const dailyPnlById = await this.getDailyRealizedPnlMap(userId, dayStart);

    // Cuentas quemadas (challenge 'failed'): el terminal las muestra en modo
    // solo-lectura (badge "Quemada", panel de órdenes deshabilitado).
    const burnedIds = await this.getBurnedAccountIds(
      accounts.map((account: any) => String(account.id)),
    );

    return accounts.map((account: any) => {
      const connected = this.toConnectedAccount(
        this.toTradingAccountContext(
          account,
          this.normalizeProvider(providerById.get(String(account.id))),
          maxContractsById.get(String(account.id)),
        ),
      );
      const netDaily = dailyPnlById.get(String(account.id)) ?? 0;
      return {
        ...connected,
        netDailyPnl: netDaily,
        sodBalance:
          connected.balance == null ? null : connected.balance - netDaily,
        // Quemada = challenge 'failed' Y sin conexión. Una cuenta con challenge
        // fallido pero AÚN conectada (p.ej. sim reseteable) sigue operable y
        // no debe mostrarse como quemada.
        blown:
          burnedIds.has(String(account.id)) &&
          connected.status.toLowerCase() !== 'connected',
      };
    });
  }

  /** Suma del PnL de cierres (synced_trades filled) por cuenta desde `dayStart`. */
  private async getDailyRealizedPnlMap(
    userId: string,
    dayStart: Date,
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.syncedTrade.groupBy({
      by: ['accountId'],
      where: { userId, status: 'filled', closedAt: { gte: dayStart } },
      _sum: { pnl: true },
    });
    return new Map(
      rows
        .filter((r) => r.accountId != null)
        .map((r) => [String(r.accountId), Number(r._sum.pnl ?? 0)]),
    );
  }

  /**
   * ¿El challenge MÁS RECIENTE de la cuenta está 'failed' (cuenta QUEMADA: la
   * prop firm la retiró)? Espejo de execution.service#isChallengeBurned:
   * $queryRaw porque prop_challenges es dominio de kai-backend (BD compartida).
   * Ante error responde false (se conserva el comportamiento previo).
   */
  private async isChallengeBurned(accountId: string): Promise<boolean> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM prop_challenges
        WHERE mt5_account_id = ${accountId}::uuid
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`;
      return String(rows[0]?.status ?? '').toLowerCase() === 'failed';
    } catch {
      return false;
    }
  }

  /**
   * Set de cuentas quemadas (último challenge 'failed') para un lote de ids.
   * Una sola query para el listado de cuentas del terminal.
   */
  private async getBurnedAccountIds(
    accountIds: string[],
  ): Promise<Set<string>> {
    if (accountIds.length === 0) return new Set();
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ mt5_account_id: string; status: string }>
      >`
        SELECT DISTINCT ON (mt5_account_id) mt5_account_id::text, status
        FROM prop_challenges
        WHERE mt5_account_id::text = ANY(${accountIds})
        ORDER BY mt5_account_id, updated_at DESC NULLS LAST`;
      return new Set(
        rows
          .filter((row) => String(row.status ?? '').toLowerCase() === 'failed')
          .map((row) => String(row.mt5_account_id)),
      );
    } catch {
      return new Set();
    }
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
    if (value === 'rithmic') return 'rithmic';
    if (value === 'sim') return 'sim';
    return 'mt5';
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
    // Cuenta QUEMADA sin conexión: la prop firm ya la retiró; no hay provider
    // que consultar y reintentar solo produce 503s + reconexiones inútiles del
    // bridge. Posiciones abiertas = [] es la lectura correcta (solo lectura).
    if (
      account.status.toLowerCase() !== 'connected' &&
      (await this.isChallengeBurned(account.id))
    ) {
      return [];
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

  /**
   * Órdenes PENDIENTES (working orders) de la cuenta. A diferencia de posiciones,
   * un provider sin soporte devuelve lista vacía (no 503): un panel de "órdenes
   * pendientes" vacío es la lectura correcta para una cuenta que opera a mercado.
   */
  async listOrders(
    userId: string,
    tradingAccountId: string,
  ): Promise<TradingOrder[]> {
    const account = await this.getOwnedAccountContext(userId, tradingAccountId);
    if (!this.brokerRegistry.has(account.provider)) return [];
    const adapter = this.brokerRegistry.get(account.provider);
    if (!adapter.supports('list_orders') || !adapter.listOrders) return [];
    // Misma regla que listPositions: cuenta quemada sin conexión → [] (no 503).
    if (
      account.status.toLowerCase() !== 'connected' &&
      (await this.isChallengeBurned(account.id))
    ) {
      return [];
    }
    try {
      return await adapter.listOrders(account);
    } catch (error) {
      throw new ServiceUnavailableException({
        code: 'TRADING_ORDERS_UNAVAILABLE',
        message: 'No se pudo consultar órdenes del provider.',
        provider: account.provider,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Historial de trades cerrados de la cuenta. Todos los providers (mt5/rithmic/
   * sim) escriben los cierres en synced_trades (status 'filled'), así que se sirve
   * con una query uniforme, sin depender del adapter del broker.
   */
  async listHistory(
    userId: string,
    tradingAccountId: string,
    limit = 100,
  ): Promise<TradingHistoryItem[]> {
    const account = await this.getOwnedAccountContext(userId, tradingAccountId);
    // NOTA (Rithmic / futuros reales): NO hay historial de cerrados POR CUENTA.
    // Los trading_signals/signal_outcomes son a nivel ESTRATEGIA (user-scoped) y se
    // ejecutan en VARIAS cuentas (SIM + Apex real); no existe un tag cuenta↔outcome
    // fiable (synced_trades vacío para rithmic, order_idempotency vacío, y solo
    // algunas ejecuciones dejan notificación con signal_id). Leer signals+outcomes
    // aquí mostraba los 25 trades de la ESTRATEGIA en el chart de UNA cuenta →
    // incorrecto. Hasta que exista un registro de fills por-cuenta para rithmic,
    // rithmic cae al query de synced_trades (vacío → []): sin cajas de cerrados.
    const rows = await this.prisma.syncedTrade.findMany({
      where: { accountId: account.id, status: 'filled' },
      orderBy: { closedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
    });
    return rows.map((row) => {
      // El sync guarda metadata del cierre en el comment como
      // `KAI_META:{entryPrice, closePrice, reason, closeSource, ...}` (misma
      // fuente que usa la vista Orders del frontend principal vía
      // /api/journal/history). Cuando existe, el closePrice REAL del broker
      // manda sobre el exitPrice derivado del PnL.
      const meta = this.parseKaiMeta(row.comment);
      const entryPrice =
        meta?.entryPrice != null && Number.isFinite(Number(meta.entryPrice))
          ? Number(meta.entryPrice)
          : Number(row.price);
      const metaClosePrice =
        meta?.closePrice != null && Number.isFinite(Number(meta.closePrice))
          ? Number(meta.closePrice)
          : null;
      return {
        id: row.id,
        // Ticket del broker (columna ID en la tabla EJECUTADAS del terminal y
        // referencia para reportes de trades). BigInt → string por JSON.
        ticket: row.ticket != null ? String(row.ticket) : null,
        tradingAccountId: account.id,
        provider: account.provider,
        symbol: row.symbol,
        side:
          String(row.side).toUpperCase() === 'LONG'
            ? ('buy' as const)
            : ('sell' as const),
        volume: Number(row.qty),
        entryPrice,
        exitPrice:
          metaClosePrice ??
          this.deriveExitPrice(
            account.provider,
            row.symbol,
            String(row.side).toUpperCase() === 'LONG',
            Number(row.price),
            Number(row.qty),
            row.pnl == null ? null : Number(row.pnl),
          ),
        stopLoss: row.sl == null ? null : Number(row.sl),
        takeProfit: row.tp == null ? null : Number(row.tp),
        profitLoss: row.pnl == null ? null : Number(row.pnl),
        openedAt: row.openedAt ? row.openedAt.toISOString() : null,
        closedAt: row.closedAt ? row.closedAt.toISOString() : null,
        closeSource: meta?.closeSource != null ? String(meta.closeSource) : null,
        closeReason: meta?.reason != null ? String(meta.reason) : null,
        // Salidas parciales (scale-out): solo si hay MÁS de un tramo (igual que el
        // Journal del app principal). La tabla EJECUTADAS del terminal las despliega.
        partials:
          Array.isArray(meta?.partials) &&
          (meta!.partials as unknown[]).length > 1
            ? (meta!.partials as PartialExit[])
            : null,
      };
    });
  }

  /** Parsea el JSON de un comment `KAI_META:{...}`; null si no aplica o está roto. */
  private parseKaiMeta(comment: string | null): {
    entryPrice?: unknown;
    closePrice?: unknown;
    reason?: unknown;
    closeSource?: unknown;
    partials?: unknown;
  } | null {
    if (!comment || !comment.startsWith('KAI_META:')) return null;
    try {
      const parsed: unknown = JSON.parse(comment.substring(9));
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Precio de SALIDA de un trade cerrado, derivado del PnL realizado — el
   * historial (synced_trades) no guarda el precio de cierre. Con esto el chart
   * dibuja la caja del trade cerrado de entry→SALIDA REAL (coloreada por
   * resultado) en vez del SL/TP del plan, que confunde cuando el trade cerró
   * antes de tocar el SL.
   *
   * Fórmula del motor sim: `pnl = (exit−entry)·dir·pointValue·qty − commRT·qty`,
   * así que `exit = entry + (pnl + commRT·qty) / (dir·pointValue·qty)`. Para sim
   * sumamos la comisión de vuelta (su PnL es NETO); para rithmic el PnL viene del
   * broker (sin la comisión sim). MT5 (CFD) no tiene tabla de pointValue estática
   * → null (el chart cae a marcador de sólo-entrada).
   */
  private deriveExitPrice(
    provider: BrokerProviderKey,
    symbol: string,
    isLong: boolean,
    entry: number,
    qty: number,
    pnl: number | null,
  ): number | null {
    if (pnl == null || !Number.isFinite(entry) || !(qty > 0)) return null;
    const contract = resolveSimContract(symbol);
    if (!contract || !(contract.pointValue > 0)) return null;
    const grossPnl = provider === 'sim' ? pnl + contract.commissionRT * qty : pnl;
    const dir = isLong ? 1 : -1;
    const exit = entry + grossPnl / (dir * contract.pointValue * qty);
    if (!Number.isFinite(exit)) return null;
    // Redondeo al tick del contrato para un precio limpio.
    const ticks = Math.round(exit / contract.tickSize);
    return Number((ticks * contract.tickSize).toFixed(6));
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
      flattenAll: adapter.capabilities.flattenAll === true && isConnected,
      cancelAllOrders:
        adapter.capabilities.cancelAllOrders === true && isConnected,
      reversePosition:
        adapter.capabilities.reversePosition === true && isConnected,
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
