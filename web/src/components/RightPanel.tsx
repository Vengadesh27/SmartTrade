import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Instrument, Quote } from '../lib/types';
import { OrderForm } from './OrderForm';
import { PositionsTab, HoldingsTab, OrdersTab } from './AccountTables';

const TABS = ['Order', 'Positions', 'Holdings', 'Book'] as const;
type Tab = (typeof TABS)[number];

export function RightPanel({ active, quote }: { active: Instrument | null; quote: Quote | null }) {
  const [tab, setTab] = useState<Tab>('Order');
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
      {tab === 'Order' && (
        <OrderForm
          active={active}
          quote={quote}
          onOrderSent={() => queryClient.invalidateQueries({ queryKey: ['orders'] })}
        />
      )}
      {tab === 'Positions' && (
        <div className="tab-body">
          <PositionsTab />
        </div>
      )}
      {tab === 'Holdings' && (
        <div className="tab-body">
          <HoldingsTab />
        </div>
      )}
      {tab === 'Book' && (
        <div className="tab-body">
          <OrdersTab />
        </div>
      )}
    </aside>
  );
}
