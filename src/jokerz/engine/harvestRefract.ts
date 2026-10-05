/**
 * Refract-style harvest loop.
 *
 * Each harvester is an independent worker:
 *   ATC  → random PDP → Ship it / ATC → dump Shape cookies → NEW context
 *   Login → /login → fake email → dump login Shape cookies → NEW context
 * Repeat until bank size. Cookies stay bound to the harvest IP (sticky).
 * Browser is headed. Monitor/checkout stay headless.
 */
import { getActiveProfileForStore, storeToFpModule } from './fingerprintProfiles';
import { spoofPackForStore } from './chromeUaSpoof';

export type HarvestKind = 'atc' | 'login';

export type HarvestStep =
  | 'idle'
  | 'proxy'
  | 'home'
  | 'pdp'
  | 'atc'
  | 'account'
  | 'fake_email'
  | 'capture'
  | 'reset'
  | 'full';

/** Cheap always-listed Target TCINs used only to generate Shape cookies (not to buy). */
export const TARGET_ATC_TCINS = [
  '14753310', // paper towels-ish / household
  '12953964',
  '76130492',
  '54362597',
  '81827799',
  '13329207',
  '76130312',
  '14753302',
];

export const WALMART_ATC_IDS = ['54749165', '44390947', '10294407'];

export function harvestKindFromModule(module?: string): HarvestKind {
  const m = String(module || '').toLowerCase();
  if (m.includes('login') || m.includes('shape-login')) return 'login';
  return 'atc';
}

export function harvestStoreFromModule(module?: string): string {
  const m = String(module || '').toLowerCase();
  if (m.includes('walmart')) return 'walmart';
  if (m.includes('pkc') || m.includes('pokemon')) return 'pokemon';
  if (m.includes('bandai')) return 'bandai';
  return 'target';
}

export function randomTargetPdp(): { tcin: string; url: string } {
  const tcin = TARGET_ATC_TCINS[Math.floor(Math.random() * TARGET_ATC_TCINS.length)];
  return { tcin, url: `https://www.target.com/p/-/A-${tcin}` };
}

export function fakeHarvestEmail(): string {
  const n = Math.floor(100000 + Math.random() * 900000);
  return `harvest${n}@gmail.com`;
}

export function fakeHarvestPassword(): string {
  return `Jx${Math.random().toString(36).slice(2, 10)}!9`;
}

export function harvestHomeUrl(store: string): string {
  if (store === 'walmart') return 'https://www.walmart.com/';
  if (store === 'pokemon') return 'https://www.pokemoncenter.com/';
  if (store === 'bandai') return 'https://p-bandai.com/us';
  return 'https://www.target.com/';
}

export function harvestLoginUrl(store: string): string {
  if (store === 'walmart') return 'https://www.walmart.com/account/login';
  if (store === 'pokemon') return 'https://www.pokemoncenter.com/login';
  if (store === 'bandai') return 'https://p-bandai.com/us/login';
  return 'https://www.target.com/login';
}

export const ATC_STEPS: HarvestStep[] = ['proxy', 'home', 'pdp', 'atc', 'capture', 'reset'];
export const LOGIN_STEPS: HarvestStep[] = ['proxy', 'home', 'account', 'fake_email', 'capture', 'reset'];

export function stepsForKind(kind: HarvestKind): HarvestStep[] {
  return kind === 'login' ? LOGIN_STEPS : ATC_STEPS;
}

export function describeHarvestStep(
  step: HarvestStep,
  ctx: { store: string; kind: HarvestKind; tcin?: string; email?: string; proxy?: string }
): string {
  const host = ctx.proxy ? String(ctx.proxy).split('@').pop() || ctx.proxy : 'local';
  switch (step) {
    case 'proxy':
      return `Bind ISP · ${host}`;
    case 'home':
      return `Open ${ctx.store} home (headed Chrome)`;
    case 'pdp':
      return `Random PDP ${ctx.tcin || ''} · generate Shape`;
    case 'atc':
      return `ATC / Ship it · cookie bind`;
    case 'account':
      return `Open login (not newsletter)`;
    case 'fake_email':
      return `Fake email ${ctx.email || ''} · trigger Shape login`;
    case 'capture':
      return ctx.kind === 'login' ? 'Bank LOGIN cookies · drop session' : 'Bank ATC cookies · drop session';
    case 'reset':
      return 'Reset context · next cookie';
    case 'full':
      return 'Bank full · worker idle';
    default:
      return 'Idle';
  }
}

export function refractLaunchForModule(module?: string) {
  const store = harvestStoreFromModule(module);
  const pack = spoofPackForStore(store);
  const kind = harvestKindFromModule(module);
  const fp = getActiveProfileForStore(store);
  return {
    store,
    kind,
    module: storeToFpModule(store),
    headed: true,
    chrome: fp.label,
    tlsClient: fp.tlsClient,
    userAgent: pack.userAgent,
    extraHTTPHeaders: pack.extraHTTPHeaders,
    initScript: pack.initScript,
    playwright: pack.playwright,
    homeUrl: harvestHomeUrl(store),
    loginUrl: harvestLoginUrl(store),
    steps: stepsForKind(kind),
  };
}

export interface HarvestWorkerSpec {
  id: string;
  name: string;
  module: string;
  proxy?: string;
}

export function bankSlotForKind(kind: HarvestKind): 'targetShapeLogin' | 'targetShapeAtc' {
  return kind === 'login' ? 'targetShapeLogin' : 'targetShapeAtc';
}
