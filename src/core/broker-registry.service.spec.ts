import { NotFoundException } from '@nestjs/common';
import { BrokerRegistryService } from './broker-registry.service';
import { Mt5BrokerAdapter } from '../adapters/mt5/mt5-broker.adapter';
import { RithmicBrokerAdapter } from '../adapters/rithmic/rithmic-broker.adapter';

describe('BrokerRegistryService', () => {
  const mt5 = { provider: 'mt5' } as unknown as Mt5BrokerAdapter;
  const rithmic = { provider: 'rithmic' } as unknown as RithmicBrokerAdapter;
  const registry = new BrokerRegistryService(mt5, rithmic);

  it('routes each provider to its own adapter', () => {
    expect(registry.get('mt5')).toBe(mt5);
    expect(registry.get('rithmic')).toBe(rithmic);
  });

  it('reports registered providers', () => {
    expect(registry.has('mt5')).toBe(true);
    expect(registry.has('rithmic')).toBe(true);
  });

  it('throws NotFound for an unregistered provider', () => {
    expect(() =>
      registry.get('ibkr' as unknown as 'mt5'),
    ).toThrow(NotFoundException);
  });

  it('MT5 routing is unchanged by the Rithmic registration', () => {
    // The mt5 adapter instance is returned verbatim — no wrapping/mutation.
    expect(registry.get('mt5')).toBe(mt5);
    expect(registry.get('mt5').provider).toBe('mt5');
  });
});
