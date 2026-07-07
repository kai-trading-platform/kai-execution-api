import { Injectable, NotFoundException } from '@nestjs/common';
import { Mt5BrokerAdapter } from '../adapters/mt5/mt5-broker.adapter';
import { RithmicBrokerAdapter } from '../adapters/rithmic/rithmic-broker.adapter';
import { SimBrokerAdapter } from '../adapters/sim/sim-broker.adapter';
import type { BrokerAdapter } from './broker-adapter.interface';
import type { BrokerProviderKey } from './types';

@Injectable()
export class BrokerRegistryService {
  private readonly adapters: Map<BrokerProviderKey, BrokerAdapter>;

  constructor(
    mt5BrokerAdapter: Mt5BrokerAdapter,
    rithmicBrokerAdapter: RithmicBrokerAdapter,
    simBrokerAdapter: SimBrokerAdapter,
  ) {
    this.adapters = new Map<BrokerProviderKey, BrokerAdapter>([
      [mt5BrokerAdapter.provider, mt5BrokerAdapter],
      [rithmicBrokerAdapter.provider, rithmicBrokerAdapter],
      [simBrokerAdapter.provider, simBrokerAdapter],
    ]);
  }

  has(provider: BrokerProviderKey): boolean {
    return this.adapters.has(provider);
  }

  get(provider: BrokerProviderKey): BrokerAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new NotFoundException(
        `Trading provider not registered: ${provider}`,
      );
    }
    return adapter;
  }
}
