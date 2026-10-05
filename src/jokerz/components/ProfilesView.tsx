import { useEffect, useMemo, useState, memo } from 'react';
import { Plus, Trash2, CreditCard, FolderPlus, Users } from 'lucide-react';
import { initialProfiles } from '../data';
import { loadProfiles, saveProfiles } from '../lib/storage';
import { Profile } from '../types';

const DEFAULT_GROUPS = ['Personal', 'Target', 'Walmart', 'PKC', 'Drop'];

const emptyForm = (group: string): Omit<Profile, 'id'> => ({
  name: '',
  group: group || 'Personal',
  email: '',
  phone: '',
  firstName: '',
  lastName: '',
  address1: '',
  address2: '',
  city: '',
  state: '',
  zip: '',
  country: 'US',
  cardholder: '',
  cardNumber: '',
  cardEnd: '',
  exp: '',
  cvv: '',
});

function normalizeZip(raw: string): string {
  const s = String(raw || '').trim().toUpperCase();
  const m5 = s.match(/^(\d{5})(?:[-\s]?(\d{4}))?$/);
  if (m5) return m5[2] ? `${m5[1]}-${m5[2]}` : m5[1];
  return s.replace(/[^\d-]/g, '').slice(0, 10);
}

function isValidUsZip(raw: string): boolean {
  return /^\d{5}(-\d{4})?$/.test(normalizeZip(raw));
}

function isValidUsState(raw: string): boolean {
  return /^[A-Z]{2}$/.test(String(raw || '').trim().toUpperCase());
}

function ProfilesView() {
  const [profiles, setProfiles] = useState<Profile[]>(() => loadProfiles(initialProfiles));
  const [extraGroups, setExtraGroups] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('jokerz_aio_profile_groups');
      if (raw) return JSON.parse(raw) as string[];
    } catch {
      /* */
    }
    return [];
  });
  const [activeGroup, setActiveGroup] = useState<string>('All');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(() => emptyForm('Personal'));
  const [tab, setTab] = useState<'Shipping' | 'Payment'>('Shipping');
  const [formError, setFormError] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [showNewGroup, setShowNewGroup] = useState(false);

  useEffect(() => {
    saveProfiles(profiles);
  }, [profiles]);

  useEffect(() => {
    try {
      localStorage.setItem('jokerz_aio_profile_groups', JSON.stringify(extraGroups));
    } catch {
      /* */
    }
  }, [extraGroups]);

  const groups = useMemo(() => {
    const fromProfiles = profiles.map((p) => (p.group || 'Personal').trim()).filter(Boolean);
    const set = new Set<string>([...DEFAULT_GROUPS, ...extraGroups, ...fromProfiles]);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [profiles, extraGroups]);

  const counts = useMemo(() => {
    const m: Record<string, number> = { All: profiles.length };
    for (const g of groups) m[g] = 0;
    for (const p of profiles) {
      const g = (p.group || 'Personal').trim() || 'Personal';
      m[g] = (m[g] || 0) + 1;
    }
    return m;
  }, [profiles, groups]);

  const visible = useMemo(() => {
    if (activeGroup === 'All') return profiles;
    return profiles.filter((p) => (p.group || 'Personal') === activeGroup);
  }, [profiles, activeGroup]);

  const set = (k: keyof ReturnType<typeof emptyForm>, v: string) => {
    setFormError('');
    setForm((f) => ({ ...f, [k]: v }));
  };

  const addGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    if (!groups.includes(name) && !extraGroups.includes(name)) {
      setExtraGroups((g) => [...g, name]);
    }
    setActiveGroup(name);
    setNewGroupName('');
    setShowNewGroup(false);
  };

  const deleteGroup = (name: string) => {
    if (DEFAULT_GROUPS.includes(name)) {
      // keep default label but move profiles out
      if (!confirm(`Move all profiles out of "${name}" and clear the group label?`)) return;
      setProfiles((prev) =>
        prev.map((p) => ((p.group || '') === name ? { ...p, group: 'Personal' } : p))
      );
      return;
    }
    if (!confirm(`Delete group "${name}"? Profiles move to Personal.`)) return;
    setProfiles((prev) =>
      prev.map((p) => ((p.group || '') === name ? { ...p, group: 'Personal' } : p))
    );
    setExtraGroups((g) => g.filter((x) => x !== name));
    if (activeGroup === name) setActiveGroup('All');
  };

  const create = () => {
    if (!form.name.trim() || !form.email.trim()) {
      setFormError('Name and email are required');
      return;
    }
    const zip = normalizeZip(form.zip || '');
    if ((form.zip || '').trim() && !isValidUsZip(zip)) {
      setFormError('ZIP must be 5 digits (33703) or ZIP+4 (33703-1234)');
      setTab('Shipping');
      return;
    }
    const state = String(form.state || '').trim().toUpperCase();
    if (state && !isValidUsState(state)) {
      setFormError('State must be 2 letters (e.g. FL)');
      setTab('Shipping');
      return;
    }
    const digits = (form.cardNumber || '').replace(/\D/g, '');
    const cardEnd = form.cardEnd || (digits ? digits.slice(-4) : '0000');
    const group = (form.group || activeGroup !== 'All' ? form.group || activeGroup : 'Personal').trim();
    const profile: Profile = {
      id: Math.random().toString(36).slice(2, 10),
      ...form,
      group: group || 'Personal',
      zip: zip || form.zip,
      state: state || form.state,
      cardEnd,
    };
    setProfiles((p) => [...p, profile]);
    setFormError('');
    setForm(emptyForm(group || 'Personal'));
    setOpen(false);
    if (group) setActiveGroup(group);
  };

  const del = (id: string) => setProfiles((p) => p.filter((x) => x.id !== id));

  const inputClass =
    'w-full bg-[#0F0F0F] border border-gray-800 rounded-md px-3 py-2 text-[13px] text-white focus:outline-none focus:border-[#7B2CBF]';

  return (
    <div className="p-4 space-y-4 animate-in fade-in duration-200">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black italic uppercase tracking-tighter text-white">Profiles</h1>
          <p className="text-[10px] text-[#555] font-bold uppercase tracking-widest mt-1">
            Groups → profiles · shipping + payment for checkout
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowNewGroup((v) => !v)}
            className="flex items-center gap-2 px-4 py-2 border border-[#7B2CBF]/50 text-[#C77DFF] text-xs font-bold uppercase tracking-widest rounded-sm hover:bg-[#7B2CBF]/10"
          >
            <FolderPlus size={16} /> New Group
          </button>
          <button
            type="button"
            onClick={() => {
              setForm(emptyForm(activeGroup !== 'All' ? activeGroup : 'Personal'));
              setOpen(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-[#00FF41] hover:bg-[#00FF41] text-black text-xs font-bold uppercase tracking-widest rounded-sm"
          >
            <Plus size={16} /> New Profile
          </button>
        </div>
      </div>

      {showNewGroup && (
        <div className="flex gap-2 items-center max-w-md">
          <input
            className={inputClass}
            placeholder="Group name (e.g. Target Drop Fri)"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addGroup()}
          />
          <button
            type="button"
            onClick={addGroup}
            className="px-4 py-2 bg-[#7B2CBF] text-white text-xs font-bold uppercase tracking-widest rounded-sm shrink-0"
          >
            Add
          </button>
        </div>
      )}

      <div className="flex gap-6 min-h-[420px]">
        {/* Group sidebar */}
        <aside className="w-52 shrink-0 space-y-1">
          <button
            type="button"
            onClick={() => setActiveGroup('All')}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-sm text-left text-xs font-bold uppercase tracking-widest transition-colors ${
              activeGroup === 'All'
                ? 'bg-[#7B2CBF]/20 text-white border border-[#7B2CBF]/50'
                : 'text-[#888] hover:text-white border border-transparent'
            }`}
          >
            <span className="flex items-center gap-2">
              <Users size={14} /> All
            </span>
            <span className="text-[10px] text-[#555]">{counts.All || 0}</span>
          </button>
          {groups.map((g) => (
            <div key={g} className="group/g flex items-center gap-1">
              <button
                type="button"
                onClick={() => setActiveGroup(g)}
                className={`flex-1 flex items-center justify-between px-3 py-2.5 rounded-sm text-left text-xs font-bold uppercase tracking-widest transition-colors ${
                  activeGroup === g
                    ? 'bg-[#7B2CBF]/20 text-white border border-[#7B2CBF]/50'
                    : 'text-[#888] hover:text-white border border-transparent'
                }`}
              >
                <span className="truncate">{g}</span>
                <span className="text-[10px] text-[#555] ml-2">{counts[g] || 0}</span>
              </button>
              <button
                type="button"
                title="Delete group"
                onClick={() => deleteGroup(g)}
                className="p-1.5 text-[#555] hover:text-[#FF4B2B] opacity-0 group-hover/g:opacity-100"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </aside>

        {/* Profiles in group */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold uppercase tracking-widest text-white">
              {activeGroup === 'All' ? 'All profiles' : activeGroup}
              <span className="text-[#555] ml-2">{visible.length}</span>
            </h2>
          </div>

          {visible.length === 0 ? (
            <div className="border border-dashed border-[#1A1A1A] rounded-sm p-12 text-center">
              <p className="text-[#555] text-xs font-bold uppercase tracking-widest">
                No profiles in this group
              </p>
              <button
                type="button"
                onClick={() => {
                  setForm(emptyForm(activeGroup !== 'All' ? activeGroup : 'Personal'));
                  setOpen(true);
                }}
                className="mt-4 text-[#7B2CBF] text-xs font-bold uppercase tracking-widest hover:text-[#C77DFF]"
              >
                + Add profile here
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {visible.map((p) => (
                <div
                  key={p.id}
                  className="bg-[#0F0F0F] border border-[#1A1A1A] p-4 rounded-sm relative group"
                >
                  <button
                    type="button"
                    onClick={() => del(p.id)}
                    className="absolute top-3 right-3 text-[#555] hover:text-[#FF4B2B] opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 size={14} />
                  </button>
                  <div className="flex items-center gap-2 mb-1">
                    <CreditCard size={16} className="text-[#7B2CBF]" />
                    <h3 className="text-white font-bold uppercase text-sm truncate">{p.name}</h3>
                  </div>
                  <p className="text-[10px] text-[#7B2CBF] font-bold uppercase tracking-widest mb-1">
                    {p.group || 'Personal'}
                  </p>
                  <p className="text-[#555] text-[10px] font-bold uppercase tracking-widest">{p.email}</p>
                  <p className="text-[#888] text-xs mt-2">
                    {[p.firstName, p.lastName].filter(Boolean).join(' ') || '—'}
                  </p>
                  <p className="text-[#555] text-xs mt-1 truncate">
                    {[p.address1, p.city, p.state, p.zip].filter(Boolean).join(', ') || 'No address'}
                  </p>
                  <p className="text-white font-mono text-xs mt-3">•••• {p.cardEnd || '????'}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-[#15101c] border border-[#1A1A1A] rounded-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-white font-bold uppercase tracking-widest mb-4">Create Profile</h2>
            <div className="mb-4">
              <label className="text-[10px] font-bold uppercase text-[#555]">Group</label>
              <select
                className={inputClass + ' cursor-pointer'}
                value={form.group}
                onChange={(e) => set('group', e.target.value)}
              >
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2 mb-4">
              {(['Shipping', 'Payment'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-sm ${
                    tab === t ? 'bg-[#00FF41] text-black' : 'text-[#888] border border-gray-700'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            {tab === 'Shipping' && (
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] font-bold uppercase text-[#555]">Profile name</label>
                  <input className={inputClass} value={form.name} onChange={(e) => set('name', e.target.value)} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-bold uppercase text-[#555]">Email</label>
                    <input className={inputClass} value={form.email} onChange={(e) => set('email', e.target.value)} />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase text-[#555]">Phone</label>
                    <input className={inputClass} value={form.phone} onChange={(e) => set('phone', e.target.value)} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-bold uppercase text-[#555]">First name</label>
                    <input
                      className={inputClass}
                      value={form.firstName}
                      onChange={(e) => set('firstName', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase text-[#555]">Last name</label>
                    <input
                      className={inputClass}
                      value={form.lastName}
                      onChange={(e) => set('lastName', e.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase text-[#555]">Address</label>
                  <input
                    className={inputClass}
                    value={form.address1}
                    onChange={(e) => set('address1', e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase text-[#555]">Address 2</label>
                  <input
                    className={inputClass}
                    value={form.address2}
                    onChange={(e) => set('address2', e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-[10px] font-bold uppercase text-[#555]">City</label>
                    <input className={inputClass} value={form.city} onChange={(e) => set('city', e.target.value)} />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase text-[#555]">State</label>
                    <input
                      className={inputClass}
                      value={form.state}
                      maxLength={2}
                      placeholder="FL"
                      onChange={(e) => set('state', e.target.value.toUpperCase().slice(0, 2))}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase text-[#555]">ZIP</label>
                    <input
                      className={inputClass + (form.zip && !isValidUsZip(form.zip) ? ' border-red-500/60' : '')}
                      value={form.zip}
                      placeholder="33703"
                      inputMode="numeric"
                      maxLength={10}
                      onChange={(e) => set('zip', e.target.value.replace(/[^\d-]/g, '').slice(0, 10))}
                      onBlur={() => {
                        if ((form.zip || '').trim()) set('zip', normalizeZip(form.zip || ''));
                      }}
                    />
                  </div>
                </div>
                {formError && (
                  <p className="text-[11px] text-red-400 font-bold uppercase tracking-widest">{formError}</p>
                )}
              </div>
            )}

            {tab === 'Payment' && (
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] font-bold uppercase text-[#555]">Cardholder</label>
                  <input
                    className={inputClass}
                    value={form.cardholder}
                    onChange={(e) => set('cardholder', e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase text-[#555]">Card number</label>
                  <input
                    className={inputClass + ' font-mono'}
                    value={form.cardNumber}
                    onChange={(e) => set('cardNumber', e.target.value)}
                    placeholder="4111…"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-bold uppercase text-[#555]">Exp MM/YY</label>
                    <input className={inputClass} value={form.exp} onChange={(e) => set('exp', e.target.value)} />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase text-[#555]">CVV</label>
                    <input className={inputClass} value={form.cvv} onChange={(e) => set('cvv', e.target.value)} />
                  </div>
                </div>
                <p className="text-[10px] text-[#555]">Stored locally in browser localStorage only.</p>
              </div>
            )}

            <div className="flex justify-end gap-2 mt-6">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-4 py-2 text-xs font-bold uppercase text-[#888] border border-gray-700 rounded-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={create}
                className="px-4 py-2 text-xs font-bold uppercase bg-[#00FF41] text-black rounded-sm"
              >
                Save Profile
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(ProfilesView);
