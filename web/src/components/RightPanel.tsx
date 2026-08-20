import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Instrument, Quote } from '../lib/types';
// queryClient still used by other tabs

import { PositionsTab, HoldingsTab, OrdersTab } from './AccountTables';
import { BotConfig } from './BotConfig';
import { OptionsOrder } from './OptionsOrder';

const TABS = ['Options', 'Positions', 'Holdings', 'Book', 'Bot'] as const;
type Tab = (typeof TABS)[number];

export function RightPanel({
  active,
  quote,
  enabled,
}: {
  active: Instrument | null;
  quote: Quote | null;
  enabled?: boolean;
}) {
  const [tab, setTab] = useState<Tab>('Options');
  const queryClient = useQueryClient();

  return (
    <aside className="panel right-col">
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'Options' && (
        <OptionsOrder underlyingSpot={quote?.ltp ?? null} />
      )}
      {tab === 'Positions' && (
        <div className="tab-body"><PositionsTab /></div>
      )}
      {tab === 'Holdings' && (
        <div className="tab-body"><HoldingsTab /></div>
      )}
      {tab === 'Book' && (
        <div className="tab-body"><OrdersTab /></div>
      )}
      {tab === 'Bot' && (
        <BotConfig
          defaultSymbol={active?.sym || 'NIFTY'}
          defaultExchange={active?.exch || 'NSE'}
          enabled={!!enabled}
        />
      )}
    </aside>
  );
}
