import { Router } from 'express';
import { isValidObjectId, Types } from 'mongoose';
import { z } from 'zod';
import { CallSession } from '../models/CallSession';
import { CallSignal } from '../models/CallSignal';
import { DirectConversation } from '../models/DirectConversation';
import { DirectMessage } from '../models/DirectMessage';
import { authenticate, type AuthRequest } from '../middleware/auth';

export const callRouter = Router();
callRouter.use(authenticate);
const userId = (value: unknown) => String(value && typeof value === 'object' && '_id' in value ? (value as { _id: unknown })._id : value);
const activeStates = ['ringing', 'active'];
const callPopulation = [{ path: 'initiator', select: 'name role avatarUrl' }, { path: 'participants', select: 'name role avatarUrl' }, { path: 'acceptedBy', select: 'name role avatarUrl' }, { path: 'declinedBy', select: 'name role avatarUrl' }, { path: 'leftBy', select: 'name role avatarUrl' }];

function callRecordUpdate(call: { _id: Types.ObjectId; mode: 'audio'|'video'; initiator: Types.ObjectId; participants: Types.ObjectId[]; result?: string; connectedAt?: Date; endedAt?: Date }, status: string) {
  const durationSeconds = status === 'completed' && call.connectedAt && call.endedAt ? Math.max(0, Math.floor((call.endedAt.getTime()-call.connectedAt.getTime())/1000)) : 0;
  return DirectMessage.updateOne({ 'callRecord.callId': String(call._id) }, { $set: { 'callRecord.status': status, 'callRecord.result': status, 'callRecord.durationSeconds': durationSeconds } });
}

callRouter.get('/config', (_req, res) => {
  const iceServers: Array<Record<string, unknown>> = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URLS && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) iceServers.push({ urls: process.env.TURN_URLS.split(',').map(value => value.trim()).filter(Boolean), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  res.json({ success: true, data: { iceServers, turnConfigured: iceServers.length > 1, meshParticipantLimit: 4 } });
});

callRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const cutoff = new Date(Date.now()-60_000);
    const stale = await CallSession.find({ state: 'ringing', createdAt: { $lt: cutoff } });
    for (const call of stale) { call.state='ended';call.result='missed';call.endedAt=new Date();await call.save();await callRecordUpdate(call,'missed'); }
    const calls = await CallSession.find({ participants: req.user!.id, state: { $in: activeStates }, leftBy: { $ne: req.user!.id } }).populate(callPopulation).sort({ createdAt: -1 }).limit(10);
    await CallSession.updateMany({ _id: { $in: calls.map(call=>call._id) } }, { $set: { lastActivityAt: new Date() } });
    res.json({ success: true, data: { calls } });
  } catch (error) { next(error); }
});

callRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const parsed = z.object({ conversationId: z.string().refine(isValidObjectId), mode: z.enum(['audio','video']) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success:false,message:'Choose a conversation and call type.' });return; }
    const conversation = await DirectConversation.findById(parsed.data.conversationId);
    if (!conversation || !conversation.participants.some(id=>String(id)===req.user!.id)) { res.status(404).json({ success:false,message:'Conversation not found.' });return; }
    const participants = conversation.participants.map(id=>new Types.ObjectId(String(id)));
    if (participants.length>4) { res.status(409).json({ success:false,message:'Group calls currently support up to four people so audio and video stay clear.' });return; }
    const occupied = await CallSession.findOne({ participants: req.user!.id, state: { $in: activeStates }, leftBy: { $ne: req.user!.id } });
    if (occupied) { res.status(409).json({ success:false,message:'You are already in another call.' });return; }
    const now = new Date();
    const call = await CallSession.create({ conversation: conversation._id, initiator: req.user!.id, participants, acceptedBy: [req.user!.id], mode: parsed.data.mode, state: 'ringing', lastActivityAt: now });
    await DirectMessage.create({ conversation: conversation._id, sender: req.user!.id, message: '', callRecord: { callId: String(call._id), mode: call.mode, initiator: call.initiator, participants: call.participants, status: 'ringing', result: 'ringing', durationSeconds: 0 } });
    conversation.lastMessageAt=now;await conversation.save();
    await call.populate(callPopulation);
    res.status(201).json({ success:true,data:{call} });
  } catch (error) { next(error); }
});

callRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success:false,message:'Call not found.' });return; }
    const call = await CallSession.findById(req.params.id).populate(callPopulation);
    if (!call || !call.participants.some(person=>userId(person)===req.user!.id)) { res.status(404).json({ success:false,message:'Call not found.' });return; }
    if (call.state!=='ended') { call.lastActivityAt=new Date();await call.save(); }
    res.json({ success:true,data:{call} });
  } catch(error){next(error);}
});

callRouter.post('/:id/action', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success:false,message:'Call not found.' });return; }
    const parsed=z.object({action:z.enum(['accept','decline','cancel','leave','end'])}).safeParse(req.body);
    if(!parsed.success){res.status(400).json({success:false,message:'Choose a valid call action.'});return;}
    const call=await CallSession.findById(req.params.id);
    if(!call||!call.participants.some(id=>String(id)===req.user!.id)){res.status(404).json({success:false,message:'Call not found.'});return;}
    if(call.state==='ended'){await call.populate(callPopulation);res.json({success:true,data:{call}});return;}
    const now=new Date();const action=parsed.data.action;const member=new Types.ObjectId(req.user!.id);
    if(action==='accept'){
      if(req.user!.id===String(call.initiator)){res.status(409).json({success:false,message:'You started this call.'});return;}
      if(!call.acceptedBy.some(id=>String(id)===req.user!.id)){call.acceptedBy.push(member);}
      call.state='active';call.connectedAt=call.connectedAt||now;
    } else if(action==='decline'){
      if(!call.declinedBy.some(id=>String(id)===req.user!.id))call.declinedBy.push(member);
      const outstanding=call.participants.filter(id=>String(id)!==String(call.initiator)&&!call.declinedBy.some(declined=>String(declined)===String(id))&&!call.acceptedBy.some(accepted=>String(accepted)===String(id)));
      if(outstanding.length===0&&call.acceptedBy.length<=1){call.state='ended';call.result='declined';call.endedAt=now;}
    } else if(action==='cancel'){
      if(String(call.initiator)!==req.user!.id){res.status(403).json({success:false,message:'Only the caller can cancel an unanswered call.'});return;}
      call.state='ended';call.result='canceled';call.endedAt=now;
    } else if(action==='end'||(action==='leave'&&String(call.initiator)===req.user!.id)){
      call.state='ended';call.result=call.connectedAt?'completed':'canceled';call.endedAt=now;
    } else {
      if(!call.leftBy.some(id=>String(id)===req.user!.id))call.leftBy.push(member);
      const remaining=call.acceptedBy.filter(id=>!call.leftBy.some(left=>String(left)===String(id)));
      if(remaining.length===0){call.state='ended';call.result='completed';call.endedAt=now;}
    }
    call.lastActivityAt=now;await call.save();
    if(call.state==='ended'){await callRecordUpdate(call,call.result||'completed');await CallSignal.deleteMany({call:call._id});}
    await call.populate(callPopulation);res.json({success:true,data:{call}});
  }catch(error){next(error);}
});

callRouter.get('/:id/signals', async (req: AuthRequest, res, next) => {
  try {
    if(!isValidObjectId(req.params.id)){res.status(404).json({success:false,message:'Call not found.'});return;}
    const call=await CallSession.findOne({_id:req.params.id,participants:req.user!.id,state:{$in:activeStates},leftBy:{$ne:req.user!.id}});
    if(!call){res.status(404).json({success:false,message:'Call is no longer active.'});return;}
    const after=typeof req.query.after==='string'&&isValidObjectId(req.query.after)?new Types.ObjectId(req.query.after):new Types.ObjectId('000000000000000000000000');
    const signals=await CallSignal.find({call:call._id,recipient:req.user!.id,_id:{$gt:after}}).sort({_id:1}).limit(100).lean();
    res.json({success:true,data:{signals}});
  }catch(error){next(error);}
});

callRouter.post('/:id/signals', async (req: AuthRequest, res, next) => {
  try {
    if(!isValidObjectId(req.params.id)){res.status(404).json({success:false,message:'Call not found.'});return;}
    const parsed=z.object({recipientId:z.string().refine(isValidObjectId),kind:z.enum(['offer','answer','ice']),payload:z.record(z.unknown())}).safeParse(req.body);
    if(!parsed.success||JSON.stringify(parsed.data?.payload||{}).length>24_000){res.status(400).json({success:false,message:'Call signal is invalid or too large.'});return;}
    const call=await CallSession.findOne({_id:req.params.id,participants:req.user!.id,state:{$in:activeStates},leftBy:{$ne:req.user!.id}});
    if(!call||!call.participants.some(id=>String(id)===parsed.data.recipientId)||parsed.data.recipientId===req.user!.id){res.status(404).json({success:false,message:'Call participant not found.'});return;}
    if(parsed.data.kind!=='offer'&&!call.acceptedBy.some(id=>String(id)===req.user!.id)){res.status(403).json({success:false,message:'Join the call before sending media signals.'});return;}
    await CallSignal.create({call:call._id,sender:req.user!.id,recipient:parsed.data.recipientId,kind:parsed.data.kind,payload:parsed.data.payload});
    call.lastActivityAt=new Date();await call.save();res.status(201).json({success:true});
  }catch(error){next(error);}
});
