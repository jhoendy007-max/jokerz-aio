import test from 'node:test';
import assert from 'node:assert/strict';
import { stripSecrets, restoreSecrets, createBackup, parseBackupFile, backupData, applyBackup, undoImport, UNDO_KEY } from './backup.ts';

function mem() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

const profiles = [{ id: 'p1', name: 'Main', cardNumber: '4111111111111111', cvv: '123', expMonth: '01' }];
const settings = { discordWebhook: 'https://discord/x', capmonsterKey: 'K', theme: 'dark', accounts: { target: [{ email: 'a@b.c', pass: 'pw', totp: 'S' }] } };

test('stripSecrets removes cards, passwords, keys, webhooks', () => {
  const s = stripSecrets({ profiles, settings }) as any;
  assert.deepEqual(s.profiles[0], { id: 'p1', name: 'Main', expMonth: '01' });
  assert.equal(s.settings.theme, 'dark');
  assert.equal(s.settings.discordWebhook, undefined);
  assert.equal(s.settings.capmonsterKey, undefined);
  assert.deepEqual(s.settings.accounts.target[0], { email: 'a@b.c' });
});

test('restoreSecrets keeps current secrets when backup lacks them', () => {
  const incoming = stripSecrets(settings) as any;
  incoming.theme = 'light';
  const r = restoreSecrets(incoming, settings) as any;
  assert.equal(r.theme, 'light');
  assert.equal(r.capmonsterKey, 'K');
  assert.equal(r.accounts.target[0].pass, 'pw');
  const p = restoreSecrets(stripSecrets(profiles), profiles) as any;
  assert.equal(p[0].cardNumber, '4111111111111111');
});

test('safe backup roundtrip + undo', async () => {
  const s = mem();
  s.setItem('jokerz_aio_profiles', JSON.stringify(profiles));
  s.setItem('jokerz_aio_tasks', JSON.stringify([{ id: 't1' }]));
  const file = parseBackupFile(JSON.stringify(await createBackup({ mode: 'safe' }, s)));
  assert.ok(!JSON.stringify(file).includes('4111'));
  s.setItem('jokerz_aio_tasks', JSON.stringify([{ id: 't2' }]));
  applyBackup(await backupData(file), ['tasks', 'profiles'], s);
  assert.deepEqual(JSON.parse(s.getItem('jokerz_aio_tasks')!), [{ id: 't1' }]);
  assert.equal(JSON.parse(s.getItem('jokerz_aio_profiles')!)[0].cvv, '123');
  undoImport(s);
  assert.deepEqual(JSON.parse(s.getItem('jokerz_aio_tasks')!), [{ id: 't2' }]);
  assert.equal(s.getItem(UNDO_KEY), null);
});

test('full backup is encrypted and needs the passphrase', async () => {
  const s = mem();
  s.setItem('jokerz_aio_profiles', JSON.stringify(profiles));
  await assert.rejects(createBackup({ mode: 'full', passphrase: 'short' }, s));
  const file = await createBackup({ mode: 'full', passphrase: 'correct horse' }, s);
  assert.ok(!JSON.stringify(file).includes('4111'));
  await assert.rejects(backupData(file, 'wrong pass'), /Wrong passphrase/);
  const d = (await backupData(file, 'correct horse')) as any;
  assert.equal(d.profiles[0].cardNumber, '4111111111111111');
});

test('parseBackupFile rejects foreign files', () => {
  assert.throws(() => parseBackupFile('{"hello":1}'), /Not a Jokerz/);
  assert.throws(() => parseBackupFile('nope'), /Not a JSON/);
});
