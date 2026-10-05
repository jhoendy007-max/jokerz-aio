export type TaskStatus = 'idle' | 'queued' | 'running' | 'oos' | 'instock' | 'carting' | 'carted' | 'checkout' | 'success' | 'failed';

export type Store = 'Walmart' | 'Target' | 'Pokemon Center' | 'Bandai Collectables';

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export interface Task {
  id: string;
  store: Store | string;
  product: string;
  profile: string;
  proxy: string;
  quantity: string;
  status: TaskStatus;
  /** short label under/beside badge e.g. IN STOCK · $29.99 */
  statusMessage?: string;
  lastCheckAt?: number;
  // Campos extra que se usarán más adelante
  mode?: string;
  delay?: number;
  resetDelay?: number;
  monitorHighStock?: boolean;
  /** Discord/Slack stock alert cooldown per product (ms). Default 180000 */
  stockAlertCooldownMs?: number;
  moduleUnlockDelay?: number;
  region?: string;
  monitoringDelay?: number;
  sku?: string;
  offerId?: string;
  /** higher runs first when queued */
  priority?: TaskPriority;
  /** Linked account email — login runs on this task (Refract) */
  accountEmail?: string;
  /** Live Target: ATC + fill pay + Place order. Default dry-run. */
  liveCheckout?: boolean;
  placeOrder?: boolean;
  solve3ds?: boolean;
  /** same = login+harvest+ATC one sticky IP. split = pick groups per role */
  proxyBind?: 'same' | 'split';
  loginProxy?: string;
  harvestProxy?: string;
}

export interface Profile {
  id: string;
  name: string;
  group: string;
  email: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  cardholder?: string;
  cardNumber?: string;
  /** last 4 — derived or manual */
  cardEnd: string;
  exp?: string;
  cvv?: string;
}

export interface CheckoutData {
  date: string;
  success: number;
  declines: number;
}

export interface RecentPurchase {
  id: string;
  store: string;
  product: string;
  orderNumber: string;
  quantity: string;
  profile: string;
  date: string;
  price: string;
}

// Estado del formulario de creación de tasks
export interface CreateTaskFormState {
  priority: TaskPriority;
  name: string;
  store: Store;
  mode: string;
  profile: string;
  checkoutProxy: string;
  queueProxy: string;
  monitorProxy: string;
  sku: string;
  offerId: string;
  inputList: string;          // Target
  urlsOrPids: string;         // Pokemon Center
  region: string;             // Pokemon Center
  coupon: string;
  delay: number;
  monitoringDelay: number;
  moduleUnlockDelay: number;
  qty: number;
  session: string;
  imapSession: string;
  otpInput: string;
  checkSms: boolean;
  checkoutSms: string;
  resetInvalid: boolean;
  startTime: string;
  endTime: string;
  extraTcin: string;
  autoCancel: boolean;
  watchTask: boolean;
  endlessMode: boolean;
  endlessLimit: string;
  useRakuten: boolean;
  useTopCashback: boolean;
  minItemsInCart: number;
  catchAll: boolean;
  solve3ds: boolean;
  rotateProfiles: boolean;
  maxPrice: string;
  allow3rdParty: boolean;
  resetDelay: string;
  monitorHighStock: boolean;
  /** empty = use default 180s */
  stockAlertCooldownMs: string;
  /** Settings → Accounts email, or "all" */
  accountEmail: string;
  liveCheckout: boolean;
  proxyBind: 'same' | 'split';
  loginProxy: string;
  harvestProxy: string;
}

export const defaultCreateTaskForm: CreateTaskFormState = {
  priority: 'high',
  name: '',
  store: 'Target',
  mode: 'monitor',
  profile: 'Main Profile',
  checkoutProxy: 'ISPs-VA',
  queueProxy: '',
  monitorProxy: 'ISPs-VA',
  sku: '',
  offerId: '',
  inputList: '',
  urlsOrPids: '',
  region: 'US',
  coupon: '',
  delay: 14000,
  monitoringDelay: 4000,
  moduleUnlockDelay: 12222,
  qty: 1,
  session: '',
  imapSession: 'AYCD Inbox',
  otpInput: 'IMAP',
  checkSms: false,
  checkoutSms: '',
  resetInvalid: false,
  startTime: '',
  endTime: '',
  extraTcin: '',
  autoCancel: false,
  watchTask: true,
  endlessMode: false,
  endlessLimit: '',
  useRakuten: false,
  useTopCashback: false,
  minItemsInCart: 1,
  catchAll: false,
  solve3ds: false,
  rotateProfiles: false,
  maxPrice: '',
  allow3rdParty: false,
  resetDelay: '',
  monitorHighStock: false,
  stockAlertCooldownMs: '180000',
  accountEmail: '',
  liveCheckout: false,
  proxyBind: 'same',
  loginProxy: 'ISPs-VA',
  harvestProxy: 'ISPs-VA',
};
