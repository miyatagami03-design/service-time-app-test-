(() => {
"use strict";

const STEP_DEFS=[
  ["来店","arrival_at"],["説明","explanation_at"],["前菜","starter_at"],["鍋温め","pot_warm_at"],
  ["鍋作り終わり","pot_finish_at"],["山椒","sansho_at"],["あく取り・スープ","soup_at"],
  ["〆の発注","closing_order_at"],["〆作り終わり","closing_finish_at"],["あがりおしぼり","oshibori_at"],["会計","checkout_at"]
];
// コース別の追加項目（after＝この項目の後に提供）
const COURSES={
  normal:{label:"通常",note:"追加項目なし"},
  kamo:{label:"鴨づくし",note:"前菜の後にアミューズ"},
  kiwami:{label:"極み",note:"アミューズ＋鍋作り終わりの後にワンタン・副材料"}
};
const EXTRA_STEPS=[
  {label:"アミューズ",col:"amuse_at",after:"starter_at",courses:["kamo","kiwami"]},
  {label:"ワンタン",col:"wonton_at",after:"pot_finish_at",courses:["kiwami"]},
  {label:"副材料",col:"side_at",after:"pot_finish_at",courses:["kiwami"]}
];
const ALL_STEPS=[...STEP_DEFS,...EXTRA_STEPS.map(e=>[e.label,e.col])];
const COL_TO_LABEL=Object.fromEntries(ALL_STEPS.map(([l,c])=>[c,l]));
const NINE_MIN_STEPS=new Set(["amuse_at","pot_warm_at","wonton_at","side_at","sansho_at","soup_at","closing_order_at","oshibori_at"]);
const STORAGE_KEY="service-time-local-v21-test";
const ALERT_KEY="service-time-alerts-v21-test";
const timeFmt=new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",hour:"2-digit",minute:"2-digit",hour12:false});
const dateFmt=new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",year:"numeric",month:"long",day:"numeric",weekday:"short"});
const JST_DATE=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());

let state=loadState();
let linkRepresentative=null;
let linkSelected=new Set();
let moveSource=null;
let moveTarget=null;
let audioCtx=null;
let alertAudio=null;
let alertAudioUrl=null;
let alertLoopTimer=null;
let alertActive=false;

function blankGroup(n){
  return {
    id:crypto.randomUUID?crypto.randomUUID():String(Date.now())+"-"+n+"-"+Math.random(),
    representative_table:n,linked_tables:[n],reservation_time:null,course:"normal",
    arrival_at:null,explanation_at:null,starter_at:null,amuse_at:null,pot_warm_at:null,pot_finish_at:null,
    wonton_at:null,side_at:null,
    sansho_at:null,soup_at:null,closing_order_at:null,closing_finish_at:null,oshibori_at:null,checkout_at:null,
    pot_warm_alerted_at:null
  };
}
function freshState(){
  return {date:JST_DATE(),groups:Array.from({length:9},(_,i)=>blankGroup(i+1)),history:[]};
}
function loadState(){
  try{
    const x=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");
    if(x&&x.date===JST_DATE()&&Array.isArray(x.groups)) return x;
  }catch{}
  const x=freshState();
  localStorage.setItem(STORAGE_KEY,JSON.stringify(x));
  return x;
}
function save(){localStorage.setItem(STORAGE_KEY,JSON.stringify(state))}
function fmtTime(v){return v?timeFmt.format(new Date(v)):""}
function elapsedFrom(v){
  if(!v)return"--:--:--";
  const sec=Math.max(0,Math.floor((Date.now()-new Date(v).getTime())/1000));
  return String(Math.floor(sec/3600)).padStart(2,"0")+":"+String(Math.floor(sec%3600/60)).padStart(2,"0")+":"+String(sec%60).padStart(2,"0");
}
function groupForTable(n){return state.groups.find(g=>(g.linked_tables||[]).includes(n))}
function hasService(g){return ALL_STEPS.some(([,c])=>!!g[c])}
function courseOf(g){return COURSES[g?.course]?g.course:"normal"}
function extraStepsFor(g){return EXTRA_STEPS.filter(e=>e.courses.includes(courseOf(g)))}
function courseSequence(g){
  const extras=extraStepsFor(g),seq=[];
  for(const [,c] of STEP_DEFS){seq.push(c);for(const e of extras)if(e.after===c)seq.push(e.col)}
  return seq;
}
function isLate(g){
  if(!g?.reservation_time||g.arrival_at||g.checkout_at)return false;
  const [h,m]=String(g.reservation_time).slice(0,5).split(":").map(Number);
  const now=new Date();
  const jp=new Date(now.toLocaleString("en-US",{timeZone:"Asia/Tokyo"}));
  const r=new Date(jp);r.setHours(h,m,0,0);
  return jp>=r;
}
function elapsedWarn(g,startCol,endCol,ms){return !!(g?.[startCol]&&!g?.[endCol]&&!g?.checkout_at&&(Date.now()-new Date(g[startCol]).getTime()>=ms))}
function potWarn(g){return elapsedWarn(g,"pot_warm_at","pot_finish_at",330000)}
function arrivalWarn(g){return !!(g?.arrival_at&&!g.checkout_at&&(Date.now()-new Date(g.arrival_at).getTime()>=6300000))}
function nineMinWarn(g,col){
  if(!g||!NINE_MIN_STEPS.has(col))return false;
  const seq=courseSequence(g),i=seq.indexOf(col);
  return i>0?elapsedWarn(g,seq[i-1],col,540000):false;
}
function labelHtml(step){
  return step.replace("鍋作り終わり","鍋作り<br>終わり")
    .replace("あく取り・スープ","あく取り<br>・スープ")
    .replace("〆作り終わり","〆作り<br>終わり")
    .replace("あがりおしぼり","あがり<br>おしぼり");
}
function tableLabel(g){return [...g.linked_tables].sort((a,b)=>a-b).join("・")+"卓"}

function recordStep(g,col){
  if(g[col]){
    const label=COL_TO_LABEL[col];
    if(!confirm("「"+label+"」の記録を取り消しますか？"))return;
    g[col]=null;
    if(col==="pot_warm_at")g.pot_warm_alerted_at=null;
  }else{
    g[col]=new Date().toISOString();
    if(col==="pot_warm_at")g.pot_warm_alerted_at=null;
  }
  save();render();
}
let courseTarget=null;
function openCourse(g){
  if(!g)return;
  courseTarget=g;
  document.getElementById("courseTitle").textContent=tableLabel(g)+"のコース";
  const box=document.getElementById("courseChoices");box.innerHTML="";
  for(const [key,c] of Object.entries(COURSES)){
    const b=document.createElement("button");b.type="button";
    b.className="choice course-choice"+(courseOf(g)===key?" selected":"");
    b.innerHTML="<div>"+c.label+"</div><div class='choice-sub'>"+c.note+"</div>";
    b.onclick=()=>setCourse(key);box.appendChild(b);
  }
  document.getElementById("courseDialog").showModal();
}
function setCourse(key){
  const g=courseTarget;
  if(!g)return;
  if(courseOf(g)!==key){
    const lost=EXTRA_STEPS.filter(e=>!e.courses.includes(key)&&g[e.col]);
    if(lost.length&&!confirm(COURSES[key].label+"コースに変更しますか？\n「"+lost.map(e=>e.label).join("・")+"」の記録は取り消されます。"))return;
    for(const e of EXTRA_STEPS)if(!e.courses.includes(key))g[e.col]=null;
    g.course=key;
    save();render();
  }
  document.getElementById("courseDialog").close();
  courseTarget=null;
}
let reservationTarget=null;
function openReservation(g){
  if(!g)return;
  reservationTarget=g;
  const dlg=document.getElementById("reservationDialog");
  document.getElementById("reservationTitle").textContent=tableLabel(g)+"の予約時間";
  const current=g.reservation_time?String(g.reservation_time).slice(0,5):"";
  let [hh,mm]=current?current.split(":"):["18","00"];
  document.getElementById("reservationHour").value=hh;
  document.getElementById("reservationMinute").value=mm;
  dlg.showModal();
}
function saveReservation(){
  if(!reservationTarget)return;
  const h=document.getElementById("reservationHour").value;
  const m=document.getElementById("reservationMinute").value;
  reservationTarget.reservation_time=h+":"+m;
  save();
  document.getElementById("reservationDialog").close();
  reservationTarget=null;
  render();
}
function clearReservation(){
  if(!reservationTarget)return;
  reservationTarget.reservation_time=null;
  save();
  document.getElementById("reservationDialog").close();
  reservationTarget=null;
  render();
}
function nextGroup(g){
  if(!confirm(tableLabel(g)+"を次の組に切り替えますか？\n現在の記録は履歴に保存されます。"))return;
  const hasAny=!!g.reservation_time||hasService(g);
  if(hasAny){
    state.history.unshift({...JSON.parse(JSON.stringify(g)),archived_at:new Date().toISOString()});
  }
  const tables=[...g.linked_tables];
  state.groups=state.groups.filter(x=>x.id!==g.id);
  for(const n of tables)state.groups.push(blankGroup(n));
  state.groups.sort((a,b)=>a.representative_table-b.representative_table);
  save();render();
}
function resetToday(){
  if(!confirm("今日のすべての記録をリセットしますか？\n1〜9卓の記録と当日履歴が削除されます。"))return;
  state=freshState();save();render();
}

function render(){
  document.getElementById("dateLabel").textContent=dateFmt.format(new Date());
  const body=document.getElementById("body");
  body.innerHTML="";
  for(let n=1;n<=9;n++){
    const g=groupForTable(n);
    const tr=document.createElement("tr");
    const seat=document.createElement("td");seat.className="seatcell";seat.textContent=n;tr.appendChild(seat);

    if(g && g.representative_table!==n){
      const td=document.createElement("td");td.colSpan=14;td.className="linked-placeholder";
      td.textContent=g.representative_table+"卓と連結中（"+tableLabel(g)+"）";
      tr.appendChild(td);body.appendChild(tr);continue;
    }

    const extras=extraStepsFor(g);
    if(extras.length){seat.rowSpan=2;tr.classList.add("has-extra")}

    const tdRes=document.createElement("td");
    const rb=document.createElement("button");rb.type="button";rb.className="timeinput-btn"+(g?.reservation_time?"":" empty");
    rb.textContent=g?.reservation_time?String(g.reservation_time).slice(0,5):"";
    rb.onclick=()=>openReservation(g);tdRes.appendChild(rb);
    const cb=document.createElement("button");cb.type="button";cb.className="course-btn "+courseOf(g);
    cb.textContent=COURSES[courseOf(g)].label;
    cb.onclick=()=>openCourse(g);tdRes.appendChild(cb);
    tr.appendChild(tdRes);

    const tdEl=document.createElement("td");
    const sp=document.createElement("span");sp.className="elapsed"+(arrivalWarn(g)?" danger":"");sp.textContent=elapsedFrom(g?.arrival_at);
    tdEl.appendChild(sp);tr.appendChild(tdEl);

    for(const [label,col] of STEP_DEFS){
      const td=document.createElement("td");
      if(label==="来店"&&isLate(g))td.classList.add("late");
      if(label==="鍋作り終わり")td.classList.add("milestone30");
      if(label==="〆の発注")td.classList.add("milestone60");
      td.appendChild(stepButton(g,label,col));tr.appendChild(td);
    }

    const tdN=document.createElement("td");
    const nb=document.createElement("button");nb.type="button";nb.className="next";nb.textContent="次の組";nb.onclick=()=>nextGroup(g);
    tdN.appendChild(nb);tr.appendChild(tdN);
    body.appendChild(tr);
    if(extras.length)body.appendChild(extraRow(g,extras));
  }
}
function stepButton(g,label,col){
  const b=document.createElement("button");b.type="button";
  b.className="step"+(g?.[col]?" done":"")+((col==="pot_finish_at"&&potWarn(g))||nineMinWarn(g,col)?" warn":"");
  b.innerHTML="<span>"+labelHtml(label)+"</span>"+(g?.[col]?"<span class='t'>"+fmtTime(g[col])+"</span>":"");
  b.onclick=()=>recordStep(g,col);
  return b;
}
// 追加項目の行：各項目は「直後に提供する項目」の列の下に並べる（同じ列が埋まっていれば右へ）
function extraRow(g,extras){
  const tr=document.createElement("tr");tr.className="extra-row";
  const head=document.createElement("td");head.colSpan=4;head.className="extra-head";
  head.innerHTML="<span class='course-tag "+courseOf(g)+"'>"+COURSES[courseOf(g)].label+"</span>追加項目";
  tr.appendChild(head);
  const slots=new Array(STEP_DEFS.length+1).fill(null);
  for(const e of extras){
    let i=STEP_DEFS.findIndex(([,c])=>c===e.after);
    while(slots[i])i++;
    slots[i]=e;
  }
  for(let i=2;i<slots.length;i++){
    const td=document.createElement("td");
    const col=STEP_DEFS[i]?.[1];
    if(col==="pot_finish_at")td.classList.add("milestone30");
    if(col==="closing_order_at")td.classList.add("milestone60");
    if(slots[i])td.appendChild(stepButton(g,slots[i].label,slots[i].col));
    tr.appendChild(td);
  }
  return tr;
}

function renderHistory(){
  const box=document.getElementById("historyContent");box.innerHTML="";
  if(!state.history.length){box.textContent="まだ履歴はありません。";return}
  for(const h of state.history){
    const card=document.createElement("div");card.className="history-card";
    const res=h.reservation_time?String(h.reservation_time).slice(0,5):"—";
    const arr=fmtTime(h.arrival_at)||"—",co=fmtTime(h.checkout_at)||"—";
    card.innerHTML="<button type='button'><div class='history-title'>"+tableLabel(h)+"　"+COURSES[courseOf(h)].label+"　予約 "+res+"</div><div class='history-sub'>来店 "+arr+"　→　会計 "+co+"</div><div class='history-detail' style='display:none'></div></button>";
    const detail=card.querySelector(".history-detail");
    detail.innerHTML=courseSequence(h).map(c=>h[c]?COL_TO_LABEL[c]+" "+fmtTime(h[c]):"").filter(Boolean).join(" ｜ ")||"記録なし";
    card.querySelector("button").onclick=()=>detail.style.display=detail.style.display==="none"?"block":"none";
    box.appendChild(card);
  }
}

function openLinkDialog(){
  linkRepresentative=null;linkSelected=new Set();renderLinkChoices();document.getElementById("linkDialog").showModal();
}
function renderLinkChoices(){
  const box=document.getElementById("linkChoices");box.innerHTML="";
  for(let n=1;n<=9;n++){
    const g=groupForTable(n),b=document.createElement("button");
    b.type="button";b.className="choice";b.textContent=n+"卓";
    const selected=linkSelected.has(n) || (linkRepresentative&&g?.id===linkRepresentative);
    if(selected)b.classList.add("selected");
    b.onclick=()=>{
      if(!linkRepresentative){
        if(!g||g.linked_tables.length>1||hasService(g))return alert("この卓は現在連結できません。");
        linkRepresentative=g.id;linkSelected=new Set([n]);
      }else{
        const rep=state.groups.find(x=>x.id===linkRepresentative);
        if(g?.id===rep?.id)return;
        if(!g||g.linked_tables.length>1||hasService(g))return alert("この卓は現在連結できません。");
        if(linkSelected.has(n))linkSelected.delete(n);else linkSelected.add(n);
      }
      renderLinkChoices();
    };
    box.appendChild(b);
  }
  const rep=state.groups.find(x=>x.id===linkRepresentative);
  document.getElementById("linkInstructions").textContent=rep?("代表卓："+rep.representative_table+"卓　連結する卓を選択"):"最初に代表卓を選んでください。";
  const warnings=[];
  if(rep){
    for(const n of linkSelected){
      const g=groupForTable(n);
      if(g&&g.id!==rep.id&&g.reservation_time)warnings.push(n+"卓の予約 "+String(g.reservation_time).slice(0,5)+" は使用されなくなります。");
    }
  }
  document.getElementById("linkWarning").textContent=warnings.join(" ");
}
function confirmLink(){
  const rep=state.groups.find(x=>x.id===linkRepresentative);
  if(!rep||linkSelected.size<2)return alert("連結する卓を2卓以上選んでください。");
  const targets=[...linkSelected].sort((a,b)=>a-b);
  const groupsToRemove=[];
  for(const n of targets){
    const g=groupForTable(n);
    if(g&&g.id!==rep.id&&!groupsToRemove.includes(g))groupsToRemove.push(g);
  }
  let msg=targets.join("・")+"卓を連結します。\n代表卓："+rep.representative_table+"卓";
  for(const g of groupsToRemove){
    if(g.reservation_time)msg+="\n"+g.representative_table+"卓の予約 "+String(g.reservation_time).slice(0,5)+" は使用されなくなります。";
  }
  if(!confirm(msg))return;
  rep.linked_tables=targets;
  state.groups=state.groups.filter(g=>!groupsToRemove.some(x=>x.id===g.id));
  save();document.getElementById("linkDialog").close();render();
}


function openMoveDialog(){
  moveSource=null;moveTarget=null;renderMoveChoices();document.getElementById("moveDialog").showModal();
}
function renderMoveChoices(){
  const box=document.getElementById("moveChoices");box.innerHTML="";
  for(let n=1;n<=9;n++){
    const g=groupForTable(n),b=document.createElement("button");
    b.type="button";b.className="choice";b.textContent=n+"卓";
    if(n===moveSource||n===moveTarget)b.classList.add("selected");
    b.onclick=()=>{
      if(moveSource===null){
        if(!g||g.representative_table!==n||g.linked_tables.length>1)return alert("連結中の卓は席移動できません。先に連結を解除してください。");
        if(!g.reservation_time&&!hasService(g)&&courseOf(g)==="normal")return alert("この卓には移動する記録がありません。");
        moveSource=n;
      }else if(n===moveSource){
        moveSource=null;moveTarget=null;
      }else{
        const target=groupForTable(n);
        if(!target||target.representative_table!==n||target.linked_tables.length>1)return alert("連結中の卓には移動できません。");
        if(target.reservation_time||hasService(target)||courseOf(target)!=="normal")return alert("移動先の卓にはすでに記録があります。");
        moveTarget=n;
      }
      renderMoveChoices();
    };
    box.appendChild(b);
  }
  document.getElementById("moveInstructions").textContent=moveSource===null?"移動元の卓を選んでください。":moveTarget===null?moveSource+"卓 → 移動先の卓を選んでください。":moveSource+"卓 → "+moveTarget+"卓へ移動";
  document.getElementById("moveWarning").textContent="予約時間・コース・来店以降の記録をまとめて移動します。";
}
function confirmMove(){
  if(moveSource===null||moveTarget===null)return alert("移動元と移動先を選んでください。");
  const source=groupForTable(moveSource),target=groupForTable(moveTarget);
  if(!source||!target)return;
  if(!confirm(moveSource+"卓の記録を"+moveTarget+"卓へ移動しますか？"))return;
  state.groups=state.groups.filter(g=>g.id!==source.id&&g.id!==target.id);
  source.representative_table=moveTarget;
  source.linked_tables=[moveTarget];
  state.groups.push(blankGroup(moveSource),source);
  state.groups.sort((a,b)=>a.representative_table-b.representative_table);
  save();document.getElementById("moveDialog").close();render();
}
function getAudioContext(){
  try{
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;
    if(!AudioContextClass)return null;
    if(!audioCtx||audioCtx.state==="closed")audioCtx=new AudioContextClass();
    return audioCtx;
  }catch{return null}
}
function createAlertWaveUrl(){
  try{
    if(alertAudioUrl)return alertAudioUrl;
    const sampleRate=12000,duration=.62,sampleCount=Math.ceil(sampleRate*duration);
    const buffer=new ArrayBuffer(44+sampleCount*2),view=new DataView(buffer);
    const write=(offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i))};
    write(0,"RIFF");view.setUint32(4,36+sampleCount*2,true);write(8,"WAVE");write(12,"fmt ");
    view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
    view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
    write(36,"data");view.setUint32(40,sampleCount*2,true);
    const tones=[[0,.16,880],[.22,.38,880],[.44,.60,1046]];
    for(let i=0;i<sampleCount;i++){
      const t=i/sampleRate;
      let sample=0;
      for(const [start,end,frequency] of tones){
        if(t>=start&&t<end){
          const local=t-start,envelope=Math.min(1,local/.012,(end-t)/.025);
          sample=Math.sin(2*Math.PI*frequency*local)*.34*Math.max(0,envelope);
          break;
        }
      }
      view.setInt16(44+i*2,Math.round(sample*32767),true);
    }
    alertAudioUrl=URL.createObjectURL(new Blob([buffer],{type:"audio/wav"}));
    return alertAudioUrl;
  }catch{return null}
}
function getAlertAudio(){
  try{
    if(alertAudio)return alertAudio;
    const url=createAlertWaveUrl();
    if(!url||typeof Audio==="undefined")return null;
    alertAudio=new Audio(url);
    alertAudio.preload="auto";
    alertAudio.playsInline=true;
    return alertAudio;
  }catch{return null}
}
async function unlockMediaAudio(){
  const audio=getAlertAudio();
  if(!audio)return false;
  try{
    audio.muted=true;audio.currentTime=0;
    await audio.play();
    audio.pause();audio.currentTime=0;audio.muted=false;
    return true;
  }catch{
    try{audio.muted=false}catch{}
    return false;
  }
}
async function playMediaAlertSound(){
  const audio=getAlertAudio();
  if(!audio)return false;
  try{
    audio.muted=false;audio.currentTime=0;
    await audio.play();
    return true;
  }catch{return false}
}
function playSilentUnlock(ctx){
  try{
    const source=ctx.createBufferSource();
    source.buffer=ctx.createBuffer(1,1,22050);
    source.connect(ctx.destination);
    source.start(0);
  }catch{}
}
async function ensureAudioReady(unlock=false){
  const ctx=getAudioContext();
  if(!ctx)return null;
  try{
    if(unlock)playSilentUnlock(ctx);
    if(ctx.state==="suspended")await ctx.resume();
    if(unlock&&ctx.state==="running")playSilentUnlock(ctx);
  }catch{}
  return ctx;
}
async function unlockAudio(){
  const wasRunning=audioCtx?.state==="running";
  const mediaPromise=unlockMediaAudio();
  const contextPromise=ensureAudioReady(true);
  const [mediaReady,ctx]=await Promise.all([mediaPromise,contextPromise]);
  if(!wasRunning&&ctx?.state==="running"&&alertActive)void playAlertSound();
  return mediaReady||ctx?.state==="running";
}
function alertEnabled(){return localStorage.getItem(ALERT_KEY)==="1"}
function setAlertEnabled(on){
  localStorage.setItem(ALERT_KEY,on?"1":"0");
  syncAlertToggle();
}
function syncAlertToggle(){
  const b=document.getElementById("alertToggle");
  if(!b)return;
  const on=alertEnabled();
  b.classList.toggle("on",on);
  b.setAttribute("aria-checked",on?"true":"false");
}
function syncStopButton(){
  const b=document.getElementById("stopAlertBtn");
  if(b)b.hidden=!alertActive;
}
async function requestNotificationPermission(){
  try{
    if("Notification" in window&&Notification.permission==="default"){
      await Notification.requestPermission();
    }
  }catch{}
}
async function toggleAlerts(){
  const next=!alertEnabled();
  if(!next){setAlertEnabled(false);stopAlertSound();return}
  await unlockAudio();
  await requestNotificationPermission();
  setAlertEnabled(true);
}
async function playAlertSound(){
  if(!alertEnabled())return;
  if(await playMediaAlertSound())return;
  try{
    const ctx=await ensureAudioReady();
    if(!ctx||ctx.state!=="running")return;
    const now=ctx.currentTime;
    [0,.22,.44].forEach((offset,i)=>{
      const osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.connect(gain);gain.connect(ctx.destination);
      osc.type="sine";osc.frequency.value=i===2?1046:880;
      gain.gain.setValueAtTime(.0001,now+offset);
      gain.gain.exponentialRampToValueAtTime(.24,now+offset+.015);
      gain.gain.exponentialRampToValueAtTime(.0001,now+offset+.16);
      osc.start(now+offset);osc.stop(now+offset+.18);
    });
  }catch{}
}
function startAlertSound(){
  if(!alertEnabled())return;
  stopAlertSound();
  alertActive=true;syncStopButton();
  void playAlertSound();
  alertLoopTimer=setInterval(()=>void playAlertSound(),6500);
}
function stopAlertSound(){
  if(alertLoopTimer!==null){clearInterval(alertLoopTimer);alertLoopTimer=null}
  if(alertAudio){try{alertAudio.pause();alertAudio.currentTime=0}catch{}}
  alertActive=false;syncStopButton();
}
async function showSystemNotification(title,options){
  if(!alertEnabled())return;
  try{
    const opts={...options,requireInteraction:true,silent:false};
    if("serviceWorker" in navigator){
      const reg=await navigator.serviceWorker.ready;
      if(reg&&reg.showNotification){await reg.showNotification(title,opts);return}
    }
    if("Notification" in window&&Notification.permission==="granted")new Notification(title,opts);
  }catch{}
}
function sendPotAlert(g){
  if(!alertEnabled())return false;
  const text=tableLabel(g)+"の鍋温めから5分30秒経過しました";
  startAlertSound();
  if("Notification" in window&&Notification.permission==="granted"){
    showSystemNotification("鍋温めアラート",{body:text,tag:"pot-"+g.id,renotify:true});
  }
  return true;
}
async function checkForegroundAudio(){
  if(document.visibilityState==="hidden"||!alertEnabled())return;
  await ensureAudioReady();
}
function checkPotAlerts(){
  let changed=false;
  for(const g of state.groups){
    if(g.pot_warm_at&&!g.pot_finish_at&&!g.checkout_at&&(Date.now()-new Date(g.pot_warm_at).getTime()>=330000)&&g.pot_warm_alerted_at!==g.pot_warm_at){
      if(sendPotAlert(g)){g.pot_warm_alerted_at=g.pot_warm_at;changed=true}
    }
  }
  if(changed)save();
}

function ago(ms){return new Date(Date.now()-ms).toISOString()}
function openTestTools(){document.getElementById("testToolsDialog").showModal()}
function testNineWarnings(){
  state=freshState();
  state.groups[0].starter_at=ago(10*60*1000);
  state.groups[1].pot_finish_at=ago(10*60*1000);
  state.groups[2].sansho_at=ago(10*60*1000);
  state.groups[3].soup_at=ago(10*60*1000);
  state.groups[4].closing_finish_at=ago(10*60*1000);
  save();render();document.getElementById("testToolsDialog").close();
}
function testArrivalWarning(){
  state=freshState();state.groups[5].arrival_at=ago(106*60*1000);save();render();document.getElementById("testToolsDialog").close();
}
async function testPotAlert(){
  if(!alertEnabled())setAlertEnabled(true);
  await unlockAudio();
  await requestNotificationPermission();
  state=freshState();state.groups[2].pot_warm_at=ago(6*60*1000);state.groups[2].pot_warm_alerted_at=null;save();document.getElementById("testToolsDialog").close();checkPotAlerts();render();
}
function testReset(){state=freshState();save();render();document.getElementById("testToolsDialog").close()}

document.getElementById("historyBtn").onclick=()=>{renderHistory();document.getElementById("historyDialog").showModal()};
document.getElementById("moveBtn").onclick=openMoveDialog;
document.getElementById("linkBtn").onclick=openLinkDialog;
document.getElementById("resetBtn").onclick=resetToday;
document.getElementById("versionBtn").onclick=()=>document.getElementById("versionDialog").showModal();
document.getElementById("confirmLinkBtn").onclick=confirmLink;
document.getElementById("confirmMoveBtn").onclick=confirmMove;
document.getElementById("alertToggle").onclick=toggleAlerts;
document.getElementById("stopAlertBtn").onclick=stopAlertSound;
document.getElementById("testAlertBtn").onclick=testPotAlert;
document.getElementById("testToolsBtn").onclick=openTestTools;
document.getElementById("testNineBtn").onclick=testNineWarnings;
document.getElementById("testArrivalBtn").onclick=testArrivalWarning;
document.getElementById("testPotBtn").onclick=testPotAlert;
document.getElementById("testResetBtn").onclick=testReset;
document.querySelectorAll("[data-close]").forEach(b=>b.onclick=()=>document.getElementById(b.dataset.close).close());
document.addEventListener("pointerdown",()=>{if(alertEnabled())void unlockAudio()},{capture:true,passive:true});
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")void checkForegroundAudio()});
window.addEventListener("pageshow",()=>void checkForegroundAudio());

setInterval(()=>{
  const today=JST_DATE();
  if(today!==state.date){state=freshState();save()}
  checkPotAlerts();
  render();
},1000);

if("serviceWorker" in navigator){
  window.addEventListener("load",async()=>{
    try{
      const reg=await navigator.serviceWorker.register("./sw.js",{updateViaCache:"none"});
      await reg.update();
      let reloading=false;
      navigator.serviceWorker.addEventListener("controllerchange",()=>{
        if(reloading)return;
        reloading=true;
        location.reload();
      });
    }catch(err){
      console.warn("Service Worker update failed:",err);
    }
  });
}
(function initReservationPicker(){
  const hs=document.getElementById("reservationHour");
  const ms=document.getElementById("reservationMinute");
  for(let h=0;h<24;h++){const o=document.createElement("option");o.value=String(h).padStart(2,"0");o.textContent=o.value;hs.appendChild(o)}
  for(let m=0;m<60;m+=5){const o=document.createElement("option");o.value=String(m).padStart(2,"0");o.textContent=o.value;ms.appendChild(o)}
  document.getElementById("reservationSaveBtn").onclick=saveReservation;
  document.getElementById("reservationClearBtn").onclick=clearReservation;
})();

syncAlertToggle();
syncStopButton();
checkPotAlerts();
render();
})();
