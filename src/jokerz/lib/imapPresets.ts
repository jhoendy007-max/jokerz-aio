/** IMAP presets — user only types email + app password. */
export type ImapPreset = {
  id: string;
  label: string;
  host: string;
  port: number;
  hint: string;
};

export const IMAP_PRESETS: Record<string, ImapPreset> = {
  gmail: {
    id: 'gmail',
    label: 'Gmail',
    host: 'imap.gmail.com',
    port: 993,
    hint: 'Google Account → Security → App passwords (2FA on)',
  },
  outlook: {
    id: 'outlook',
    label: 'Outlook / Hotmail',
    host: 'outlook.office365.com',
    port: 993,
    hint: 'Microsoft → Security → App password (or IMAP enabled)',
  },
  yahoo: {
    id: 'yahoo',
    label: 'Yahoo',
    host: 'imap.mail.yahoo.com',
    port: 993,
    hint: 'Yahoo Account → Security → Generate app password',
  },
  icloud: {
    id: 'icloud',
    label: 'iCloud',
    host: 'imap.mail.me.com',
    port: 993,
    hint: 'appleid.apple.com → App-Specific Password',
  },
};

const DOMAIN: Record<string, string> = {
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'live.com': 'outlook',
  'msn.com': 'outlook',
  'office365.com': 'outlook',
  'yahoo.com': 'yahoo',
  'ymail.com': 'yahoo',
  'rocketmail.com': 'yahoo',
  'icloud.com': 'icloud',
  'me.com': 'icloud',
  'mac.com': 'icloud',
};

export function domainOf(email: string) {
  const m = String(email || '')
    .toLowerCase()
    .trim()
    .match(/@([^@\s]+)$/);
  return m ? m[1] : '';
}

export function resolveImapPreset(email: string): ImapPreset | null {
  const d = domainOf(email);
  if (!d) return null;
  const id = DOMAIN[d];
  if (id) return IMAP_PRESETS[id];
  if (d.endsWith('.outlook.com')) return IMAP_PRESETS.outlook;
  return null;
}
