import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Check, CircleAlert, HandHelping, LoaderCircle, MessageCircle, RefreshCw, Send } from 'lucide-react';
import { api, errorMessage } from './api';
import type { Role, Ticket, TeamProgressUpdate, ThreadMessage } from './types';
import RoleBadge from './RoleBadge';

type Props = { ticket: Ticket; role: Role; viewerId: string; onUpdated: (ticket: Ticket) => void };
const personName = (person: TeamProgressUpdate['author'] | NonNullable<Ticket['assignedTo']>) => typeof person === 'string' ? 'Team member' : person?.name || 'Team member';
const personRole = (person: TeamProgressUpdate['author'] | NonNullable<Ticket['assignedTo']>) => typeof person === 'string' ? undefined : person?.role;
const personId = (person: TeamProgressUpdate['author'] | NonNullable<Ticket['assignedTo']>) => typeof person === 'string' ? undefined : person?.id || person?._id;

export default function TeamProgressPanel({ ticket, role, viewerId, onUpdated }: Props) {
  const [summary, setSummary] = useState('');
  const [completed, setCompleted] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [blockers, setBlockers] = useState('');
  const [assistanceNeeded, setAssistanceNeeded] = useState(false);
  const [offerMessage, setOfferMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [teamMessage, setTeamMessage] = useState('');
  const teamMessageRef = useRef<HTMLTextAreaElement>(null);
  const teamMessageWords = teamMessage.trim() ? teamMessage.trim().split(/\s+/).length : 0;
  const [threadLoading, setThreadLoading] = useState(false);

  const assignedId = ticket.assignedTo?.id || ticket.assignedTo?._id;
  const isOwner = role === 'agent' && assignedId === viewerId;
  const canManageOffers = role === 'admin' || isOwner;
  const canOfferHelp = role === 'agent' && Boolean(assignedId) && assignedId !== viewerId && ticket.status === 'In Progress';
  const updates = [...(ticket.progressUpdates || [])].reverse();
  const offers = ticket.assistanceOffers || [];
  const ownPendingOffer = offers.some(offer => offer.status === 'pending' && (typeof offer.agent === 'string' ? offer.agent : offer.agent.id || offer.agent._id) === viewerId);
  const isAcceptedHelper = offers.some(offer => offer.status === 'accepted' && (typeof offer.agent === 'string' ? offer.agent : offer.agent.id || offer.agent._id) === viewerId && (typeof offer.acceptedFor === 'string' ? offer.acceptedFor : offer.acceptedFor?.id || offer.acceptedFor?._id) === assignedId);
  const canReadThread = role === 'admin' || isOwner || isAcceptedHelper;

  async function loadTeamMessages() {
    if (!canReadThread) return;
    setThreadLoading(true);
    try { const { data } = await api.get(`/tickets/${ticket._id}/team-messages`); setMessages(data.data.messages); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setThreadLoading(false); }
  }

  useEffect(() => { setMessages([]); if (canReadThread) void loadTeamMessages(); }, [ticket._id, canReadThread]);

  async function saveProgress(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { data } = await api.post(`/tickets/${ticket._id}/progress`, { summary, completed, nextAction, blockers, assistanceNeeded });
      onUpdated(data.data.ticket); setSummary(''); setCompleted(''); setNextAction(''); setBlockers(''); setAssistanceNeeded(false); setNotice('Team progress updated.');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function offerHelp(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { data } = await api.post(`/tickets/${ticket._id}/assistance-offers`, { message: offerMessage });
      onUpdated(data.data.ticket); setOfferMessage(''); setNotice('Your offer was sent to the assigned agent.');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function decideOffer(offerId: string, status: 'accepted' | 'declined') {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { data } = await api.patch(`/tickets/${ticket._id}/assistance-offers/${offerId}`, { status });
      onUpdated(data.data.ticket); setNotice(status === 'accepted' ? 'Offer accepted. The helper can now join the private team discussion.' : 'Offer declined.');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function sendTeamMessage(event: FormEvent) {
    event.preventDefault();
    if (busy || !teamMessage.trim()) return;
    if (teamMessageWords > 2000) { setError('Messages can contain at most 2,000 words.'); return; }
    setBusy(true); setError(''); setNotice('');
    try { const { data } = await api.post(`/tickets/${ticket._id}/team-messages`, { message: teamMessage.trim() }); setMessages(current => [...current, data.data.message]); setTeamMessage(''); if (teamMessageRef.current) { teamMessageRef.current.style.height = 'auto'; teamMessageRef.current.style.overflowY = 'hidden'; } }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  function resizeTeamMessage(event: React.ChangeEvent<HTMLTextAreaElement>) {
    setTeamMessage(event.target.value);
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
    event.target.style.overflowY = event.target.scrollHeight > 180 ? 'auto' : 'hidden';
  }

  if (role === 'client') {
    const helpers = ticket.teamCollaborators || [];
    return helpers.length ? <section className="mb-5 rounded-2xl border border-[#d6e7da] bg-white p-4 shadow-card" aria-label="Request team members"><div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#e7f4eb] text-leaf"><HandHelping size={17}/></span><div><div className="text-[10px] font-extrabold uppercase tracking-[.14em] text-leaf">Your request team</div><p className="mt-1 text-xs leading-5 text-muted"><span className="font-bold text-ink">{helpers.map(person => person.name).join(', ')}</span> {helpers.length === 1 ? 'is' : 'are'} helping your assigned agent. Your assigned agent remains responsible for your request and updates.</p></div></div></section> : null;
  }

  return <section className="mb-5 rounded-2xl border border-[#d6e7da] bg-white p-5 shadow-card" aria-labelledby="team-progress-title">
    <div className="flex items-start gap-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e7f4eb] text-leaf"><HandHelping size={19}/></span>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-extrabold uppercase tracking-[.15em] text-leaf">TEAM COORDINATION</div>
        <h2 id="team-progress-title" className="mt-1 text-sm font-extrabold">Progress and assistance</h2>
      <p className="mt-1 text-xs leading-5 text-muted">Progress is visible to agency staff. Private team discussion is limited to the assigned agent, accepted helpers, and admins.</p>
      </div>
    </div>

    {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p>}
    {notice && <p role="status" className="mt-4 rounded-lg bg-[#e7f5ec] p-3 text-xs font-semibold text-leaf">{notice}</p>}

    {updates.length > 0 ? <div className="mt-4 space-y-3">{updates.slice(0, 5).map((update, index) => <article key={update._id || `${update.createdAt}-${index}`} className="rounded-xl border border-line bg-[#fbfcfb] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold">{update.summary}</span><time className="text-[10px] text-muted" dateTime={update.createdAt}>{new Date(update.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></div>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted">Updated by {personId(update.author) ? <Link to={`/profile/${personId(update.author)}`} className="font-semibold hover:text-leaf hover:underline">{personName(update.author)}</Link> : personName(update.author)} <RoleBadge role={personRole(update.author)}/></p>
      <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
        {update.completed && <p><span className="font-bold">Completed: </span><span className="text-muted">{update.completed}</span></p>}
        {update.nextAction && <p><span className="font-bold">Next: </span><span className="text-muted">{update.nextAction}</span></p>}
      </div>
      {update.blockers && <p className="mt-2 flex items-start gap-1.5 text-xs text-[#8c5a11]"><CircleAlert size={14} className="mt-0.5 shrink-0"/><span><b>Blocker: </b>{update.blockers}</span></p>}
      {update.assistanceNeeded && <span className="mt-2 inline-flex rounded-full bg-[#fff2dc] px-2.5 py-1 text-[10px] font-bold text-[#805314]">Assistance requested</span>}
    </article>)}</div> : <p className="mt-4 rounded-xl border border-dashed border-line bg-[#fbfcfb] p-4 text-xs text-muted">No team progress updates yet.</p>}

    {isOwner && ticket.status === 'In Progress' && <form onSubmit={saveProgress} className="mt-4 space-y-3 rounded-xl border border-line p-4">
      <h3 className="text-xs font-extrabold">Post a progress update</h3>
      <label className="block text-xs font-semibold">Short summary<textarea required minLength={5} maxLength={240} rows={2} className="field mt-1.5 resize-y !text-xs" placeholder="What changed since your last update?" value={summary} onChange={event => setSummary(event.target.value)}/></label>
      <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs font-semibold">Work completed<input maxLength={500} className="field mt-1.5 !text-xs" value={completed} onChange={event => setCompleted(event.target.value)} placeholder="Completed items"/></label><label className="block text-xs font-semibold">Next planned action<input maxLength={300} className="field mt-1.5 !text-xs" value={nextAction} onChange={event => setNextAction(event.target.value)} placeholder="Next step"/></label></div>
      <label className="block text-xs font-semibold">Blockers or dependencies<input maxLength={300} className="field mt-1.5 !text-xs" value={blockers} onChange={event => setBlockers(event.target.value)} placeholder="None, or briefly explain what is blocked"/></label>
      <label className="flex items-center gap-2 text-xs font-semibold"><input type="checkbox" checked={assistanceNeeded} onChange={event => setAssistanceNeeded(event.target.checked)} className="accent-[#167a57]"/>I could use help from the team</label>
      <div className="flex justify-end"><button disabled={busy} className="btn btn-primary text-xs disabled:opacity-50">{busy ? <LoaderCircle className="animate-spin" size={14}/> : <Send size={14}/>}Post update</button></div>
    </form>}

    {canOfferHelp && <form onSubmit={offerHelp} className="mt-4 rounded-xl border border-[#d6e7da] bg-[#f7fbf8] p-4">
      <h3 className="text-xs font-extrabold">Offer assistance</h3><p className="mt-1 text-[11px] leading-5 text-muted">The assigned agent decides whether to coordinate. This does not grant conversation access or change ownership.</p>
      <textarea required minLength={10} maxLength={500} rows={2} className="field mt-3 resize-y !text-xs" aria-label="Assistance offer" placeholder="Describe the specific help you can provide…" value={offerMessage} onChange={event => setOfferMessage(event.target.value)} disabled={ownPendingOffer || busy}/>
      <div className="mt-2 flex justify-end"><button disabled={busy || ownPendingOffer} className="btn btn-primary text-xs disabled:opacity-50">{ownPendingOffer ? 'Offer awaiting response' : 'Send offer'}<Send size={13}/></button></div>
    </form>}

    {(canManageOffers && offers.length > 0) && <div className="mt-4 space-y-2"><h3 className="text-xs font-extrabold">Assistance offers</h3>{offers.map(offer => <div key={offer._id} className="rounded-xl border border-line p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="flex flex-wrap items-center gap-2 text-xs font-bold">{personId(offer.agent as TeamProgressUpdate['author']) ? <Link to={`/profile/${personId(offer.agent as TeamProgressUpdate['author'])}`} className="hover:text-leaf hover:underline">{personName(offer.agent as TeamProgressUpdate['author'])}</Link> : personName(offer.agent as TeamProgressUpdate['author'])}<RoleBadge role={personRole(offer.agent as TeamProgressUpdate['author'])}/></span><span className="rounded-full bg-[#f1f5f2] px-2 py-1 text-[10px] font-bold capitalize text-muted">{offer.status}</span></div><p className="mt-2 text-xs leading-5 text-muted">{offer.message}</p>{offer.status === 'pending' && <div className="mt-3 flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => void decideOffer(offer._id, 'declined')} className="btn btn-subtle text-xs">Decline</button><button type="button" disabled={busy} onClick={() => void decideOffer(offer._id, 'accepted')} className="btn btn-primary text-xs"><Check size={13}/>Accept</button></div>}</div>)}</div>}

    {canReadThread && <section className="mt-4 rounded-xl border border-[#d6e7da] bg-[#fbfdfb] p-4" aria-label="Private team discussion">
      <div className="flex items-center justify-between gap-3"><div><h3 className="flex items-center gap-2 text-xs font-extrabold"><MessageCircle size={14} className="text-leaf"/>Private team discussion</h3><p className="mt-1 text-[11px] text-muted">Only the assigned agent, accepted helpers, and admins can see these messages.</p></div><button type="button" onClick={() => void loadTeamMessages()} disabled={threadLoading} className="btn btn-subtle !px-2.5 !py-2 text-[11px]" aria-label="Refresh team messages"><RefreshCw size={13} className={threadLoading ? 'animate-spin' : ''}/></button></div>
      {messages.length ? <div className="mt-3 max-h-72 space-y-2 overflow-y-auto" aria-live="polite">{messages.map(message => <article key={message._id} className="rounded-lg border border-line bg-white p-3"><div className="flex items-center justify-between gap-2"><span className="flex flex-wrap items-center gap-2 text-xs font-bold">{message.sender?.id || message.sender?._id ? <Link to={`/profile/${message.sender.id || message.sender._id}`} className="hover:text-leaf hover:underline">{message.sender.name}</Link> : message.sender?.name || 'Team member'}<RoleBadge role={message.sender?.role}/></span><time className="text-[10px] text-muted" dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-[#46554d]">{message.message}</p></article>)}</div> : <p className="mt-3 rounded-lg border border-dashed border-line bg-white p-3 text-xs text-muted">{threadLoading ? 'Loading team messages…' : 'No team messages yet. Use this space to coordinate privately.'}</p>}
      <form onSubmit={sendTeamMessage} className="mt-3 flex items-end gap-2"><label className="min-w-0 flex-1"><span className="sr-only">Message your request team</span><textarea ref={teamMessageRef} required maxLength={20000} rows={2} className="field max-h-[180px] min-h-[72px] resize-none overflow-y-hidden !text-sm" value={teamMessage} onChange={resizeTeamMessage} placeholder="Write a message to the request team…" disabled={busy}/><span className="mt-1 block text-right text-[10px] text-muted">{teamMessageWords.toLocaleString()} / 2,000 words</span></label><button disabled={busy || !teamMessage.trim() || teamMessageWords > 2000} className="btn btn-primary shrink-0 text-xs">{busy ? <LoaderCircle size={14} className="animate-spin"/> : <Send size={13}/>}Send</button></form>
    </section>}
  </section>;
}
