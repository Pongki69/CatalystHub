import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import RoleBadge from './RoleBadge';
import { ArrowRight, BriefcaseBusiness, Building2, CalendarDays, Check, ExternalLink, Globe2, Image as ImageIcon, Link as LinkIcon, Mail, MapPin, Star, Upload, UserRound, X } from 'lucide-react';
import { api, errorMessage } from './api';
import { useAuth } from './AuthContext';
import type { User } from './types';
import ImageCropDialog from './ImageCropDialog';
import { createPortal } from 'react-dom';

function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="mb-7"><div className="text-[10px] font-extrabold tracking-[.16em] text-leaf">{eyebrow}</div><h1 className="mt-2 text-3xl font-extrabold tracking-tight">{title}</h1><p className="mt-2 text-sm text-muted">{description}</p></div>;
}
function notifyProfileSaved(message: string) { window.dispatchEvent(new CustomEvent('catalysthub:toast', { detail: { message } })); }
function LoadingProfile() { return <div role="status" className="animate-pulse rounded-2xl border border-line bg-white p-8 text-sm text-muted">Loading profile…</div>; }

export function ProfileEditor() {
  const { user, updateUser } = useAuth();
  const [draft, setDraft] = useState({ name: '', email: '', company: '', bio: '', jobTitle: '', location: '', website: '', currentPassword: '', newPassword: '', confirmPassword: '' });
  const [emailPassword, setEmailPassword] = useState(''); const [savingEmail, setSavingEmail] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailError, setEmailError] = useState(''); const [emailNotice, setEmailNotice] = useState('');
  const [avatar, setAvatar] = useState(''); const [cover, setCover] = useState('');
  const [avatarPending, setAvatarPending] = useState(false); const [coverPending, setCoverPending] = useState(false);
  const [sourceChoice, setSourceChoice] = useState<'avatar' | 'cover' | null>(null); const [linkMode, setLinkMode] = useState(false); const [linkText, setLinkText] = useState('');
  const [crop, setCrop] = useState<{ source: string; kind: 'avatar' | 'cover' } | null>(null);
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false);
  const [error, setError] = useState(''); const [, setNotice] = useState('');
  const [profileError, setProfileError] = useState(''); const [passwordError, setPasswordError] = useState('');
  const submitLock = useRef(false);
  const appearanceLock = useRef(false);
  const emailLock = useRef(false);
  const avatarInput = useRef<HTMLInputElement>(null); const coverInput = useRef<HTMLInputElement>(null);
  const bioInput = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { api.get('/profile').then(({ data }) => {
    const profile = data.data.user;
    setDraft(current => ({ ...current, name: profile.name, email: profile.email, company: profile.company || '', bio: profile.bio || '', jobTitle: profile.jobTitle || '', location: profile.location || '', website: profile.website || '' }));
    setAvatar(profile.avatarUrl || ''); setCover(profile.coverUrl || '');
  }).catch(e => setError(errorMessage(e))).finally(() => setLoading(false)); }, []);

  useEffect(() => { const field = bioInput.current; if (!field) return; field.style.height = 'auto'; field.style.height = `${Math.min(field.scrollHeight, 180)}px`; field.style.overflowY = field.scrollHeight > 180 ? 'auto' : 'hidden'; }, [draft.bio, loading]);

  async function saveAppearance(kind: 'avatar' | 'cover', image: string) {
    if (appearanceLock.current) return;
    appearanceLock.current = true; setSaving(true); setError(''); setNotice(`Saving ${kind === 'avatar' ? 'profile photo' : 'cover'}…`);
    try {
      const field = kind === 'avatar' ? 'avatarUrl' : 'coverUrl';
      const { data } = await api.patch('/profile/appearance', { [field]: image });
      updateUser({ ...user, ...data.data.user });
      setAvatar(data.data.user.avatarUrl || ''); setCover(data.data.user.coverUrl || '');
      if (kind === 'avatar') setAvatarPending(false); else setCoverPending(false);
      setNotice(''); notifyProfileSaved(`${kind === 'avatar' ? 'Profile photo' : 'Cover'} saved.`);
    } catch (e) { setError(errorMessage(e)); setNotice(''); if (kind === 'avatar') setAvatarPending(true); else setCoverPending(true); }
    finally { appearanceLock.current = false; setSaving(false); }
  }

  function chooseImage(kind: 'avatar' | 'cover', file?: File) {
    if (!file) return;
    setError('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setError('Choose a JPG, PNG, or WebP image.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('Choose an image smaller than 10 MB to edit.'); return; }
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === 'string') { setSourceChoice(null); setCrop({ source: reader.result, kind }); } else setError('This image could not be opened.'); };
    reader.onerror = () => setError('This image could not be opened.'); reader.onabort = () => setError('Image loading was cancelled.'); reader.readAsDataURL(file);
  }

  async function loadImageLink(kind: 'avatar' | 'cover', rawUrl: string) {
    const value = rawUrl.trim(); if (!value) return;
    setError(''); setNotice('');
    let url: URL;
    try { url = new URL(value); } catch { setError('Paste a direct link to a JPG, PNG, or WebP image.'); return; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') { setError('Image links must start with http:// or https://.'); return; }
    try {
      const response = await fetch(url.href, { mode: 'cors', credentials: 'omit' });
      if (!response.ok) throw new Error('The image link could not be opened.');
      const blob = await response.blob();
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) throw new Error('This link does not point directly to a JPG, PNG, or WebP image.');
      if (blob.size > 10 * 1024 * 1024) throw new Error('Choose an image smaller than 10 MB to edit.');
      const reader = new FileReader();
      reader.onload = () => { if (typeof reader.result === 'string') { setSourceChoice(null); setCrop({ source: reader.result, kind }); } };
      reader.onerror = () => setError('This image could not be opened.');
      reader.readAsDataURL(blob);
      setLinkText('');
    } catch (cause) {
      setError(cause instanceof TypeError ? 'This image host blocks browser access. Try a direct image link from a host that allows sharing, or upload the image file.' : cause instanceof Error ? cause.message : 'This image link could not be loaded.');
    }
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault(); if (submitLock.current) return; submitLock.current = true; setProfileError(''); setNotice(''); setSaving(true);
    try {
      const expected = { name: draft.name.trim(), company: draft.company.trim(), bio: draft.bio.trim(), jobTitle: draft.jobTitle.trim(), location: draft.location.trim(), website: draft.website.trim() };
      await api.patch('/profile', { ...expected, confirmPassword: '' });
      // Confirm with the same read endpoint used by the profile view before
      // showing success. This catches a backend/database target mismatch.
      const { data } = await api.get('/profile');
      const saved = data.data.user as User;
      const persisted = { name: saved.name || '', company: saved.company || '', bio: saved.bio || '', jobTitle: saved.jobTitle || '', location: saved.location || '', website: saved.website || '' };
      const fieldLabels: Record<keyof typeof expected, string> = { name: 'display name', company: 'organization', bio: 'about you', jobTitle: 'job title', location: 'location', website: 'website' };
      const mismatched = (Object.keys(expected) as Array<keyof typeof expected>).filter(key => expected[key] !== persisted[key]);
      if (mismatched.length) {
        throw new Error(`The server saved the request but returned older values for: ${mismatched.map(key => fieldLabels[key]).join(', ')}. Your changes were not confirmed. Please retry; if this continues, check that the API is connected to the correct database.`);
      }
      updateUser({ ...user, ...saved });
      setDraft(current => ({ ...current, name: saved.name, company: saved.company || '', bio: saved.bio || '', jobTitle: saved.jobTitle || '', location: saved.location || '', website: saved.website || '' }));
      setNotice(''); notifyProfileSaved('Profile details saved.');
    } catch (e) { setProfileError(errorMessage(e)); } finally { submitLock.current = false; setSaving(false); }
  }

  async function updatePassword() {
    if (submitLock.current || !draft.newPassword) return;
    if (draft.newPassword !== draft.confirmPassword) { setPasswordError('The new password and confirmation do not match.'); return; }
    if (!draft.currentPassword) { setPasswordError('Enter your current password to change it.'); return; }
    submitLock.current = true; setPasswordError(''); setNotice(''); setSaving(true);
    try {
      const { data } = await api.patch('/profile', { name: draft.name, company: draft.company, bio: draft.bio, jobTitle: draft.jobTitle, location: draft.location, website: draft.website, currentPassword: draft.currentPassword, newPassword: draft.newPassword, confirmPassword: draft.confirmPassword });
      updateUser({ ...user, ...data.data.user });
      setDraft(current => ({ ...current, currentPassword: '', newPassword: '', confirmPassword: '' }));
      setNotice(''); notifyProfileSaved('Password updated.');
    } catch (e) { setPasswordError(errorMessage(e)); } finally { submitLock.current = false; setSaving(false); }
  }

  async function updateEmail(event: FormEvent) {
    event.preventDefault(); if (emailLock.current) return; emailLock.current = true; setEmailError(''); setEmailNotice(''); setSavingEmail(true);
    try {
      const { data } = await api.patch('/profile/email', { email: newEmail, currentPassword: emailPassword });
      updateUser({ ...user, ...data.data.user });
      setDraft(current => ({ ...current, email: data.data.user.email })); setNewEmail(''); setEmailPassword(''); setEmailNotice(''); notifyProfileSaved('Your sign-in email has been updated.');
    } catch (e) { setEmailError(errorMessage(e)); } finally { emailLock.current = false; setSavingEmail(false); }
  }


  if (loading) return <><PageHeading eyebrow="ACCOUNT SETTINGS" title="My profile" description="Keep your account details current so your agency team knows who they’re working with."/><LoadingProfile/></>;
  const initials = (draft.name || user?.name || 'You').split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase();
  return <><PageHeading eyebrow="ACCOUNT SETTINGS" title="My profile" description="Keep your account details current so your agency team knows who they’re working with."/>
    <div className="w-full overflow-hidden rounded-2xl border border-line bg-white shadow-card">
      <section aria-label="Profile preview" className="border-b border-line">
        <div className="relative h-36 bg-gradient-to-br from-[#123a2b] via-[#1e7451] to-[#74bd8d] bg-cover bg-center sm:h-44" style={cover ? { backgroundImage: `url(${cover})` } : {}}>
          <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-black/10"/>
          <button type="button" onClick={() => { setError(''); setSourceChoice('cover'); setLinkMode(false); setLinkText(''); }} className="absolute right-4 top-4 inline-flex items-center gap-2 rounded-xl border border-white/25 bg-black/45 px-3.5 py-2.5 text-xs font-bold text-white shadow-sm backdrop-blur transition hover:bg-black/65"><ImageIcon size={14}/>Change cover</button>
        </div>
        <div className="flex flex-col gap-4 px-5 pb-5 sm:flex-row sm:items-end sm:gap-5 sm:px-8">
          <div className="relative -mt-12 h-24 w-24 shrink-0 sm:-mt-14 sm:h-28 sm:w-28"><div className="grid h-24 w-24 place-items-center overflow-hidden rounded-[1.35rem] border-[5px] border-white bg-[#e2f3e9] text-2xl font-extrabold text-leaf shadow-lg sm:h-28 sm:w-28">{avatar ? <img src={avatar} alt="Profile photo preview" className="h-full w-full object-cover"/> : initials}</div>
            <button type="button" onClick={() => { setError(''); setSourceChoice('avatar'); setLinkMode(false); setLinkText(''); }} aria-label="Change profile photo" title="Change profile photo" className="absolute -bottom-1 -right-2 grid h-10 w-10 place-items-center rounded-full border-[3px] border-white bg-leaf text-white shadow-md transition hover:scale-105"><ImageIcon size={16}/></button>
          </div>
          <input ref={avatarInput} type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" className="sr-only" onChange={event => { chooseImage('avatar', event.target.files?.[0]); event.currentTarget.value = ''; }}/><input ref={coverInput} type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" className="sr-only" onChange={event => { chooseImage('cover', event.target.files?.[0]); event.currentTarget.value = ''; }}/>
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-extrabold tracking-tight">{draft.name || 'Your name'}</h2><RoleBadge role={user?.role}/></div><div className="mt-1 break-all text-sm text-muted">{user?.email || draft.email}</div><p className="mt-2 text-xs text-muted">Your profile photo and cover help people recognize you across CatalystHub.</p></div>
          <Link to={`/profile/${user?.id}`} className="inline-flex shrink-0 items-center gap-1 self-start rounded-lg px-2 py-2 text-sm font-semibold text-[#16794f] transition hover:bg-[#f1f7f2] hover:underline sm:self-end">View my profile <ArrowRight size={15}/></Link>
        </div>
        {(avatarPending || coverPending) && <div className="mx-5 mb-5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 sm:mx-8"><p>Your image preview is not saved yet.</p><button type="button" onClick={() => void saveAppearance(avatarPending ? 'avatar' : 'cover', avatarPending ? avatar : cover)} className="mt-2 font-bold underline underline-offset-2">Try saving again</button></div>}
      </section>
      <section className="p-5 sm:p-8"><div className="mb-6 border-b border-line pb-5"><div className="text-[10px] font-extrabold tracking-[.16em] text-leaf">PERSONAL DETAILS</div><h2 className="mt-2 text-xl font-extrabold">Profile information</h2><p className="mt-1 text-xs text-muted">Update your public profile, sign-in email, and password from one place.</p></div>
        <form onSubmit={updateEmail} className="mb-7 rounded-2xl border border-line bg-[#f8faf8] p-4 sm:p-5"><div className="mb-5 flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e7f4eb] text-[#16794f]"><Mail size={19}/></span><div><div className="mb-1 text-[10px] font-extrabold uppercase tracking-[.14em] text-[#557063]">Sign-in email · save separately</div><h3 className="font-extrabold">Change sign-in email</h3><p className="mt-1 text-xs leading-5 text-muted">This only changes the email you use to sign in. Your profile details stay as they are.</p></div></div><div className="mb-4 rounded-xl border border-line bg-white px-4 py-3"><div className="text-[10px] font-extrabold uppercase tracking-wider text-[#557063]">Current sign-in email</div><div className="mt-1 break-all text-sm font-bold text-ink">{user?.email || draft.email}</div></div><div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm font-semibold">New email address<input required type="email" className="field mt-2 !border-[#c7d8cc] focus:!border-[#238554]" placeholder="name@example.com" value={newEmail} onChange={event => { setNewEmail(event.target.value); setEmailError(''); setEmailNotice(''); }}/></label><label className="block text-sm font-semibold">Confirm with current password<input required type="password" autoComplete="current-password" className="field mt-2 !border-[#c7d8cc] focus:!border-[#238554]" value={emailPassword} onChange={event => { setEmailPassword(event.target.value); setEmailError(''); setEmailNotice(''); }}/></label></div><p className="mt-3 text-xs text-[#52675b]">{!newEmail.trim() ? 'Enter the new address you want to use, then confirm with your current password.' : newEmail.trim().toLowerCase()===user?.email?.toLowerCase() ? 'This is already your current email. Enter a different address to make a change.' : !emailPassword ? 'Enter your current password to enable the update.' : 'Only this email and your current password are used for this update.'}</p>{emailError && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{emailError}</p>}{emailNotice && <p role="status" className="mt-3 rounded-lg border border-[#b9dfc7] bg-white p-3 text-sm font-semibold text-[#205b3d]">{emailNotice}</p>}<div className="mt-5 flex justify-end"><button disabled={savingEmail || !newEmail.trim() || newEmail.trim().toLowerCase()===user?.email?.toLowerCase() || !emailPassword} className="btn btn-primary min-w-40 justify-center text-sm disabled:cursor-not-allowed disabled:opacity-50">{savingEmail?'Updating…':'Update sign-in email'}<Check size={15}/></button></div></form>
        <form onSubmit={saveProfile} className="space-y-5"><label className="block text-sm font-semibold">Display name<input required minLength={2} maxLength={80} className="field mt-2" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label><div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm font-semibold">Job title <span className="font-normal text-muted">(optional)</span><input maxLength={100} className="field mt-2" placeholder="e.g. Project manager" value={draft.jobTitle} onChange={event => setDraft({ ...draft, jobTitle: event.target.value })}/></label><label className="block text-sm font-semibold">Company or organization <span className="font-normal text-muted">(optional)</span><input maxLength={120} className="field mt-2" placeholder="Your organization" value={draft.company} onChange={event => setDraft({ ...draft, company: event.target.value })}/></label><label className="block text-sm font-semibold">Location <span className="font-normal text-muted">(optional)</span><input maxLength={120} className="field mt-2" placeholder="City, country" value={draft.location} onChange={event => setDraft({ ...draft, location: event.target.value })}/></label><label className="block text-sm font-semibold">Website or portfolio <span className="font-normal text-muted">(optional)</span><input type="url" maxLength={200} className="field mt-2" placeholder="https://example.com" value={draft.website} onChange={event => setDraft({ ...draft, website: event.target.value })}/></label></div><label className="block text-sm font-semibold">About you <span className="font-normal text-muted">(optional)</span><textarea ref={bioInput} maxLength={500} rows={2} className="field mt-2 max-h-[180px] min-h-[72px] resize-none overflow-y-hidden !text-sm" placeholder="Share your experience, what you do, or how you like to work…" value={draft.bio} onChange={event => setDraft({ ...draft, bio: event.target.value })}/><span className="mt-1 block text-right text-xs font-normal text-muted">{draft.bio.length}/500 characters</span></label>
          {profileError&&<p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">Could not save profile details: {profileError}</p>}<div className="flex justify-end border-t border-line pt-4"><button type="submit" disabled={saving} className="btn btn-primary disabled:opacity-60">{saving ? 'Saving profile…' : 'Save profile details'}<Check size={15}/></button></div><div className="rounded-xl border border-line bg-[#fbfcfb] p-4 sm:p-5"><h3 className="font-extrabold">Password & security</h3><p className="mt-1 text-xs text-muted">Leave all password fields blank to keep your current password. Enter your current password to change it.</p><div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"><label className="block text-sm font-semibold">Current password<input type="password" autoComplete="current-password" required={Boolean(draft.newPassword)} className="field mt-2" value={draft.currentPassword} onChange={event => setDraft({ ...draft, currentPassword: event.target.value })}/></label><label className="block text-sm font-semibold">New password<input type="password" minLength={8} autoComplete="new-password" className="field mt-2" placeholder="At least 8 characters" value={draft.newPassword} onChange={event => setDraft({ ...draft, newPassword: event.target.value })}/></label><label className="block text-sm font-semibold">Confirm new password<input type="password" minLength={draft.newPassword ? 8 : undefined} required={Boolean(draft.newPassword)} autoComplete="new-password" className="field mt-2" placeholder="Re-enter new password" value={draft.confirmPassword} onChange={event => setDraft({ ...draft, confirmPassword: event.target.value })}/></label></div>{draft.confirmPassword && <p role="status" aria-live="polite" className={`mt-3 text-xs font-semibold ${draft.newPassword === draft.confirmPassword ? 'text-[#28734f]' : 'text-[#b42318]'}`}>{draft.newPassword === draft.confirmPassword ? '✓ New passwords match' : 'New passwords do not match'}</p>}{passwordError&&<p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">Could not update password: {passwordError}</p>}</div>
          <div className="border-t border-line pt-4"><div className="mb-3 text-[10px] font-extrabold uppercase tracking-[.14em] text-[#557063]">Password update</div><p className="mb-3 text-xs text-muted">To change your password, enter all three password fields above and choose Update password.</p><div className="flex justify-end"><button type="button" onClick={() => void updatePassword()} disabled={saving || !draft.newPassword} className="btn btn-primary disabled:opacity-50">{saving ? 'Updating password…' : 'Update password'}<Check size={15}/></button></div></div>
        </form>
      </section>
    </div>
    {sourceChoice && createPortal(<div className="fixed inset-0 z-[150] grid min-h-dvh place-items-center overflow-y-auto bg-[#07130e]/70 p-4 backdrop-blur-[2px]" onMouseDown={event => { if (event.target === event.currentTarget) setSourceChoice(null); }}><section role="dialog" aria-modal="true" aria-labelledby="image-source-title" className="my-auto w-full max-w-2xl overflow-hidden rounded-3xl border border-line bg-white shadow-2xl">
      <div className="flex items-start gap-4 border-b border-line px-6 py-5 sm:px-7"><div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#e7f4eb] text-leaf"><ImageIcon size={22}/></div><div className="min-w-0 flex-1"><div className="text-[10px] font-extrabold tracking-[.15em] text-leaf">PROFILE {sourceChoice === 'avatar' ? 'PHOTO' : 'COVER'}</div><h2 id="image-source-title" className="mt-1 text-xl font-extrabold tracking-tight">Add a {sourceChoice === 'avatar' ? 'profile photo' : 'cover photo'}</h2><p className="mt-1 text-sm text-muted">Choose where to get your image. You can adjust the crop before saving.</p></div><button type="button" aria-label="Close image source dialog" onClick={() => setSourceChoice(null)} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-muted transition hover:bg-[#f1f6f2] hover:text-ink"><X size={18}/></button></div>
      <div className="p-6 sm:p-7"><div className="grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => { (sourceChoice === 'avatar' ? avatarInput : coverInput).current?.click(); }} className="group rounded-2xl border border-line bg-white p-5 text-left transition hover:border-[#68ae87] hover:bg-[#f7fbf8] focus:outline-none focus:ring-2 focus:ring-leaf/30"><span className="grid h-11 w-11 place-items-center rounded-xl bg-[#e7f4eb] text-leaf transition group-hover:bg-[#d9efe1]"><Upload size={19}/></span><span className="mt-4 block text-sm font-extrabold">Choose from my device</span><span className="mt-1 block text-xs leading-5 text-muted">Select a JPG, PNG, or WebP image from your files.</span></button><button type="button" onClick={() => { setLinkMode(true); setError(''); }} className="group rounded-2xl border border-line bg-white p-5 text-left transition hover:border-[#68ae87] hover:bg-[#f7fbf8] focus:outline-none focus:ring-2 focus:ring-leaf/30"><span className="grid h-11 w-11 place-items-center rounded-xl bg-[#eef3ff] text-[#5576c8] transition group-hover:bg-[#e4ebff]"><LinkIcon size={19}/></span><span className="mt-4 block text-sm font-extrabold">Use an image link</span><span className="mt-1 block text-xs leading-5 text-muted">Paste a direct image URL, then fine-tune the crop.</span></button></div>
        {linkMode && <form className="mt-5 rounded-2xl border border-[#dce9df] bg-[#f7faf8] p-4 sm:p-5" onSubmit={event => { event.preventDefault(); void loadImageLink(sourceChoice, linkText); }}><label className="block text-sm font-bold">Image link<span className="mt-1 block text-xs font-normal text-muted">Paste a direct link to a JPG, PNG, or WebP image.</span><input autoFocus type="url" className="field mt-3 !text-sm" placeholder="https://example.com/image.jpg" value={linkText} onChange={event => setLinkText(event.target.value)} onPaste={event => { const pasted = event.clipboardData.getData('text').trim(); if (pasted) { event.preventDefault(); setLinkText(pasted); void loadImageLink(sourceChoice, pasted); } }}/></label>{error && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-xs leading-5 text-red-700">{error}</p>}<button type="submit" disabled={!linkText.trim()} className="btn btn-primary mt-4 w-full disabled:cursor-not-allowed disabled:opacity-50">Continue to crop<Check size={15}/></button></form>}
        <div className="mt-6 flex justify-end border-t border-line pt-4"><button type="button" onClick={() => setSourceChoice(null)} className="btn btn-subtle text-sm">Cancel</button></div>
      </div></section></div>, document.body)}
    {crop && <ImageCropDialog source={crop.source} kind={crop.kind} onCancel={() => setCrop(null)} onApply={image => { const kind = crop.kind; if (kind === 'avatar') setAvatar(image); else setCover(image); setCrop(null); void saveAppearance(kind, image); }}/ >}
  </>;
}

export function PublicProfilePage() {
  const { id = '' } = useParams(); const { user } = useAuth();
  const [profile, setProfile] = useState<User | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  type CompletedWork = { _id: string; ticket?: { _id: string; title: string; category: string; status: string; clientId?: { name: string; role?: string } }; ticketTitle?: string; ticketCategory?: string; clientName?: string; confirmedAt: string; agentRating?: number | null };
  const [completedWork, setCompletedWork] = useState<CompletedWork[]>([]);
  const [completionSearch, setCompletionSearch] = useState('');
  const [completionFrom, setCompletionFrom] = useState('');
  const [completionTo, setCompletionTo] = useState('');
  const [completionLoading, setCompletionLoading] = useState(false);
  const [completionError, setCompletionError] = useState('');
  const [completionHasMore, setCompletionHasMore] = useState(false);
  const [completionNextSkip, setCompletionNextSkip] = useState(0);
  const completionLoadLock = useRef(false);
  const completionQueryVersion = useRef(0);
  const ownProfile = user?.id === profile?.id;
  const ownAgentProfile = Boolean(ownProfile && profile?.role === 'agent');
  useEffect(() => { let active = true; setLoading(true); setError(''); api.get(id ? `/profile/${id}` : '/profile').then(({ data }) => { if (active) setProfile(data.data.user); }).catch(e => { if (active) setError(errorMessage(e)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [id]);
  useEffect(() => {
    if (!ownAgentProfile) return;
    let active = true;
    completionQueryVersion.current += 1;
    setCompletionLoading(true);
    setCompletionError('');
    const timer = window.setTimeout(async () => {
      try {
        const { data } = await api.get('/profile/completions', { params: {
          search: completionSearch.trim() || undefined,
          from: completionFrom || undefined,
          to: completionTo || undefined,
          limit: 25,
          skip: 0,
        } });
        if (!active) return;
        setCompletedWork(data.data.completions);
        setCompletionNextSkip(data.data.nextSkip);
        setCompletionHasMore(data.data.hasMore);
      } catch (requestError) {
        if (active) {
          setCompletedWork([]);
          setCompletionError(errorMessage(requestError));
        }
      } finally {
        if (active) setCompletionLoading(false);
      }
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [ownAgentProfile, completionSearch, completionFrom, completionTo]);

  async function loadMoreCompletions() {
    if (completionLoadLock.current || !completionHasMore) return;
    completionLoadLock.current = true;
    const queryVersion = completionQueryVersion.current;
    setCompletionLoading(true);
    setCompletionError('');
    try {
      const { data } = await api.get('/profile/completions', { params: {
        search: completionSearch.trim() || undefined,
        from: completionFrom || undefined,
        to: completionTo || undefined,
        limit: 25,
        skip: completionNextSkip,
      } });
      if (queryVersion !== completionQueryVersion.current) return;
      setCompletedWork(current => [...current, ...data.data.completions]);
      setCompletionNextSkip(data.data.nextSkip);
      setCompletionHasMore(data.data.hasMore);
    } catch (requestError) {
      if (queryVersion === completionQueryVersion.current) setCompletionError(errorMessage(requestError));
    } finally {
      completionLoadLock.current = false;
      if (queryVersion === completionQueryVersion.current) setCompletionLoading(false);
    }
  }
  if (loading) return <><PageHeading eyebrow="COMMUNITY" title="Profile" description="A CatalystHub member profile."/><LoadingProfile/></>;
  if (error || !profile) return <><PageHeading eyebrow="COMMUNITY" title="Profile unavailable" description={error || 'This profile could not be found.'}/><div role="alert" className="rounded-2xl border border-line bg-white p-8 text-center text-sm text-muted">{error || 'This profile could not be found.'}<div><Link to="/" className="btn btn-primary mt-5">Back to workspace</Link></div></div></>;
  const initials = profile.name.split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase();
  const details = [
    profile.jobTitle && { icon: BriefcaseBusiness, label: 'Role', value: profile.jobTitle },
    profile.company && { icon: Building2, label: 'Organization', value: profile.company },
    profile.location && { icon: MapPin, label: 'Location', value: profile.location },
    profile.createdAt && { icon: CalendarDays, label: 'Member since', value: new Date(profile.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) },
  ].filter((item): item is { icon: typeof BriefcaseBusiness; label: string; value: string } => Boolean(item));
  return <><PageHeading eyebrow="COMMUNITY PROFILE" title="Member profile" description="Get to know the people working together in CatalystHub."/><div className="w-full overflow-hidden rounded-[1.75rem] border border-line bg-white shadow-card">
    <div className="relative h-44 overflow-hidden bg-gradient-to-br from-[#123a2b] via-[#1e7451] to-[#74bd8d] bg-cover bg-center sm:h-56" style={profile.coverUrl ? { backgroundImage: `url(${profile.coverUrl})` } : {}}><div className="absolute inset-0 bg-gradient-to-t from-[#0d241a]/35 via-transparent to-black/10"/><div className="absolute right-5 top-5 inline-flex items-center gap-2 rounded-full border border-white/20 bg-black/20 px-3 py-1.5 text-[11px] font-semibold capitalize text-white backdrop-blur"><UserRound size={13}/>{profile.role} profile</div></div>
    <div className="px-5 pb-6 sm:px-9 sm:pb-9"><div className="relative -mt-12 flex flex-col gap-4 sm:-mt-14 sm:flex-row sm:items-end"><div className="grid h-28 w-28 shrink-0 place-items-center overflow-hidden rounded-[1.6rem] border-[5px] border-white bg-[#e2f3e9] text-3xl font-extrabold text-leaf shadow-lg sm:h-32 sm:w-32">{profile.avatarUrl ? <img src={profile.avatarUrl} alt={`${profile.name}'s profile photo`} className="h-full w-full object-cover"/> : initials}</div>
      <div className="min-w-0 flex-1 pb-1"><RoleBadge role={profile.role}/><h2 className="mt-2 break-words text-2xl font-extrabold tracking-tight sm:text-3xl">{profile.name}</h2>{profile.jobTitle && <p className="mt-1 text-sm font-medium text-[#52635a]">{profile.jobTitle}{profile.company ? <span className="font-normal text-muted"> · {profile.company}</span> : null}</p>}</div>{ownProfile && <Link to="/profile/edit" className="btn btn-subtle shrink-0 text-sm">Edit profile</Link>}</div>
      {profile.role==='agent'&&<section className="mt-6 grid gap-3 sm:grid-cols-2"><div className="rounded-2xl border border-line bg-[#f5faf6] p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-muted">Client confirmations</div><div className="mt-1 text-2xl font-extrabold">{profile.completedCount||0}</div><div className="mt-1 text-xs text-muted">Historical client-confirmed milestones</div></div><div className="rounded-2xl border border-line bg-[#fffaf0] p-4"><div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-muted">Client rating {profile.averageRating&&<Star size={12} className="fill-[#c58b23] text-[#c58b23]"/>}</div><div className="mt-1 text-2xl font-extrabold">{profile.averageRating?`${profile.averageRating}/5`:'Not rated yet'}</div><div className="mt-1 text-xs text-muted">{profile.ratingCount||0} client reviews</div></div></section>}
      {ownAgentProfile && <section className="mt-6 rounded-2xl border border-line bg-white p-5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[10px] font-extrabold tracking-[.15em] text-leaf">YOUR TRACK RECORD</div>
            <h3 className="mt-1 text-lg font-extrabold">Completed client requests</h3>
            <p className="mt-1 text-xs text-muted">Each client confirmation stays in your record, even if the request is later reopened.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <input aria-label="Search completed requests" className="field !py-2 !text-xs" placeholder="Search requests…" value={completionSearch} onChange={event => setCompletionSearch(event.target.value)} />
            <input aria-label="Completed from date" type="date" className="field !py-2 !text-xs" value={completionFrom} onChange={event => setCompletionFrom(event.target.value)} />
            <input aria-label="Completed to date" type="date" className="field !py-2 !text-xs" value={completionTo} onChange={event => setCompletionTo(event.target.value)} />
          </div>
        </div>
        <div className="mt-4 divide-y divide-line">
          {completionError ? <p role="alert" className="py-4 text-sm text-red-700">{completionError}</p>
            : completedWork.length ? completedWork.map(work => {
              const title = work.ticket?.title || work.ticketTitle || 'Deleted request';
              const category = work.ticket?.category || work.ticketCategory || 'Request';
              return <div key={work._id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  {work.ticket ? <Link to={`/tickets/${work.ticket._id}`} className="text-sm font-bold hover:text-leaf hover:underline">{title}</Link> : <span className="text-sm font-bold">{title}</span>}
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">{category} · Client: {work.ticket?.clientId?.name || work.clientName || 'Client'}<RoleBadge role={work.ticket?.clientId?.role}/><span>· Confirmed {new Date(work.confirmedAt).toLocaleDateString()}{work.ticket?.status && work.ticket.status !== 'Resolved' ? ` · Current status: ${work.ticket.status}` : ''}</span></p>
                </div>
                {work.agentRating && <span className="inline-flex items-center gap-1 rounded-full bg-[#fff8e8] px-2.5 py-1 text-xs font-bold text-[#9a6a17]"><Star size={12} className="fill-current" />{work.agentRating}/5</span>}
              </div>;
            })
              : completionLoading ? <p className="py-5 text-sm text-muted">Loading completion history…</p>
                : <p className="py-5 text-sm text-muted">No completed requests match these filters.</p>}
        </div>
        {completionHasMore && <button type="button" disabled={completionLoading} onClick={() => void loadMoreCompletions()} className="btn btn-subtle mt-4 text-sm">{completionLoading ? 'Loading…' : 'Load more completed requests'}</button>}
      </section>}
      {profile.role==='client'&&profile.requestCount!==undefined&&<section className="mt-6"><Link to={`/tickets?clientId=${profile.id}&clientName=${encodeURIComponent(profile.name)}`} className="group block rounded-2xl border border-line bg-[#f5faf6] p-4 transition hover:border-[#8ec5a1] hover:bg-[#eef8f1]"><div className="text-[10px] font-bold uppercase tracking-wider text-muted">Requests submitted</div><div className="mt-1 flex items-center gap-2 text-2xl font-extrabold">{profile.requestCount}<ArrowRight size={18} className="text-leaf transition group-hover:translate-x-1"/></div><div className="mt-1 text-xs text-leaf">View this client’s requests</div></Link></section>}
      <div className="mt-7 grid gap-5 border-t border-line pt-6 lg:grid-cols-[1.35fr_.85fr]"><section className="rounded-2xl border border-line bg-[#fbfcfb] p-5 sm:p-6"><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg bg-[#e7f4eb] text-leaf"><UserRound size={16}/></span><h3 className="text-sm font-extrabold">About</h3></div>{profile.bio ? <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-[#46554d]">{profile.bio}</p> : <div className="mt-4 rounded-xl border border-dashed border-[#d4e2d8] bg-white px-4 py-5"><p className="text-sm leading-6 text-muted">{ownProfile ? 'Introduce yourself to clients and teammates. A short bio helps people understand what you do and how you work.' : 'This member has not shared an introduction yet.'}</p>{ownProfile && <Link to="/profile/edit" className="mt-3 inline-flex text-xs font-bold text-leaf hover:underline">Add a bio</Link>}</div>}</section>
        <aside className="space-y-3"><h3 className="px-1 text-[10px] font-extrabold uppercase tracking-[.15em] text-muted">Profile details</h3>{details.map(({ icon: Icon, label, value }) => <div key={label} className="flex items-start gap-3 rounded-xl border border-line bg-white p-4"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#f0f6f1] text-leaf"><Icon size={16}/></span><div className="min-w-0 pt-0.5"><div className="text-[10px] font-bold uppercase tracking-wider text-muted">{label}</div><div className="mt-1 break-words text-sm font-semibold text-ink">{value}</div></div></div>)}{profile.website && <a href={profile.website} target="_blank" rel="noreferrer" className="flex items-start gap-3 rounded-xl border border-line bg-white p-4 transition hover:border-[#a9d4b7] hover:bg-[#f8fbf8]"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#f0f6f1] text-leaf"><Globe2 size={16}/></span><span className="min-w-0 flex-1 pt-0.5"><span className="block text-[10px] font-bold uppercase tracking-wider text-muted">Website / portfolio</span><span className="mt-1 block break-all text-sm font-semibold text-leaf">{profile.website}</span></span><ExternalLink size={14} className="mt-1 shrink-0 text-muted"/></a>}{details.length === 0 && !profile.website && <div className="rounded-xl border border-dashed border-[#d4e2d8] p-4 text-sm text-muted">{ownProfile ? 'Add your role, organization, or location to complete your profile.' : 'No additional details shared.'}</div>}</aside></div>
    </div>
  </div></>;
}
