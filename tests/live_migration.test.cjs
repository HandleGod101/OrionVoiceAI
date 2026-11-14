const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
class Element {
 constructor(){this.children=[];this.value='';this.textContent='';this.dataset={};this.className='';this.classList={add(){},remove(){},toggle(){}};}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=items;}
 set innerHTML(v){this.children=[];}
 get scrollHeight(){return this.children.length;}
 querySelector(){return null;}
 setAttribute(){}
 play(){return Promise.resolve();}
 pause(){}
}
function fixture(t){
 const elements=new Map(), sent=[],requests=[];
 const $=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 $('scenario').value='failed_payment_arrangement';$('callDirection').value='outbound';
 const track={enabled:true,stop(){this.stopped=true;}};
 const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
 let ctx;
 class Peer {
  constructor(){this.iceGatheringState='complete';this.connectionState='new';}
  addTrack(){}
  createDataChannel(){return this.channel={readyState:'open',send:event=>{
   const msg=JSON.parse(event);sent.push(msg);
   if(msg.type==='session.close')queueMicrotask(()=>{
    ctx.events({type:'session.input_transcript.delta',event_id:'final',delta:' Goodbye.',start_ms:1000,end_ms:1400});
    ctx.events({type:'session.closed',reason:'close_requested'});
   });
  },close(){this.readyState='closed';}};}
  async createOffer(){return {type:'offer',sdp:'v=0 fake offer'};}
  async setLocalDescription(d){this.localDescription=d;}
  async setRemoteDescription(d){this.remoteDescription=d;ctx.events({type:'session.started'});}
  close(){this.connectionState='closed';}
 }
 ctx=vm.createContext({document:{getElementById:$,createElement:()=>new Element()},
  console:{log(){}},window:{},navigator:{mediaDevices:{getUserMedia:async()=>stream}},
  RTCPeerConnection:Peer,AbortController,setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},
  fetch:async(url,opts)=>{
   if(url!='/api/session')return new Promise(()=>{});
   requests.push({url,...JSON.parse(opts.body)});
   return {ok:true,json:async()=>({sdp:'v=0 fake answer',session_id:'live_mock',model:'gpt-live-1',variation:{communication:'quiet',difficulty:'medium'},scenario:{id:'failed_payment_arrangement',name:'Rachel',consumer_name:'Rachel Carter'}})};
  }});
 vm.runInContext(fs.readFileSync('static/app.js','utf8'),ctx);
 t.after(()=>ctx.end());
 return {ctx,$,sent,requests,track,run:code=>vm.runInContext(code,ctx)};
}
test('outbound connects through backend Live SDP; greeting and mute work',async t=>{
 const a=fixture(t);await a.ctx.start();assert.equal(a.requests.length,0);assert.equal(a.track.enabled,false);
 await a.ctx.connectCall(a.run('activeCallId'));
 assert.equal(a.requests[0].sdp,'v=0 fake offer');
 assert.equal(a.run('callPhase'),'live');assert.equal(a.track.enabled,true);
 assert.equal(a.sent[0].type,'session.commentary.append');
 a.ctx.mute();assert.equal(a.track.enabled,false);a.ctx.mute();assert.equal(a.track.enabled,true);
});
test('inbound waits for answer; canceled ringing never creates session',async t=>{
 const a=fixture(t);a.$('callDirection').value='inbound';await a.ctx.start();
 assert.equal(a.run('callPhase'),'ringing');assert.equal(a.requests.length,0);
 const id=a.run('activeCallId');a.ctx.end();await a.ctx.connectCall(id);assert.equal(a.requests.length,0);
});
test('late microphone permission after cancel stops tracks',async t=>{
 const a=fixture(t);let resolve;
 a.ctx.navigator.mediaDevices.getUserMedia=()=>new Promise(r=>{resolve=r;});
 const starting=a.ctx.start();a.ctx.end();resolve({getTracks:()=>[a.track]});await starting;
 assert.equal(a.track.stopped,true);assert.equal(a.requests.length,0);
});
test('interleaved transcript fragments retain speaker/timing and deduplicate events',t=>{
 const a=fixture(t);
 for(const e of [
 {type:'session.input_transcript.delta',event_id:'a',delta:'Hello',start_ms:100,end_ms:200},
 {type:'session.output_transcript.delta',event_id:'b',delta:'Hi',start_ms:150,end_ms:230},
 {type:'session.input_transcript.delta',event_id:'c',delta:' Rachel',start_ms:210,end_ms:350},
 {type:'session.input_transcript.delta',event_id:'c',delta:' Rachel',start_ms:210,end_ms:350},
 ])a.ctx.events(e);
 assert.equal(a.run('evaluationTurns.length'),2);
 assert.equal(a.run('evaluationTurns[0].text'),'Hello Rachel');
 a.$('clearTranscript').onclick();
 a.ctx.events({type:'session.output_transcript.delta',event_id:'d',delta:' again',start_ms:400,end_ms:500});
 assert.equal(a.run('evaluationTurns[1].text'),'Hi again');
 assert.equal(a.$('transcript').children.length,1);
});
test('End call waits for session.closed and includes final transcript in evaluation',async t=>{
 const a=fixture(t);await a.ctx.start();await a.ctx.connectCall(a.run('activeCallId'));
 a.ctx.events({type:'session.input_transcript.delta',event_id:'initial',delta:'Thanks.',start_ms:100,end_ms:300});
 await a.ctx.finishAndPrepareResults();
 assert.equal(a.run('finalizedCall.transcript_quality.finalization_confirmed'),true);
 assert.match(a.run('finalizedCall.turns[0].text'),/Goodbye/);
 assert.equal(a.run('finalizedCall.scenario_id'),'failed_payment_arrangement');
 assert.equal(a.run('evaluationBusy'),false);assert.equal(a.track.stopped,true);
});
