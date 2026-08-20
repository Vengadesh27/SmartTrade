export type Position = {
  tradingsymbol: string;
  symboltoken: string;
  exchange: string;
  producttype: string;
  netqty: string | number;
  avgnetprice?: string | number;
  netprice?: string | number;
  ltp: string | number;
  pnl: string | number;
};

export type Holding = {
  tradingsymbol: string;
  quantity: string | number;
  averageprice: string | number;
  ltp: string | number;
  profitandloss: string | number;
};

export type Order = {
  tradingsymbol: string;
  transactiontype: 'BUY' | 'SELL';
  quantity: string | number;
  status: string;
  orderid: string;
  variety?: string;
};
