export type OrderStatus =
  | 'created'
  | 'paid'
  | 'delivering'
  | 'delivered'
  | 'payment_failed'
  | 'out_of_stock'
  | 'delivery_failed';

export type Order = {
  id: string;
  sku: string;
  amount: number;
  currency: string;
  status: OrderStatus;
  delivery_code: string | null;
  provider: string | null;
  request_id: string | null;
  last_error: string | null;
  attempt_count: number;
  next_attempt_at: Date | null;
  paid_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
};

export type PaymentWebhook = {
  event_id: string;
  order_id: string;
  status: 'paid' | 'failed';
  amount: number;
  currency: string;
  created_at: string;
};

export type IssueRequest = {
  request_id: string;
  sku: string;
  order_id: string;
};

export type IssueSuccess = {
  status: 'ok';
  request_id: string;
  code: string;
};

export type IssueError = {
  status: 'error';
  reason: string;
};

export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'delivered',
  'payment_failed',
]);

export const RECOVERABLE_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'paid',
  'delivering',
  'out_of_stock',
  'delivery_failed',
]);
