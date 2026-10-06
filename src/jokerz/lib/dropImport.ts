/**
 * Import drops from a file or link: iCalendar (.ics), CSV or JSON.
 * CSV columns (header row, any order): store, title, product, date, time, remind, note
 *   date: YYYY-MM-DD (or ISO datetime) · time: HH:MM (24 h, local) · remind: minutes
 * JSON: [{ store, title, product, at | date+time, remindMin, note }]
 */
export interface ImportedDrop {
  store: 'Target' | 'Walmart' | 'Pokemon Center' | 'Bandai' | 'Other';
  title: string;
  product?: string;
  at: number;
  remindMin: number;
  note?: string;
}

export function normalizeStore(s: string, hint = ''): ImportedDrop['store'] {
  const v = `${s} ${hint}`.toLowerCase();
  if (v.includes('target')) return 'Target';
  if (v.includes('walmart')) return 'Walmart';
  if (v.includes('pokemon') || v.includes('pokémon') || v.includes('pkc')) return 'Pokemon Center';
  if (v.includes('bandai')) return 'Bandai';
  return 'Other';
}

function parseWhen(date: string, time = ''): number {
  const d = String(date || '').trim();
  if (!d) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [h, m] = (String(time || '').match(/^(\d{1,2}):(\d{2})/)?.slice(1) || ['0', '0']).map(Number);
    const [y, mo, da] = d.split('-').map(Number);
    return new Date(y, mo - 1, da, h, m).getTime();
  }
  const t = Date.parse(time ? `${d} ${time}` : d);
  return t;
}

function icsDate(v: string): number {
  // 20261010T100000Z | 20261010T100000 (local) | 20261010
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return NaN;
  const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m;
  return z ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) : new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
}

export function parseIcs(text: string, defaultRemind = 15): ImportedDrop[] {
  const unfolded = String(text).replace(/\r?\n[ \t]/g, '');
  const out: ImportedDrop[] = [];
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const get = (k: string) => body.match(new RegExp(`^${k}(?:;[^:\\r\\n]*)?:(.*)$`, 'mi'))?.[1]?.trim().replace(/\\n/g, '\n').replace(/\\,/g, ',') || '';
    const at = icsDate(get('DTSTART'));
    const title = get('SUMMARY');
    if (!Number.isFinite(at) || !title) continue;
    const desc = get('DESCRIPTION');
    const url = get('URL') || desc.match(/https?:\/\/\S+/)?.[0] || '';
    const alarm = body.match(/TRIGGER[^:]*:-?P(?:T(?:(\d+)H)?(?:(\d+)M)?)/i);
    const remind = alarm ? Number(alarm[1] || 0) * 60 + Number(alarm[2] || 0) : defaultRemind;
    out.push({ store: normalizeStore(get('LOCATION'), `${title} ${url}`), title: title.slice(0, 120), product: url || undefined, at, remindMin: remind, note: desc ? desc.slice(0, 200) : undefined });
  }
  return out;
}

export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseCsv(text: string, defaultRemind = 15): ImportedDrop[] {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iStore = idx('store', 'tienda');
  const iTitle = idx('title', 'name', 'titulo', 'título', 'nombre');
  const iProduct = idx('product', 'sku', 'url', 'tcin', 'producto');
  const iDate = idx('date', 'fecha', 'at', 'datetime');
  const iTime = idx('time', 'hora');
  const iRemind = idx('remind', 'reminder', 'remindmin', 'aviso');
  const iNote = idx('note', 'notes', 'nota');
  if (iTitle < 0 || iDate < 0) return [];
  const out: ImportedDrop[] = [];
  for (const l of lines.slice(1)) {
    const c = splitCsvLine(l);
    const at = parseWhen(c[iDate], iTime >= 0 ? c[iTime] : '');
    if (!Number.isFinite(at) || !c[iTitle]) continue;
    out.push({
      store: normalizeStore(iStore >= 0 ? c[iStore] : '', `${c[iTitle]} ${iProduct >= 0 ? c[iProduct] : ''}`),
      title: c[iTitle].slice(0, 120),
      product: iProduct >= 0 && c[iProduct] ? c[iProduct] : undefined,
      at,
      remindMin: iRemind >= 0 && c[iRemind] !== '' && Number.isFinite(Number(c[iRemind])) ? Number(c[iRemind]) : defaultRemind,
      note: iNote >= 0 && c[iNote] ? c[iNote] : undefined,
    });
  }
  return out;
}

export function parseJsonDrops(text: string, defaultRemind = 15): ImportedDrop[] {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    return [];
  }
  const arr = Array.isArray(v) ? v : Array.isArray(v?.drops) ? v.drops : [];
  return arr
    .map((d: any) => {
      const at = typeof d.at === 'number' ? d.at : parseWhen(d.at || d.date || '', d.time || '');
      if (!Number.isFinite(at) || !d.title) return null;
      return { store: normalizeStore(d.store || '', `${d.title} ${d.product || ''}`), title: String(d.title).slice(0, 120), product: d.product || d.url || d.sku || undefined, at, remindMin: Number.isFinite(Number(d.remindMin ?? d.remind)) ? Number(d.remindMin ?? d.remind) : defaultRemind, note: d.note || undefined } as ImportedDrop;
    })
    .filter(Boolean) as ImportedDrop[];
}

export function parseDropsText(text: string, defaultRemind = 15): { format: 'ics' | 'json' | 'csv' | 'unknown'; drops: ImportedDrop[] } {
  const t = String(text || '').trim();
  if (/BEGIN:VCALENDAR|BEGIN:VEVENT/.test(t)) return { format: 'ics', drops: parseIcs(t, defaultRemind) };
  if (/^[[{]/.test(t)) return { format: 'json', drops: parseJsonDrops(t, defaultRemind) };
  const csv = parseCsv(t, defaultRemind);
  return { format: csv.length ? 'csv' : 'unknown', drops: csv };
}

/** Same store + title + start minute → duplicate. */
export function dedupeDrops<T extends { store: string; title: string; at: number }>(existing: T[], incoming: ImportedDrop[]) {
  const key = (d: { store: string; title: string; at: number }) => `${d.store}|${d.title.toLowerCase().trim()}|${Math.round(d.at / 60000)}`;
  const seen = new Set(existing.map(key));
  return incoming.filter((d) => {
    const k = key(d);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Pure: which drops need their monitor tasks started now (autoStartMin before, once). */
export function dueAutoStarts<T extends { id: string; at: number; autoStartTaskIds?: string[]; autoStartMin?: number; autoStarted?: boolean }>(list: T[], now = Date.now()): T[] {
  return list.filter((d) => d.autoStartTaskIds?.length && !d.autoStarted && now >= d.at - (d.autoStartMin ?? 10) * 60_000 && now < d.at + 30 * 60_000);
}
